import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DecryptedMessage } from "@e2ee-chat/shared";
import { advanceMutationCursor, completeOutgoingIfPresent, getAppDB, getMessageDeletion, getOutgoing, getSyncState, messageHideKey, receiveKey, rememberMessageDeletion, saveMessage, saveOutgoing } from "../../db/index.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { api, ApiError } from "../../services/api.js";
import { ToastProvider } from "../../ui/index.js";
import { setupDom } from "../../ui/test-utils.js";
import { useMessageSelection } from "./useMessageSelection.js";
import { handleBatchMessageDeletion, handleMessageDeletion } from "../../lib/message-sync.js";

const dom = setupDom();
let result: ReturnType<typeof useMessageSelection>;
const first: DecryptedMessage = { id: "first", conversationId: "chat", senderId: "alice", type: "text", content: "Mine",
  timestamp: Date.now(), status: "sent", expiresAt: Date.now() + 600_000, expiryKind: "timed" };
const peer = { ...first, id: "peer", senderId: "bob", content: "Theirs" };
const outgoingIds = new Set<string>();

function Probe({ messages, conversationId }: { messages: DecryptedMessage[]; conversationId: string }) {
  result = useMessageSelection({ conversationId, userId: "alice", accepted: true, messages, outgoingIds, senderName: (id) => id });
  return null;
}
const render = (messages = [first, peer], conversationId = "chat") => dom.render(<ToastProvider><Probe {...{ messages, conversationId }} /></ToastProvider>);
const toggle = (message: DecryptedMessage) => act(async () => result.toggle(message));

beforeEach(async () => {
  outgoingIds.clear();
  useChatStore.setState({ messages: new Map() });
  useAuthStore.setState({ user: { id: "alice" } as never, device: { id: "device" } as never, sessionId: "selection-test" });
  const db = await getAppDB();
  await Promise.all([db.clear("accountState"), db.clear("displayMessages"), db.clear("legacyMessages")]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, device: null, sessionId: null });
});

it("prunes remote edits and deletes, invalidates an open confirmation, and clears on navigation", async () => {
  await render();
  await toggle(first);
  await toggle(peer);
  await act(async () => result.requestDelete("local"));
  expect(result.confirmation).toBe("local");
  const edited = { ...first, editSequence: 1, content: "Edited" };
  const deleted = { ...peer, deletedAt: 102 };
  await render([edited, peer]);
  expect([...result.ids.keys()]).toEqual([peer.id]);
  expect(result.confirmation).toBeUndefined();
  await render([edited, deleted]);
  expect(result.active).toBe(false);
  await toggle(deleted);
  expect(result.active).toBe(true);
  await render([edited, deleted], "other");
  await render([edited, deleted]);
  expect(result.active).toBe(false);
});

it("uses only account-local hide barriers for mixed ownership and clears the selection", async () => {
  const post = vi.spyOn(api, "post");
  await saveMessage(first, undefined, "alice");
  await saveMessage(peer, undefined, "alice");
  await saveMessage(peer, undefined, "carol");
  await render();
  await toggle(first);
  await toggle(peer);
  expect(result.unavailable).toBe("messageSelectionOwnOnly");
  await act(async () => result.requestDelete("everyone"));
  await act(async () => { await result.confirmDelete(); });
  expect(post).not.toHaveBeenCalled();
  await act(async () => result.requestDelete("local"));
  await act(async () => { await result.confirmDelete(); });
  expect(result.active).toBe(false);
  const db = await getAppDB();
  for (const id of [first.id, peer.id]) {
    expect(await db.get("displayMessages", ["alice", id])).toBeUndefined();
    expect(await db.get("accountState", messageHideKey(id, "alice"))).toMatchObject({ messageId: id, ownerId: "alice" });
  }
  expect(await db.get("displayMessages", ["carol", peer.id])).toMatchObject({ content: "Theirs" });
  expect(post).not.toHaveBeenCalled();
});

it.each([[undefined, "edit-one"], ["edit-one", undefined], ["edit-one", "edit-two"]])(
  "invalidates the confirmation when the pending edit changes from %s to %s", async (before, after) => {
    const prev = { ...first, pendingEdit: before ? { id: before, content: "Pending text" } : null };
    await render([prev, peer]);
    await toggle(prev);
    await toggle(peer);
    await act(async () => result.requestDelete("local"));
    expect(result.confirmation).toBe("local");
    await render([{ ...first, pendingEdit: after ? { id: after, content: "Pending text" } : null }, peer]);
    expect([...result.ids.keys()]).toEqual([peer.id]);
    expect(result.confirmation).toBeUndefined();
  },
);

it("applies an original admin deletion receipt to the sender's cached message", async () => {
  const deletedAt = Date.now();
  const post = vi.spyOn(api, "post").mockResolvedValue({ deletions: [{ ids: [first.id], deletedAt, deletedByUserId: "admin" }] });
  await saveMessage(first, undefined, "alice");
  await render([first]);
  await toggle(first);
  await act(async () => result.requestDelete("everyone"));
  await act(async () => { await result.confirmDelete(); });
  expect(post).toHaveBeenCalledOnce();
  expect(await getMessageDeletion(first.id, "alice")).toMatchObject({ senderId: "alice", deletedAt, deletedByUserId: "admin" });
  expect(await (await getAppDB()).get("displayMessages", ["alice", first.id])).toMatchObject({ content: "", deletedAt, deletedByUserId: "admin" });
});

it("allows deletion for everyone on a failed receive from another device on the same account", async () => {
  const failedReceive = { ...first, content: "", status: "failed" as const };
  const failedSend = { ...failedReceive, id: "failed-send" };
  const post = vi.spyOn(api, "post").mockResolvedValue({ deletions: [] });
  outgoingIds.add(failedSend.id);
  await render([failedReceive, failedSend]);
  await toggle(failedReceive);
  expect(result.queuedCount).toBe(0);
  expect(result.unavailable).toBeUndefined();
  await toggle(failedSend);
  expect(result.queuedCount).toBe(1);
  expect(result.unavailable).toBe("messageSelectionUnsent");
  await toggle(failedSend);
  await act(async () => result.requestDelete("everyone"));
  await act(async () => { await result.confirmDelete(); });
  expect(post).toHaveBeenCalledExactlyOnceWith("/api/messages/delete-batch", { conversationId: "chat", ids: [first.id], fileIds: {} });
});

it("applies replayed IDs even when the cached mutation cursor has passed the deletion", async () => {
  const cursor = "message-mutations:alice:device";
  await advanceMutationCursor(cursor, 123);
  await saveMessage(peer, undefined, "alice");
  const request = vi.spyOn(api, "get");
  await handleMessageDeletion({ conversationId: "chat", deletionSync: true, replayedDeletions: {
    senderId: "bob", deletions: [{ ids: [peer.id], deletedAt: Date.now(), deletedByUserId: "admin" }],
  } });
  expect(useChatStore.getState().messages.get("chat")).toMatchObject([{ id: peer.id, content: "", deletedByUserId: "admin" }]);
  expect(await getSyncState(cursor)).toMatchObject({ value: 123 });
  expect(request).not.toHaveBeenCalled();
});

it.each(["direct", "group"] as const)("uses the notification's %s type to redact a cold cache", async (conversationType) => {
  const db = await getAppDB();
  const conversationId = `cold-${conversationType}`;
  const quarantined = { ...peer, id: "root:device", conversationId };
  const foreign = { ...quarantined, id: "root:other", conversationId: "other" };
  await db.put("legacyMessages", quarantined);
  await db.put("legacyMessages", foreign);
  const pending = receiveKey("pending-receive:", quarantined.id, "alice", "device");
  await db.put("accountState", { id: pending, frame: { id: quarantined.id, conversationId, senderId: "bob" } });
  const request = vi.spyOn(api, "get");
  const deletion = { ids: ["root"], deletedAt: Date.now(), deletedByUserId: "bob" };
  await handleMessageDeletion({ conversationId, conversationType, deletion });
  if (conversationType === "direct") {
    expect(await db.get("legacyMessages", quarantined.id)).toMatchObject({ content: "", deletedAt: deletion.deletedAt });
    expect(await db.get("accountState", pending)).toBeUndefined();
  } else {
    expect(await db.get("legacyMessages", quarantined.id)).toEqual(quarantined);
    expect(await db.get("accountState", pending)).toBeDefined();
  }
  expect(await db.get("legacyMessages", foreign.id)).toEqual(foreign);
  expect(request).not.toHaveBeenCalled();
});

it("keeps a colon-bearing group wire ID exact when an older notification omits the conversation type", async () => {
  const conversationId = "legacy-group";
  const root = { ...peer, id: "note", conversationId };
  const exact = { ...root, id: "note:old" };
  await saveMessage({ ...root, direct: false }, undefined, "alice");
  await saveMessage({ ...exact, direct: false }, undefined, "alice");
  const deletedAt = Date.now();
  await handleMessageDeletion({ conversationId, deletion: { ids: [exact.id], deletedAt, deletedByUserId: "bob" } });
  const db = await getAppDB();
  expect(await db.get("displayMessages", ["alice", exact.id])).toMatchObject({ content: "", deletedAt });
  expect(await db.get("displayMessages", ["alice", root.id])).toMatchObject({ content: root.content });
});

it.each(["direct", "group"] as const)("writes the exact rollback receipt before resolving %s quarantine cleanup", async (type) => {
  const conversationId = `rollback-${type}`;
  const db = await getAppDB();
  const cachedFile = `rollback-file-${type}`;
  const legacy = { ...peer, conversationId, id: "legacy-note", type: "file",
    content: JSON.stringify({ fileId: cachedFile, fileKey: "legacy-key" }) };
  await db.put("legacyMessages", legacy);
  await db.put("accountFiles", { id: cachedFile, blob: new Blob(["decrypted file"]) });
  let resolve!: (conversation: unknown) => void;
  const metadata = vi.spyOn(api, "get").mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const wireId = `${legacy.id}:device`;
  const deletedAt = Date.now();
  const deletion = handleMessageDeletion({ conversationId, deletion: { ids: [wireId], deletedAt, deletedByUserId: "bob" } });
  await vi.waitFor(() => expect(metadata).toHaveBeenCalledWith(`/api/conversations/${conversationId}`));
  expect(await getMessageDeletion(wireId, "alice")).toMatchObject({ deletedAt });
  expect(await db.get("legacyMessages", legacy.id)).toMatchObject({ content: legacy.content });
  resolve({ id: conversationId, type, members: [] });
  await deletion;
  if (type === "direct") {
    expect(await db.get("legacyMessages", legacy.id)).toMatchObject({ content: "", deletedAt });
    expect(await db.get("accountFiles", cachedFile)).toBeUndefined();
  } else {
    expect(await db.get("legacyMessages", legacy.id)).toEqual(legacy);
    expect(await db.get("accountFiles", cachedFile)).toBeDefined();
  }
});

it("keeps unrelated deferred receives with the same direct family prefix", async () => {
  const db = await getAppDB();
  const rows = [["note:matching", "direct-chat", "bob"], ["note:other-chat", "group-chat", "bob"],
    ["note:other-sender", "direct-chat", "carol"]];
  for (const [id, conversationId, senderId] of rows) {
    await db.put("accountState", { id: receiveKey("pending-receive:", id, "alice", "device"), frame: { id, conversationId, senderId } });
  }
  await handleMessageDeletion({ conversationId: "direct-chat", conversationType: "direct",
    deletion: { ids: ["note", "note:other-sender"], deletedAt: Date.now(), deletedByUserId: "bob" } });
  expect(await db.get("accountState", receiveKey("pending-receive:", rows[0][0], "alice", "device"))).toBeUndefined();
  for (const [id, conversationId, senderId] of rows.slice(1)) {
    expect(await db.get("accountState", receiveKey("pending-receive:", id, "alice", "device"))).toMatchObject({ frame: { id, conversationId, senderId } });
  }
});

it.each([false, true])("uses the binary-first rootless receipt even if the compact socket frame arrives first=%s", async (socketFirst) => {
  const conversationId = "rootless-receipt";
  await saveMessage({ ...peer, id: "note", conversationId, direct: true }, undefined, "alice");
  const deletedAt = Date.now();
  const first = { ids: ["note:Z"], deletedAt, deletedByUserId: "admin" };
  const other = { ids: ["note:a"], deletedAt: deletedAt + 100, deletedByUserId: "bob" };
  const http = () => handleBatchMessageDeletion(conversationId, [other, first], "bob", "direct");
  const socket = () => handleMessageDeletion({ conversationId, conversationType: "direct", replayedDeletions: {
    senderId: "bob", deletions: [{ ...first, ids: ["note"] }],
  } });
  const events = socketFirst ? [socket, http] : [http, socket];
  for (const event of events) {
    await event();
    expect(await getMessageDeletion("note", "alice")).toMatchObject({ deletedAt, deletedByUserId: "admin" });
  }
});

it("applies a group batch receipt to an exact colon-bearing ID without cached conversation metadata", async () => {
  const conversationId = "cold-group-receipt";
  const root = { ...first, conversationId, id: "note" };
  const selected = { ...root, id: "note:old" };
  await saveMessage({ ...root, direct: false }, undefined, "alice");
  await saveMessage({ ...selected, direct: false }, undefined, "alice");
  const deletion = { ids: [selected.id], deletedAt: Date.now(), deletedByUserId: "alice" };
  vi.spyOn(api, "post").mockResolvedValue({ conversationType: "group", deletions: [deletion] });
  await render([root, selected], conversationId);
  await toggle(selected);
  await act(async () => result.requestDelete("everyone"));
  await act(async () => { await result.confirmDelete(); });
  const db = await getAppDB();
  expect(await db.get("displayMessages", ["alice", selected.id])).toMatchObject({ content: "", deletedAt: deletion.deletedAt });
  expect(await db.get("displayMessages", ["alice", root.id])).toMatchObject({ content: root.content });
});

it.each([true, false])("clears stale in-memory plaintext when another tab already committed the tombstone (display row=%s)", async (keepRow) => {
  const stale = { ...peer, ownerId: "alice" };
  await saveMessage(stale);
  useChatStore.getState().addMessage("chat", stale);
  const deletedAt = Date.now();
  await rememberMessageDeletion(peer.id, "chat", deletedAt, "bob", "bob", undefined, "alice");
  if (!keepRow) await (await getAppDB()).delete("displayMessages", ["alice", peer.id]);
  expect(useChatStore.getState().messages.get("chat")).toEqual([stale]);

  const put = vi.spyOn(IDBObjectStore.prototype, "put");
  const updates = vi.fn();
  const stop = useChatStore.subscribe(updates);
  const payload = { conversationId: "chat", deletion: { ids: [peer.id], deletedAt, deletedByUserId: "bob" } };
  try {
    await handleMessageDeletion(payload);
    await handleBatchMessageDeletion("chat", [payload.deletion], "bob");
    expect(useChatStore.getState().messages.get("chat")).toEqual(keepRow
      ? [expect.objectContaining({ id: peer.id, content: "", deletedAt, deletedByUserId: "bob" })] : []);
    expect(updates).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  } finally { stop(); }
});

it("commits 1,900 envelopes with one display update per logical message across duplicate deliveries", async () => {
  const ids = Array.from({ length: 100 }, (_, index) => `logical-${index}`);
  const db = await getAppDB();
  const seed = db.transaction(["displayMessages", "accountState"], "readwrite");
  for (const id of ids) await seed.objectStore("displayMessages").put({ ...first, id, ownerId: "alice", direct: true });
  const envelopeIds = ids.flatMap((id) => [id, ...Array.from({ length: 18 }, (_, i) => `${id}:device-${i}`)]);
  const pendingKey = receiveKey("pending-receive:", `${ids[0]}:device-5`, "alice", "device");
  const foreignKey = receiveKey("pending-receive:", `${ids[0]}:device-5`, "carol", "device");
  await seed.objectStore("accountState").put({ id: pendingKey, frame: { id: `${ids[0]}:device-5`, conversationId: "chat", senderId: "alice" } });
  await seed.objectStore("accountState").put({ id: foreignKey });
  await seed.done;
  const updates = vi.fn();
  const stop = useChatStore.subscribe(updates);
  const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
  const deletion = { ids: envelopeIds, deletedAt: Date.now(), deletedByUserId: "alice" };
  const payload = { conversationId: "chat", deletion };
  try {
    await Promise.all([handleMessageDeletion(payload), handleMessageDeletion(payload), handleBatchMessageDeletion("chat", [deletion], "alice")]);
    const writes = transaction.mock.calls.filter(([stores, mode]) => mode === "readwrite" && Array.isArray(stores) && stores.includes("legacyMessages"));
    expect(writes).toHaveLength(3);
    expect(updates).toHaveBeenCalledTimes(100);
    expect(useChatStore.getState().messages.get("chat")).toHaveLength(100);
    expect(await db.get("accountState", pendingKey)).toBeUndefined();
    expect(await db.get("accountState", foreignKey)).toBeDefined();
    expect((await db.getAll("displayMessages")).every((row) => row.deletedAt === deletion.deletedAt && row.content === "")).toBe(true);
  } finally { stop(); }
});

it("reports already-sending selections without hiding their rows", async () => {
  await saveMessage(first, undefined, "alice");
  await saveOutgoing({ id: first.id, userId: "alice", deviceId: "device", conversationId: "chat", conversationType: "group", queuedAt: 1,
    ttlSeconds: null, status: "sending", attempts: 1, retryable: true, nextAttemptAt: null, error: null, sendDispatched: true,
    steps: [{ path: "/api/messages/send", sendDispatched: true, body: { id: first.id, conversationId: "chat", type: "text", ciphertext: "opaque", iv: "iv", header: "{}" } }] });
  await render([first]);
  await toggle(first);
  await act(async () => result.requestDelete("local"));
  await act(async () => { await result.confirmDelete(); });
  expect(result.skippedCount).toBe(1);
  expect(result.ids.has(first.id)).toBe(true);
  expect(await (await getAppDB()).get("displayMessages", ["alice", first.id])).toMatchObject({ content: first.content });
});

it.each([false, true])("warns when a confirmed discard lost to send completion (view updated=%s)", async (updated) => {
  const sending = { ...first, status: "sending" as const };
  await saveMessage(sending, undefined, "alice");
  await saveMessage(peer, undefined, "alice");
  await saveOutgoing({ id: first.id, userId: "alice", deviceId: "device", conversationId: "chat", conversationType: "group", queuedAt: 1,
    ttlSeconds: null, status: "sending", attempts: 0, retryable: true, nextAttemptAt: null, error: null, steps: [] });
  outgoingIds.add(first.id);
  await render([sending, peer]);
  await toggle(sending);
  await toggle(peer);
  await act(async () => result.requestDelete("local"));
  const row = (await getOutgoing(first.id, "alice"))!;
  expect(await completeOutgoingIfPresent(row, first, { ifUnchanged: true })).toBe(true);
  expect(await getOutgoing(first.id, "alice")).toBeUndefined();
  if (updated) {
    outgoingIds.clear();
    await render([first, peer]);
  }
  expect(result.queuedCount).toBe(1);
  await act(async () => { await result.confirmDelete(); });
  expect(result.skippedCount).toBe(1);
  expect([...result.ids.keys()]).toEqual([first.id]);
  const db = await getAppDB();
  expect(await db.get("displayMessages", ["alice", first.id])).toMatchObject({ content: first.content, status: "sent" });
  expect(await db.get("accountState", messageHideKey(first.id, "alice"))).toBeUndefined();
  expect(await db.get("displayMessages", ["alice", peer.id])).toBeUndefined();
});

it.each([false, true])("reports an in-flight failure after pruning only in the originating chat (navigated=%s)", async (navigated) => {
  let reject!: (reason: Error) => void;
  const post = vi.spyOn(api, "post").mockReturnValueOnce(new Promise((_done, fail) => { reject = fail; }));
  const second = { ...first, id: "second" };
  await render([first, second]);
  await toggle(first);
  await toggle(second);
  await act(async () => result.requestDelete("everyone"));
  let pending: ReturnType<typeof result.confirmDelete>;
  await act(async () => { pending = result.confirmDelete(); });
  expect(post).toHaveBeenCalledOnce();
  await render([{ ...first, editSequence: 1 }, second], navigated ? "other" : "chat");
  expect(result.confirmation).toBeUndefined();
  await act(async () => { reject(new Error("Offline")); await pending; });
  expect(document.body.textContent?.includes("Could not delete the message. Try again.")).toBe(!navigated);
  if (!navigated) expect([...result.ids.keys()]).toEqual([second.id]);
});

it("applies the receipt and reports pending attachment cleanup after an actionable size error", async () => {
  const post = vi.spyOn(api, "post").mockRejectedValueOnce(new ApiError("Select fewer", 413, "DELETE_BATCH_SMALLER_SELECTION"));
  const deletedAt = Date.now();
  post.mockResolvedValueOnce({ deletions: [{ ids: [first.id], deletedAt, deletedByUserId: "alice" }], cleanupPending: true });
  await saveMessage(first, undefined, "alice");
  await render([first]);
  await toggle(first);
  await act(async () => result.requestDelete("everyone"));
  await act(async () => { await result.confirmDelete(); });
  expect(result.deleteError).toBe("messageSelectionSmallerBatch");
  expect(result.ids.has(first.id)).toBe(true);
  await act(async () => { await result.confirmDelete(); });
  expect(document.body.textContent).toContain("Attachment cleanup will finish automatically.");
  expect(await getMessageDeletion(first.id, "alice")).toMatchObject({ deletedAt });
});

it("explains the unresolved legacy attachment and lets the user remove it from the selection", async () => {
  const attachment = { ...first, id: "legacy", type: "file" as const, status: "failed" as const, content: "" };
  const post = vi.spyOn(api, "post")
    .mockRejectedValueOnce(new ApiError("Legacy attachment reference required", 409, "LEGACY_FILE_REFERENCE_REQUIRED"))
    .mockResolvedValueOnce({ deletions: [] });
  await render([first, attachment]);
  await toggle(first);
  await toggle(attachment);
  await act(async () => result.requestDelete("everyone"));
  await act(async () => { await result.confirmDelete(); });
  expect(result.deleteError).toBe("messageSelectionLegacyAttachment");
  expect([...result.ids.keys()]).toEqual([first.id, attachment.id]);
  await toggle(attachment);
  await act(async () => result.requestDelete("everyone"));
  await act(async () => { await result.confirmDelete(); });
  expect(post).toHaveBeenLastCalledWith("/api/messages/delete-batch", { conversationId: "chat", ids: [first.id], fileIds: {} });
});

it("disables Delete for everyone as a selected row reaches its expiration", async () => {
  vi.useFakeTimers();
  const timed = { ...first, expiresAt: Date.now() + 100 };
  await render([timed]);
  await toggle(timed);
  expect(result.unavailable).toBeUndefined();
  await act(async () => vi.advanceTimersByTime(100));
  expect(result.unavailable).toBe("messageSelectionExpired");
});
