import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WSFrameType, type WSMessageFrame, type ConversationWithMembers } from "@e2ee-chat/shared";
import { commitReceivedMessage, getAppDB, getMessageById, getSyncState, saveMessage, saveSyncState } from "../db/index.js";
import { api } from "../services/api.js";
import { useChatStore } from "../stores/chatStore.js";
import { decryptMessage } from "./message-processor.js";
import { ingestMessageFrame, loadPersistedConversationMessages, resetMessageSyncState, syncMessages } from "./message-sync.js";
import { capabilities } from "../platform/capabilities.js";
import { showMessageNotification } from "./browser-notifications.js";

vi.mock("../services/api.js", () => ({ api: { get: vi.fn() } }));
vi.mock("./browser-notifications.js", () => ({ showMessageNotification: vi.fn() }));
vi.mock("../stores/authStore.js", () => ({
  useAuthStore: { getState: () => ({ user: { id: "bob" }, device: { id: "bob-device" } }) },
}));
vi.mock("../stores/callStore.js", () => ({ useCallStore: { getState: () => ({ markKeyReady: vi.fn() }) } }));
vi.mock("./message-processor.js", () => ({ decryptMessage: vi.fn(), decryptGroupText: vi.fn() }));
vi.mock("./conversation-cache.js", () => ({
  getCachedConversation: () => ({ id: "conv", type: "direct" }),
  ensureConversationInCache: vi.fn(),
  touchConversationInCache: vi.fn(),
}));

const syncStateId = "message-sync:bob:bob-device";
function frame(id: string, ts = 100): WSMessageFrame {
  return {
    type: WSFrameType.Message, id, conversationId: "conv", senderId: "alice", senderDeviceId: "alice-device",
    msgType: "text", ciphertext: "opaque", iv: "iv", header: "{}", timestamp: ts,
    serverTimestamp: ts, expiresAt: Date.now() + 60_000, expiryKind: "retention",
  };
}
async function completeDecrypt(content: string, receive: Parameters<typeof decryptMessage>[2]) {
  await commitReceivedMessage(receive.messageId, await receive.prepare(new TextEncoder().encode(content)));
  return content;
}
function requestParams(index = 0): URLSearchParams {
  return new URL(vi.mocked(api.get).mock.calls[index][0], "https://test").searchParams;
}

beforeEach(async () => {
  resetMessageSyncState();
  const db = await getAppDB();
  await Promise.all(Array.from(db.objectStoreNames, (name) => db.clear(name)));
  useChatStore.setState({ messages: new Map(), unreadCounts: new Map(), activeConversationId: "conv" });
  vi.resetAllMocks();
  vi.mocked(decryptMessage).mockImplementation((...args) => completeDecrypt("decrypted", args[2]));
});
afterEach(() => vi.restoreAllMocks());

it.each([false, true])("notifies a hidden active conversation only on the native notification path (capability=%s)", async (native) => {
  vi.spyOn(capabilities, "nativeCallNotifications", "get").mockReturnValue(native);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  useChatStore.setState({ conversations: [{ id: "conv", members: [{ userId: "alice", user: { displayName: "Alice" } }] }] as ConversationWithMembers[] });
  await ingestMessageFrame(frame("new-message", Date.now()));
  expect(vi.mocked(showMessageNotification).mock.calls).toEqual(native ? [["Alice", "conv"]] : []);
});
it("never notifies the visible active conversation even with native notifications", async () => {
  vi.spyOn(capabilities, "nativeCallNotifications", "get").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await ingestMessageFrame(frame("visible-message", Date.now()));
  expect(showMessageNotification).not.toHaveBeenCalled();
});

/** Makes the next `count` IndexedDB write transactions fail, like a quota or transient IDB error. */
async function failNextWrites(count: number) {
  const db = await getAppDB();
  const original = db.transaction.bind(db) as (...args: unknown[]) => unknown;
  let remaining = count;
  const spy = vi.spyOn(db, "transaction").mockImplementation(((...args: unknown[]) => {
    if (args[1] === "readwrite" && remaining > 0) {
      remaining--;
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    }
    return original(...args);
  }) as never);
  return () => spy.mockRestore();
}

async function simulateReload() {
  resetMessageSyncState();
  useChatStore.setState({ messages: new Map() });
  await loadPersistedConversationMessages("conv");
  return useChatStore.getState().messages.get("conv") ?? [];
}

describe("failed message persistence", () => {
  it("saves a live message whose first save failed when an identical copy is synced, so it survives a reload", async () => {
    const live = frame("live", 100);
    const restore = await failNextWrites(1);
    try {
      await expect(ingestMessageFrame(live)).rejects.toThrow("QuotaExceededError");
      // Failed commits publish no plaintext; the unchanged ratchet can decrypt the replay.
      expect(useChatStore.getState().messages.get("conv")).toBeUndefined();
      expect(await getMessageById("live")).toBeUndefined();

      vi.mocked(api.get).mockResolvedValue({ messages: [{ ...live }], hasMore: false });
      await syncMessages({ force: true });
    } finally {
      restore();
    }
    expect(decryptMessage).toHaveBeenCalledTimes(2);
    expect(await getMessageById("live")).toMatchObject({ content: "decrypted", timestamp: 100 });
    expect(await getSyncState(syncStateId)).toMatchObject({ value: 100, cursorId: "live" });
    expect(await simulateReload()).toMatchObject([{ id: "live", content: "decrypted" }]);
  });

  it("does not move the sync cursor past a message whose save failed, and saves it on the next sync", async () => {
    await saveSyncState(syncStateId, 50, "before");
    vi.mocked(api.get).mockResolvedValue({ messages: [frame("first", 100), frame("second", 101)], hasMore: false });
    const restore = await failNextWrites(1);
    try {
      await expect(syncMessages({ force: true })).rejects.toThrow("QuotaExceededError");
      expect(await getSyncState(syncStateId)).toMatchObject({ value: 50, cursorId: "before" });
      expect(await getMessageById("first")).toBeUndefined();

      // The retry resumes from the old cursor and receives the same, unchanged frame again.
      await syncMessages({ force: true });
    } finally {
      restore();
    }
    expect(requestParams(1).get("since")).toBe("50");
    expect(decryptMessage).toHaveBeenCalledTimes(3);
    expect(await getSyncState(syncStateId)).toMatchObject({ value: 101, cursorId: "second" });
    expect((await simulateReload()).map((message) => message.id)).toEqual(["first", "second"]);
  });
});

describe("message ingest dedupe", () => {
  it("merges an IndexedDB-only message without decrypting after reload", async () => {
    await saveMessage({ id: "saved", conversationId: "conv", senderId: "alice", type: "text", content: "original", timestamp: 1, expiresAt: null, status: "read" });
    const update = frame("saved", 200);
    await ingestMessageFrame(update);
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(await getMessageById("saved")).toMatchObject({ content: "original", timestamp: 200, expiresAt: update.expiresAt, expiryKind: "retention", status: "read" });
    expect(useChatStore.getState().messages.get("conv")).toHaveLength(1);
  });

  it("merges an IndexedDB-only local echo as delivered without decrypting", async () => {
    await saveMessage({ id: "echo", conversationId: "conv", senderId: "bob", type: "text", content: "sent locally", timestamp: 1, expiresAt: null, status: "sent" });
    await ingestMessageFrame({ ...frame("echo", 200), senderId: "bob", senderDeviceId: "bob-device" });
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(await getMessageById("echo")).toMatchObject({ content: "sent locally", timestamp: 200, status: "delivered" });
  });

  it("neither rewrites IndexedDB nor updates the store when a re-synced message is unchanged", async () => {
    const live = frame("live", 100);
    await ingestMessageFrame(live);
    const db = await getAppDB();
    const transaction = vi.spyOn(db, "transaction");
    const storeUpdates = vi.fn();
    const unsubscribe = useChatStore.subscribe(storeUpdates);
    const messagesBefore = useChatStore.getState().messages;

    await ingestMessageFrame({ ...live });
    expect(decryptMessage).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls.filter(([, mode]) => mode === "readwrite")).toEqual([]);
    transaction.mockRestore();
    expect(storeUpdates).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toBe(messagesBefore);

    // A copy that does differ (here: a new expiry and server timestamp) is still applied to both.
    const changed = { ...live, serverTimestamp: 150, expiresAt: live.expiresAt! + 1_000 };
    await ingestMessageFrame(changed);
    unsubscribe();
    expect(storeUpdates).toHaveBeenCalled();
    expect(useChatStore.getState().messages.get("conv")).toMatchObject([{ id: "live", timestamp: 150, expiresAt: changed.expiresAt }]);
    expect(await getMessageById("live")).toMatchObject({ content: "decrypted", timestamp: 150, expiresAt: changed.expiresAt });
    expect(decryptMessage).toHaveBeenCalledTimes(1);
  });

  it("shows an unchanged IndexedDB-only message without rewriting it", async () => {
    const saved = frame("saved", 200);
    await saveMessage({ id: "saved", conversationId: "conv", senderId: "alice", type: "text", content: "original", timestamp: 200, expiresAt: saved.expiresAt, expiryKind: "retention", status: "read" });
    const db = await getAppDB();
    const transaction = vi.spyOn(db, "transaction");
    await ingestMessageFrame(saved);
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(transaction.mock.calls.filter(([, mode]) => mode === "readwrite")).toEqual([]);
    transaction.mockRestore();
    expect(useChatStore.getState().messages.get("conv")).toMatchObject([{ id: "saved", content: "original", status: "read" }]);
  });

  it("serializes overlapping live/sync copies and decrypts only once", async () => {
    const same = frame("same");
    await Promise.all([ingestMessageFrame(same), ingestMessageFrame(same)]);
    expect(decryptMessage).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages.get("conv")).toHaveLength(1);
  });

  it("lets an in-flight decrypt finish across teardown before a duplicate rechecks IDB", async () => {
    let finish!: (value: string) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(decryptMessage).mockImplementation((...args) => {
      started();
      return new Promise<string>((resolve) => { finish = resolve; }).then((content) => completeDecrypt(content, args[2]));
    });
    const pending = ingestMessageFrame(frame("stale"));
    await ready;
    resetMessageSyncState();
    const duplicate = ingestMessageFrame(frame("stale"));
    finish("cached plaintext");
    await Promise.all([pending, duplicate]);
    expect(await getMessageById("stale")).toMatchObject({ content: "cached plaintext" });
    expect(decryptMessage).toHaveBeenCalledTimes(1);
  });
});

describe("composite sync cursor", () => {
  it("paginates equal timestamps and resumes from the saved last frame", async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({ messages: [frame("a"), frame("b")], hasMore: true })
      .mockResolvedValueOnce({ messages: [frame("c")], hasMore: false })
      .mockResolvedValue({ messages: [], hasMore: false });
    await syncMessages({ force: true });
    expect(requestParams(0).get("since")).toBe("0");
    expect(requestParams(0).has("sinceId")).toBe(false);
    expect(requestParams(1).get("since")).toBe("100");
    expect(requestParams(1).get("sinceId")).toBe("b");
    expect(await getSyncState(syncStateId)).toMatchObject({ value: 100, cursorId: "c" });
    expect(useChatStore.getState().messages.get("conv")?.map((message) => message.id)).toEqual(["a", "b", "c"]);
    resetMessageSyncState();
    await syncMessages({ force: true });
    expect(requestParams(2).get("sinceId")).toBe("c");
  });

  it("never advances the cursor from live frames, even after an empty sync", async () => {
    await saveSyncState(syncStateId, 100, "b");
    await ingestMessageFrame(frame("live", 500));
    vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false });
    await syncMessages({ force: true });
    expect(requestParams().get("since")).toBe("100");
    expect(requestParams().get("sinceId")).toBe("b");
    expect(await getSyncState(syncStateId)).toMatchObject({ value: 100, cursorId: "b" });
  });

  it("treats old saved timestamps as cursors without IDs", async () => {
    await saveSyncState(syncStateId, 100);
    vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false });
    await syncMessages({ force: true });
    expect(requestParams().get("since")).toBe("100");
    expect(requestParams().has("sinceId")).toBe(false);
  });

  it("does not overwrite the global cursor during conversation backfills", async () => {
    await saveSyncState(syncStateId, 100, "b");
    vi.mocked(api.get).mockResolvedValue({ messages: [frame("backfill", 200)], hasMore: false });
    await syncMessages({ conversationId: "conv", since: 0 });
    expect(requestParams().get("since")).toBe("0");
    expect(requestParams().has("sinceId")).toBe(false);
    expect(await getSyncState(syncStateId)).toMatchObject({ value: 100, cursorId: "b" });
  });

  it("ignores a sync response from an earlier lifecycle", async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(api.get).mockImplementation(() => {
      started();
      return new Promise((resolve) => { finish = resolve; });
    });
    const pending = syncMessages({ force: true });
    await ready;
    resetMessageSyncState();
    finish({ messages: [frame("stale")], hasMore: false });
    await pending;
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(await getSyncState(syncStateId)).toBeUndefined();
  });
});
