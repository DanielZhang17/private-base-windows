import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClearHistoryPage, DecryptedMessage } from "@e2ee-chat/shared";
import { deleteOutgoing, getAppDB, getMessageById, getMessageDeletion, getOutgoing, saveMessage, saveOutgoing, type LocalOutgoing } from "../../db/index.js";
import { api, ApiError } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { ToastProvider } from "../../ui/index.js";
import { setupDom } from "../../ui/test-utils.js";
import { useClearHistory } from "./useClearHistory.js";

const dom = setupDom();
const started = vi.fn();
let result: ReturnType<typeof useClearHistory>;
const path = "/api/conversations/chat/clear-messages";
const first: DecryptedMessage = { id: "first", conversationId: "chat", ownerId: "alice", senderId: "bob",
  type: "text", content: "Old history", timestamp: Date.now() - 500, expiresAt: Date.now() + 60_000, expiryKind: "retention", status: "sent" };
const own = { ...first, id: "mine", senderId: "alice" };
const newer = { ...first, id: "new", timestamp: first.timestamp + 1000, content: "New history" };
const outgoing: LocalOutgoing = { id: "draft", userId: "alice", deviceId: "device", conversationId: "chat", conversationType: "direct",
  queuedAt: first.timestamp, status: "failed", retryable: false, nextAttemptAt: null, error: null, attempts: 1, ttlSeconds: null, steps: [] };

function Probe({ conversationId = "chat", direct }: { conversationId?: string; direct: boolean }) {
  const messages = useChatStore((state) => state.messages);
  result = useClearHistory(conversationId, direct, messages.get(conversationId) ?? [], started);
  return null;
}
const render = (id?: string, direct = true) => dom.render(<ToastProvider><Probe conversationId={id} direct={direct} /></ToastProvider>);
async function seed(...rows: DecryptedMessage[]) {
  for (const row of rows) await saveMessage(row);
  useChatStore.getState().setMessages("chat", rows);
}

beforeEach(async () => {
  started.mockClear();
  useAuthStore.setState({ user: { id: "alice" } as never, device: { id: "device" } as never, sessionId: "clear-history" });
  useChatStore.setState({ messages: new Map(), clearingHistory: new Map() });
  const db = await getAppDB();
  await Promise.all([db.clear("displayMessages"), db.clear("legacyMessages"), db.clear("accountState")]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, device: null, sessionId: null });
});

it("optimistically hides the visible snapshot, retires drafts and applies the real actor across pages", async () => {
  await seed(first, own);
  await saveOutgoing(outgoing); // An outbox-only item must also be retired.
  await saveOutgoing({ ...outgoing, id: "other-draft", conversationId: "other" });
  await saveOutgoing({ ...outgoing, id: own.id, sendDispatched: true,
    steps: [{ path: "/api/messages/send", body: { id: own.id, conversationId: "chat", type: "text", ciphertext: "opaque", iv: "iv", header: "{}" } }],
  });
  let continueClear!: (page: ClearHistoryPage) => void;
  const deletedAt = Date.now();
  const post = vi.spyOn(api, "post").mockResolvedValueOnce({ nextCursor: "one", deletions: [] })
    .mockReturnValueOnce(new Promise((resolve) => { continueClear = resolve; }))
    .mockResolvedValueOnce({ nextCursor: null, deletions: [
      { senderId: "alice", event: { ids: [own.id], deletedByUserId: "alice", deletedAt } },
    ] });
  await render();
  await act(async () => result.request("everyone"));
  let done!: Promise<void>;
  await act(async () => { done = result.confirm(); });
  expect(result.busy).toBe(true);
  expect(result.suppressed).toEqual(new Set([first.id, own.id]));
  expect(started).toHaveBeenCalledOnce();
  await act(async () => { useChatStore.getState().addMessage("chat", newer); });
  expect(result.suppressed?.has(newer.id)).toBe(false);

  await act(async () => {
    continueClear({ nextCursor: "two", deletions: [{ senderId: "bob", event: { ids: [first.id], deletedByUserId: "alice", deletedAt } }] });
    await done;
  });
  expect(post.mock.calls).toEqual([[path, {}], [path, { cursor: "one" }], [path, { cursor: "two" }]]);
  expect(result.action).toBeUndefined();
  expect(result.suppressed).toBeUndefined();
  expect(await getOutgoing(outgoing.id, "alice")).toBeUndefined();
  expect(await getOutgoing(own.id, "alice")).toBeUndefined();
  expect(await getOutgoing("other-draft", "alice")).toBeDefined();
  expect(await getMessageDeletion(first.id, "alice")).toMatchObject({ senderId: "bob", deletedByUserId: "alice" });
  expect(useChatStore.getState().messages.get("chat")).toMatchObject([
    { id: first.id, content: "", deletedAt }, { id: own.id, content: "", deletedAt }, { id: newer.id, content: "New history" },
  ]);
});

it.each([false, true])("warns about a completed dispatched send only if it survived the clear (cleared=%s)", async (cleared) => {
  const sent = { ...own, id: outgoing.id, status: "sent" } as const;
  await seed({ ...sent, status: "sending" });
  await saveOutgoing({ ...outgoing, sendDispatched: true,
    steps: [{ path: "/api/messages/send", body: { id: outgoing.id, conversationId: "chat", type: "text", ciphertext: "opaque", iv: "iv", header: "{}" } }] });
  const deletedAt = Date.now();
  const post = vi.spyOn(api, "post").mockResolvedValueOnce({ nextCursor: "snapshot", deletions: [] })
    .mockImplementationOnce(async () => {
      await deleteOutgoing(outgoing.id, "alice");
      await saveMessage(sent);
      const deletions = cleared ? [{ senderId: "alice", event: { ids: [outgoing.id], deletedAt, deletedByUserId: "alice" } }] : [];
      return { nextCursor: null, deletions };
    });
  await render();
  await act(async () => result.request("everyone"));
  await act(async () => result.confirm());
  expect(post).toHaveBeenCalledTimes(2);
  expect(result.action).toBeUndefined();
  expect(await getOutgoing(outgoing.id, "alice")).toBeUndefined();
  const warned = document.body.textContent?.includes("Some messages are already sending");
  expect(warned).toBe(!cleared);
  expect(await getMessageById(outgoing.id, "alice")).toMatchObject(cleared ? { deletedAt, content: "" } : { status: "sent", content: sent.content });
});

it("restores unconfirmed rows on error and retries the same cursor", async () => {
  await seed(first);
  const post = vi.spyOn(api, "post").mockResolvedValueOnce({ nextCursor: "one", deletions: [] })
    .mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({ nextCursor: null, deletions: [] });
  await render();
  await act(async () => result.request("everyone"));
  await act(async () => result.confirm());
  expect(result.failed).toBe(true);
  expect(result.suppressed).toBeUndefined();
  expect(useChatStore.getState().messages.get("chat")?.[0].content).toBe(first.content);
  await act(async () => result.confirm());
  expect(result.action).toBeUndefined();
  expect(post.mock.calls).toEqual([[path, {}], [path, { cursor: "one" }], [path, { cursor: "one" }]]);
});

it("locally hides older unloaded rows using persistent hide barriers and preserves other accounts", async () => {
  await seed(first);
  await saveMessage({ ...own, timestamp: first.timestamp - 1000 });
  await saveMessage({ ...own, ownerId: "carol" });
  await saveOutgoing(outgoing);
  const post = vi.spyOn(api, "post");
  await render();
  await act(async () => result.request("local"));
  await act(async () => result.confirm());
  expect(result.action).toBeUndefined();
  expect(post).not.toHaveBeenCalled();
  expect(await getMessageById(first.id, "alice")).toBeUndefined();
  expect(await getMessageById(own.id, "alice")).toBeUndefined();
  expect(await getMessageById(own.id, "carol")).toMatchObject({ content: own.content });
  expect(await getOutgoing(outgoing.id, "alice")).toBeUndefined();
  await saveMessage(own);
  expect(await getMessageById(own.id, "alice")).toBeUndefined();
});

it("clears a memory-only failed bubble and keeps a visible send with an unknown dispatch outcome", async () => {
  const failed = { ...own, id: "failed-before-idb", status: "failed" as const };
  const inFlight = { ...own, id: "dispatch-without-message-row", status: "sending" as const };
  useChatStore.getState().setMessages("chat", [failed, inFlight]);
  await saveOutgoing({ ...outgoing, id: inFlight.id, sendDispatched: true,
    steps: [{ path: "/api/messages/send", body: { id: inFlight.id, conversationId: "chat", type: "text", ciphertext: "opaque", iv: "iv", header: "{}" } }],
  });
  await render();
  await act(async () => result.request("local"));
  await act(async () => result.confirm());
  expect(result.action).toBeUndefined();
  expect(useChatStore.getState().messages.get("chat")).toEqual([inFlight]);
  expect(await getOutgoing(inFlight.id, "alice")).toBeDefined();
  await saveMessage(failed);
  expect(await getMessageById(failed.id, "alice")).toBeUndefined();
});

it.each(["direct", "group"] as const)("keeps quarantined %s history hidden for the clearing account after ownership verification", async (type) => {
  const direct = type === "direct";
  const db = await getAppDB();
  const legacy = { ...first, id: "legacy:device", ownerId: undefined };
  await db.put("legacyMessages", legacy);
  await render(undefined, direct);
  await act(async () => result.request("local"));
  await act(async () => result.confirm());
  expect(result.action).toBeUndefined();

  const { verifyLegacyHistoryOwnership } = await import("../../db/history-transfer.js");
  const conversation = [{ id: "chat", type }];
  const verify = async () => [legacy.id];
  await verifyLegacyHistoryOwnership("alice", conversation, verify, () => true);
  expect(await getMessageById(legacy.id, "alice", direct)).toBeUndefined();
  expect(await db.get("legacyMessages", legacy.id)).toEqual(legacy);
  await verifyLegacyHistoryOwnership("carol", conversation, verify, () => true);
  expect(await getMessageById(legacy.id, "carol", direct)).toMatchObject({ id: direct ? "legacy" : legacy.id, content: first.content });
});

it("keeps an existing draft if the server rejects clear permission", async () => {
  await saveOutgoing(outgoing);
  vi.spyOn(api, "post").mockRejectedValueOnce(new Error("Forbidden"));
  await render();
  await act(async () => result.request("everyone"));
  await act(async () => result.confirm());
  expect(result.failed).toBe(true);
  expect(await getOutgoing(outgoing.id, "alice")).toBeDefined();
});

it("keeps drafts queued after confirmation while the start request is pending", async () => {
  await saveOutgoing(outgoing);
  let authorize!: (page: ClearHistoryPage) => void;
  const authorized = new Promise<ClearHistoryPage>((resolve) => { authorize = resolve; });
  let recordStart!: () => void;
  const startedRequest = new Promise<void>((resolve) => { recordStart = resolve; });
  vi.spyOn(api, "post").mockImplementationOnce(async () => { recordStart(); return authorized; })
    .mockResolvedValueOnce({ nextCursor: null, deletions: [] });
  await render();
  await act(async () => result.request("everyone"));
  let done!: Promise<void>;
  await act(async () => { done = result.confirm(); await startedRequest; });
  const lateFile = { ...outgoing, id: "late-file", queuedAt: outgoing.queuedAt + 1,
    upload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" } };
  await saveOutgoing(lateFile);
  await act(async () => { authorize({ nextCursor: "first", deletions: [] }); await done; });
  expect(await getOutgoing(outgoing.id, "alice")).toBeUndefined();
  const saved = await getOutgoing(lateFile.id, "alice");
  expect(saved?.upload?.mimeType).toBe("image/png");
  expect(Array.from(saved?.upload?.bytes ?? [])).toEqual([1, 2, 3]);
});

it("waits for the rate limit and automatically resumes at the same page", async () => {
  await render();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let recordLimit!: () => void;
  const limited = new Promise<void>((resolve) => { recordLimit = resolve; });
  const post = vi.spyOn(api, "post").mockResolvedValueOnce({ nextCursor: "one", deletions: [] })
    .mockResolvedValueOnce({ nextCursor: "two", deletions: [] })
    .mockImplementationOnce(async () => {
      recordLimit(); throw new ApiError("Rate limit", 429, undefined, { retryAfterSeconds: 2 });
    })
    .mockResolvedValueOnce({ nextCursor: null, deletions: [] });
  await act(async () => result.request("everyone"));
  let done!: Promise<void>;
  await act(async () => { done = result.confirm(); await limited; });
  expect(result.busy).toBe(true);
  expect(result.failed).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
  expect(post).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); await done; });
  expect(post.mock.calls).toEqual([[path, {}], [path, { cursor: "one" }], [path, { cursor: "two" }], [path, { cursor: "two" }]]);
  expect(result.action).toBeUndefined();
});
