import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WSFrameType, type WSMessageFrame, type ConversationWithMembers } from "@e2ee-chat/shared";
import { commitReceivedMessage, getMessages, getAppDB, getMessageById, getSyncState, saveMessage, saveSyncState } from "../db/index.js";
import { api } from "../services/api.js";
import { useChatStore } from "../stores/chatStore.js";
import { decryptMessage } from "./message-processor.js";
import { ingestMessageFrame, loadPersistedConversationMessages, resetMessageSyncState, syncMessages, syncConversationMessages, loadOlderPersistedConversationMessages } from "./message-sync.js";
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

describe("message deletion", () => {
  it("applies an offline deletion even to a previously cached message and advances the mutation cursor", async () => {
    const original = frame("deleted", 100);
    await ingestMessageFrame(original);
    vi.mocked(decryptMessage).mockClear();
    await saveSyncState(syncStateId, 200, "later");
    vi.mocked(api.get).mockResolvedValue({ messages: [{ ...original, ciphertext: "", header: "", iv: "", deletedAt: 300, deletedByUserId: "alice", syncTimestamp: 300 }], hasMore: false });
    await syncMessages({ force: true });
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(await getMessageById("deleted")).toMatchObject({ content: "", deletedAt: 300, timestamp: 100 });
    expect((await getSyncState(syncStateId))?.value).toBe(300);
    expect((await simulateReload())[0]).toMatchObject({ content: "", deletedAt: 300 });
  });
  it("clears file keys, local decrypted file cache, and store content on a realtime deletion", async () => {
    const { handleMessageDeletion } = await import("./message-sync.js");
    const db = await getAppDB();
    const attachment = { id: "file-message", conversationId: "conv", senderId: "alice", type: "file", content: JSON.stringify({ fileId: "private-file", fileKey: "key", iv: "iv" }), timestamp: 100, expiresAt: Date.now() + 60_000, expiryKind: "retention" as const, status: "delivered" };
    await saveMessage(attachment);
    await db.put("fileCache", { id: "private-file", blob: new Blob(["decrypted"]) });
    await loadPersistedConversationMessages("conv");
    await handleMessageDeletion({ conversationId: "conv", deletion: { ids: [attachment.id], deletedAt: 300, deletedByUserId: "alice" } });
    expect(await db.get("fileCache", "private-file")).toBeUndefined();
    expect(await getMessageById(attachment.id)).toMatchObject({ content: "", deletedAt: 300 });
    expect(useChatStore.getState().messages.get("conv")?.[0].content).toBe("");
    // A stale ACK or delayed original frame cannot put plaintext back.
    await saveMessage(attachment);
    await ingestMessageFrame({ ...frame(attachment.id), msgType: "file" });
    expect(await getMessageById(attachment.id)).toMatchObject({ content: "", deletedAt: 300 });
    expect(decryptMessage).not.toHaveBeenCalled();
  });
  it("remembers an early deletion event before a delayed original message arrives", async () => {
    const { handleMessageDeletion } = await import("./message-sync.js");
    await handleMessageDeletion({ conversationId: "conv", deletion: { ids: ["late"], deletedAt: 300, deletedByUserId: "alice" } });
    await ingestMessageFrame(frame("late"));
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(await getMessageById("late")).toMatchObject({ content: "", deletedAt: 300 });
  });
  it("hides a message persistently, clears fileCache, and never restores it from sync or a stale save", async () => {
    const { deleteMessageForLocalUserOnly } = await import("./message-sync.js");
    const db = await getAppDB();
    const local = { id: "hidden", conversationId: "conv", senderId: "alice", type: "file", content: JSON.stringify({ fileId: "private-file", fileKey: "key" }), timestamp: 100, expiresAt: Date.now() + 60_000, expiryKind: "retention" as const, status: "delivered" };
    await saveMessage(local);
    await db.put("fileCache", { id: "private-file", blob: new Blob(["private"]) });
    await loadPersistedConversationMessages("conv");
    await deleteMessageForLocalUserOnly("conv", "hidden");
    expect(useChatStore.getState().messages.get("conv")).toEqual([]);
    expect(await db.get("fileCache", "private-file")).toBeUndefined();
    await saveMessage(local);
    expect(await simulateReload()).toEqual([]);
    vi.mocked(api.get).mockResolvedValue({ messages: [frame("hidden")], hasMore: false });
    await syncMessages({ force: true });
    expect(await getMessageById("hidden")).toBeUndefined();
    expect(useChatStore.getState().messages.get("conv")).toEqual([]);
    expect(decryptMessage).not.toHaveBeenCalled();
  });
});

it("commits ratchet output without restoring plaintext when another tab deletes during decryption", async () => {
  const { rememberMessageDeletion } = await import("../db/index.js");
  await rememberMessageDeletion("cross-tab", "conv", 300, "alice");
  await commitReceivedMessage("cross-tab", { expiresAt: Date.now() + 60_000, message: { id: "cross-tab", conversationId: "conv", senderId: "alice", type: "text", content: "must be removed", timestamp: 100, expiresAt: Date.now() + 60_000, status: "delivered" } }, { session: { id: "session", state: "advanced ratchet", updatedAt: 100 } });
  expect(await getMessageById("cross-tab")).toMatchObject({ content: "", deletedAt: 300 });
  expect((await (await getAppDB()).get("sessions", "session"))?.state).toBe("advanced ratchet");
});

it.each([
  { userId: "bob", deviceId: "bob-device", displayId: "logical" },
  { userId: "alice", deviceId: "recipient-1", displayId: "logical" },
  { userId: "alice", deviceId: "recipient-2", displayId: "logical:recipient-2" },
  { userId: "bob", deviceId: "sender-other", displayId: "logical:sender-other" },
])("maps direct tombstones to one display bubble on $deviceId", async ({ userId, deviceId, displayId }) => {
  const { useAuthStore } = await import("../stores/authStore.js");
  vi.spyOn(useAuthStore, "getState").mockReturnValue({ user: { id: userId }, device: { id: deviceId } } as never);
  const original = { id: displayId, conversationId: "conv", senderId: "bob", type: "text", content: "private", timestamp: 100, expiresAt: Date.now() + 60_000, expiryKind: "retention" as const, status: "delivered" };
  await saveMessage(original);
  await loadPersistedConversationMessages("conv");
  const ids = ["logical", "logical:recipient-2", "logical:sender-other"];
  for (const id of ids) await ingestMessageFrame({ ...frame(id), senderId: "bob", senderDeviceId: "bob-device", ciphertext: "", header: "", iv: "", deletedAt: 300, deletedByUserId: "bob" });
  const displayed = useChatStore.getState().messages.get("conv");
  expect(displayed).toHaveLength(1);
  expect(displayed![0]).toMatchObject({ id: displayId, content: "", deletedAt: 300 });
  expect(await simulateReload()).toHaveLength(1);
  expect((await (await getAppDB()).getAll("messages"))).toHaveLength(1);
  expect(decryptMessage).not.toHaveBeenCalled();
});
it("ignores unknown local tombstone echoes for every direct fanout envelope", async () => {
  for (const id of ["unknown", "unknown:other-device"]) await ingestMessageFrame({ ...frame(id), senderId: "bob", senderDeviceId: "bob-device", deletedAt: 300 });
  expect(useChatStore.getState().messages.get("conv") ?? []).toEqual([]);
  expect(await (await getAppDB()).getAll("messages")).toEqual([]);
  expect(decryptMessage).not.toHaveBeenCalled();
});

it("keeps an envelope deletion barrier when an unknown fanout tombstone creates an exact-envelope placeholder", async () => {
  const { savePendingReceive, getPendingReceives } = await import("../db/index.js");
  const delayed = frame("new-logical:recipient-2");
  await savePendingReceive(delayed, "bob", "bob-device");
  await ingestMessageFrame({ ...delayed, ciphertext: "", header: "", iv: "", deletedAt: 300 });
  expect(await getPendingReceives("bob", "bob-device")).toEqual([]);
  await ingestMessageFrame(delayed);
  expect(decryptMessage).not.toHaveBeenCalled();
  expect(useChatStore.getState().messages.get("conv")).toHaveLength(1);
  expect(useChatStore.getState().messages.get("conv")![0]).toMatchObject({ id: "new-logical:recipient-2", content: "", deletedAt: 300 });
});

describe("delete for me Undo", () => {
  const local = () => ({ id: "undo-file", conversationId: "conv", senderId: "alice", type: "file", content: JSON.stringify({ fileId: "undo-attachment", fileKey: "secret", iv: "secret-iv" }), timestamp: 100, expiresAt: Date.now() + 60_000, expiryKind: "retention" as const, status: "delivered" });
  async function prepare() {
    const message = local();
    await saveMessage(message);
    const db = await getAppDB();
    await db.put("fileCache", { id: "undo-attachment", blob: new Blob(["private"]) });
    await loadPersistedConversationMessages("conv");
    return { message, db };
  }
  afterEach(() => vi.useRealTimers());
  it("hides immediately and from history, retains the record and file until Undo restores them", async () => {
    const { hideMessageWithUndo } = await import("./message-sync.js");
    const { message, db } = await prepare();
    const undo = await hideMessageWithUndo("conv", message.id);
    expect(undo).not.toBeNull();
    expect(useChatStore.getState().messages.get("conv")).toEqual([]);
    expect(await getMessages("conv")).toEqual([]);
    expect((await getMessageById(message.id))?.content).toBe(message.content);
    expect(await db.get("fileCache", "undo-attachment")).toBeDefined();
    expect(await undo!()).toBe(true);
    expect((await simulateReload())[0].content).toBe(message.content);
    expect(await db.get("syncState", "hidden-message:" + message.id)).toBeUndefined();
  });
  it("commits after five seconds, clears files and resists stale sync", async () => {
    const { hideMessageWithUndo } = await import("./message-sync.js");
    const { message, db } = await prepare();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const undo = await hideMessageWithUndo("conv", message.id);
    await vi.advanceTimersByTimeAsync(4999);
    expect(await getMessageById(message.id)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    // The timer starts an asynchronous IDB transaction. This read follows that transaction.
    expect(await getMessageById(message.id)).toBeUndefined();
    expect(await db.get("fileCache", "undo-attachment")).toBeUndefined();
    expect(await undo!()).toBe(false);
    await saveMessage(message);
    await ingestMessageFrame({ ...frame(message.id), msgType: "file" });
    expect(await simulateReload()).toEqual([]);
    expect(decryptMessage).not.toHaveBeenCalled();
  });
  it("keeps tab A's Undo available when tab B opens a database connection during its window", async () => {
    const { openDB } = await import("idb");
    const { hideMessageWithUndo } = await import("./message-sync.js");
    const { commitAbandonedMessageHides } = await import("../db/index.js");
    const { message, db } = await prepare();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const deadline = Date.now() + 5000;
    const undo = await hideMessageWithUndo("conv", message.id);
    expect(await db.get("syncState", "hidden-message:" + message.id)).toMatchObject({ undoDeadline: deadline });
    const tabB = await openDB(db.name);
    try {
      vi.setSystemTime(deadline - 1);
      await commitAbandonedMessageHides(tabB);
      expect(await tabB.get("messages", message.id)).toBeDefined();
      expect(await tabB.get("fileCache", "undo-attachment")).toBeDefined();
      expect(await getMessages("conv")).toEqual([]);
      expect(await undo!()).toBe(true);
      expect((await getMessageById(message.id))?.content).toBe(message.content);
      expect(await tabB.get("syncState", "hidden-message:" + message.id)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(5000);
      expect((await getMessageById(message.id))?.content).toBe(message.content);
    } finally { tabB.close(); }
  });
  it("reopens during Undo and commits at the remaining deadline without the original tab's timer", async () => {
    const { openDB } = await import("idb");
    const { beginMessageHide, commitAbandonedMessageHides } = await import("../db/index.js");
    const { message, db } = await prepare();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Persist the hide without installing the original tab's message-sync timer.
    const pending = await beginMessageHide(message.id);
    await vi.advanceTimersByTimeAsync(2000);
    const reopened = await openDB(db.name);
    try {
      await commitAbandonedMessageHides(reopened);
      await vi.advanceTimersByTimeAsync(2999);
      expect((await reopened.get("messages", message.id))?.content).toBe(message.content);
      expect(await reopened.get("fileCache", "undo-attachment")).toBeDefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(await reopened.get("messages", message.id)).toBeUndefined();
      expect(await reopened.get("fileCache", "undo-attachment")).toBeUndefined();
      expect(await reopened.get("syncState", "hidden-message:" + message.id)).toEqual({ id: "hidden-message:" + message.id });
      expect(Date.now()).toBe(pending!.deadline);
    } finally { reopened.close(); }
  });
  it("retries a failed deadline commit on the next sweep, clearing plaintext, keys and cached files", async () => {
    const { beginMessageHide, commitAbandonedMessageHides } = await import("../db/index.js");
    const { message, db } = await prepare();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await beginMessageHide(message.id);
    await commitAbandonedMessageHides(db);
    const restore = await failNextWrites(1);
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(await db.get("messages", message.id)).toBeDefined();
    } finally { restore(); }
    await vi.advanceTimersByTimeAsync(30_000);
    await commitAbandonedMessageHides(db);
    expect(await db.get("messages", message.id)).toBeUndefined();
    expect(await db.get("fileCache", "undo-attachment")).toBeUndefined();
  });
  it("commits an expired abandoned Undo after reload without relying on the owning tab's timer", async () => {
    const { openDB } = await import("idb");
    const { hideMessageWithUndo } = await import("./message-sync.js");
    const { commitAbandonedMessageHides } = await import("../db/index.js");
    const { message, db } = await prepare();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const deadline = Date.now() + 5000;
    const undo = await hideMessageWithUndo("conv", message.id);
    // Moving the clock does not fire A's timer; model A having closed meanwhile.
    vi.setSystemTime(deadline);
    const reloaded = await openDB(db.name);
    try {
      await commitAbandonedMessageHides(reloaded);
      expect(await reloaded.get("messages", message.id)).toBeUndefined();
      expect(await reloaded.get("fileCache", "undo-attachment")).toBeUndefined();
      expect(await undo!()).toBe(false);
      expect(await simulateReload()).toEqual([]);
    } finally { reloaded.close(); }
  });
  it.each(["event", "sync"])("restores only a tombstone when a remote deletion arrives by %s during Undo", async (route) => {
    const { hideMessageWithUndo, handleMessageDeletion } = await import("./message-sync.js");
    const { message, db } = await prepare();
    const undo = await hideMessageWithUndo("conv", message.id);
    if (route === "event") await handleMessageDeletion({ conversationId: "conv", deletion: { ids: [message.id], deletedAt: 300, deletedByUserId: "alice" } });
    else await ingestMessageFrame({ ...frame(message.id), msgType: "file", deletedAt: 300, deletedByUserId: "alice" });
    expect(await db.get("fileCache", "undo-attachment")).toBeUndefined();
    expect(await undo!()).toBe(true);
    expect((await simulateReload())[0]).toMatchObject({ content: "", deletedAt: 300 });
  });
});

it("applies mutations even on an empty message page and persists a separate account/device cursor", async () => {
  await ingestMessageFrame(frame("old", 100));
  await saveSyncState(syncStateId, 10_000, "newer");
  const mutation = { ...frame("old", 100), ciphertext: "", deletedAt: 200, deletedByUserId: "alice", mutationSeq: 7 };
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false, mutations: [mutation], hasMoreMutations: false });
  await syncMessages({ force: true });
  expect(await getMessageById("old")).toMatchObject({ content: "", deletedAt: 200 });
  expect((await getSyncState(syncStateId))?.value).toBe(10_000);
  expect((await getSyncState("message-mutations:bob:bob-device"))?.value).toBe(7);
  resetMessageSyncState();
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false, mutations: [], hasMoreMutations: false });
  await syncMessages({ force: true });
  expect(requestParams(1).get("mutationSince")).toBe("7");
});
it("paginates mutations independently and never advances the global mutation cursor from conversation backfill", async () => {
  const mutation = (id: string, mutationSeq: number) => ({ ...frame(id), deletedAt: 200, deletedByUserId: "alice", mutationSeq });
  vi.mocked(api.get).mockResolvedValueOnce({ messages: [], hasMore: false, mutations: [mutation("one", 1)], hasMoreMutations: true })
    .mockResolvedValueOnce({ messages: [], hasMore: false, mutations: [mutation("two", 2)], hasMoreMutations: false });
  await syncMessages({ force: true });
  expect(requestParams(1).get("mutationSince")).toBe("1");
  expect((await getSyncState("message-mutations:bob:bob-device"))?.value).toBe(2);
  vi.mocked(api.get).mockResolvedValueOnce({ messages: [], hasMore: false, mutations: [mutation("backfill", 99)], hasMoreMutations: false });
  await syncMessages({ conversationId: "conv", since: 0 });
  expect((await getSyncState("message-mutations:bob:bob-device"))?.value).toBe(2);
});

it("does not regress the account/device mutation cursor when another tab finishes an older page", async () => {
  const { advanceMutationCursor } = await import("../db/index.js");
  const id = "message-mutations:bob:bob-device";
  await Promise.all([advanceMutationCursor(id, 9), advanceMutationCursor(id, 4)]);
  expect((await getSyncState(id))?.value).toBe(9);
  expect(await getSyncState("message-mutations:other:bob-device")).toBeUndefined();
  expect(await getSyncState("message-mutations:bob:other-device")).toBeUndefined();
});

it("merges cached history with WS/local entries arriving while the page snapshot awaits", async () => {
  const database = await import("../db/index.js");
  const base = { conversationId: "conv", senderId: "alice", type: "text" as const, expiresAt: Date.now() + 60000, expiryKind: "retention" as const, status: "delivered" as const };
  const cached = { ...base, id: "cached", timestamp: 100, content: "cached history" };
  const collision = { ...base, id: "collision", timestamp: 101, content: "old cache snapshot" };
  await saveMessage(cached); await saveMessage(collision);
  const original = database.getCachedConversationMessagesPage;
  const race: typeof original = async (...args) => {
    const snapshot = await original(...args);
    await ingestMessageFrame(frame("live", 200));
    useChatStore.getState().addMessage("conv", { ...collision, content: "new local/live value", timestamp: 300, status: "read" });
    return snapshot;
  };
  vi.spyOn(database, "getCachedConversationMessagesPage").mockImplementationOnce(race);
  await loadPersistedConversationMessages("conv");
  const messages = useChatStore.getState().messages.get("conv")!;
  expect(messages.map((message) => message.id)).toEqual(["cached", "live", "collision"]);
  expect(messages.find((message) => message.id === "live")).toMatchObject({ content: "decrypted", timestamp: 200 });
  expect(messages.find((message) => message.id === "collision")).toMatchObject({ content: "new local/live value", timestamp: 300, status: "read" });
});

it("opens the latest cached page after reload even when offline mutation sync populated a tombstone first", async () => {
  const base = { conversationId: "conv", senderId: "alice", type: "text" as const, expiresAt: Date.now() + 60000, expiryKind: "retention" as const, status: "delivered" as const };
  await saveMessage({ ...base, id: "old-deleted", timestamp: 100, content: "old content" });
  await saveMessage({ ...base, id: "newer", timestamp: 300, content: "newer cached content" });
  await saveSyncState(syncStateId, 400, "already-synced");
  resetMessageSyncState(); useChatStore.setState({ messages: new Map() });
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false, mutations: [{ ...frame("old-deleted", 100), deletedAt: 200, deletedByUserId: "alice", mutationSeq: 1 }], hasMoreMutations: false, mutationCursor: 1 });
  await syncMessages({ force: true });
  expect(useChatStore.getState().messages.get("conv")).toEqual([expect.objectContaining({ id: "old-deleted", content: "", deletedAt: 200 })]);
  await loadPersistedConversationMessages("conv");
  expect(useChatStore.getState().messages.get("conv")).toEqual([
    expect.objectContaining({ id: "old-deleted", content: "", deletedAt: 200 }),
    expect.objectContaining({ id: "newer", content: "newer cached content" }),
  ]);
});
it("persists the server's drained high-water cursor even when all mutations were filtered out", async () => {
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false, mutations: [], hasMoreMutations: false, mutationCursor: 5000 });
  await syncMessages({ force: true });
  expect((await getSyncState("message-mutations:bob:bob-device"))?.value).toBe(5000);
  resetMessageSyncState();
  await syncMessages({ force: true });
  expect(requestParams(1).get("mutationSince")).toBe("5000");
});

it.each([false, true])("pages all 220 cached messages past an injected oldest tombstone (equal timestamps=%s)", async (tied) => {
  const base = { conversationId: "conv", senderId: "alice", type: "text", expiresAt: Date.now() + 60000, expiryKind: "retention", status: "delivered" };
  const db = await getAppDB(), tx = db.transaction("messages", "readwrite");
  const ids = Array.from({ length: 220 }, (_, index) => `m${String(index).padStart(3, "0")}`);
  await Promise.all(ids.map((id, index) => tx.store.put({ ...base, id, timestamp: tied ? 1000 : 1000 + index, content: `cached ${id}` })));
  await tx.done;
  await ingestMessageFrame({ ...frame(ids[0], 1000), deletedAt: 2000, deletedByUserId: "alice" });
  expect(useChatStore.getState().messages.get("conv")).toHaveLength(1);
  expect(await loadPersistedConversationMessages("conv")).toMatchObject({ loadedCount: 100, hasOlder: true });
  expect(useChatStore.getState().messages.get("conv")).toHaveLength(101);
  const { loadOlderPersistedConversationMessages } = await import("./message-sync.js");
  expect(await loadOlderPersistedConversationMessages("conv")).toEqual({ loadedCount: 100, hasOlder: true });
  expect(useChatStore.getState().messages.get("conv")?.find((message) => message.id === "m100")?.content).toBe("cached m100");
  expect(await loadOlderPersistedConversationMessages("conv")).toEqual({ loadedCount: 20, hasOlder: false });
  expect(useChatStore.getState().messages.get("conv")?.map((message) => message.id)).toEqual(ids);
  expect(useChatStore.getState().messages.get("conv")?.[0]).toMatchObject({ id: ids[0], content: "", deletedAt: 2000 });
  expect(await loadOlderPersistedConversationMessages("conv")).toEqual({ loadedCount: 0, hasOlder: false });
});

it.each(["other-sender", "other-conversation"])("never maps a crafted victim:suffix tombstone onto a target in %s", async (mismatch) => {
  const victim = { id: "victim", conversationId: mismatch === "other-conversation" ? "other" : "conv", senderId: mismatch === "other-sender" ? "charlie" : "alice", type: "file" as const, content: JSON.stringify({ fileId: "victim-file", fileKey: "victim-key", iv: "iv" }), timestamp: 100, expiresAt: Date.now() + 60000, expiryKind: "retention" as const, status: "delivered" as const };
  await saveMessage(victim); useChatStore.getState().addMessage(victim.conversationId, victim);
  const db = await getAppDB(); await db.put("fileCache", { id: "victim-file", blob: new Blob(["private"]) });
  await ingestMessageFrame({ ...frame("victim:suffix"), deletedAt: 300, deletedByUserId: "alice" });
  expect((await getMessageById("victim"))?.content).toBe(victim.content);
  expect(await db.get("fileCache", "victim-file")).toBeDefined();
  expect(await getMessageById("victim:suffix")).toMatchObject({ id: "victim:suffix", content: "", senderId: "alice", conversationId: "conv" });
  expect(await db.get("syncState", "deleted-message:victim")).toBeUndefined();
  // Even an exact-ID tombstone/event cannot cross that ownership boundary.
  await ingestMessageFrame({ ...frame("victim"), deletedAt: 400, deletedByUserId: "alice" });
  const { handleMessageDeletion } = await import("./message-sync.js");
  await handleMessageDeletion({ conversationId: "conv", deletion: { ids: ["victim"], deletedAt: 500, deletedByUserId: "alice" } });
  expect((await getMessageById("victim"))?.content).toBe(victim.content);
  expect(await db.get("fileCache", "victim-file")).toBeDefined();
});

it("opens chats incrementally and retains 100-message local history pagination", async () => {
  await saveSyncState(syncStateId, 1_000, "global-later");
  for (let i = 1; i <= 150; i++) await saveMessage({ id: `history-${i}`, conversationId: "conv", senderId: "alice", type: "text", content: `Message ${i}`, timestamp: i, expiresAt: Date.now() + 60_000, status: "delivered" });
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false });
  expect(await loadPersistedConversationMessages("conv")).toMatchObject({ loadedCount: 100, hasOlder: true });
  await syncConversationMessages("conv");
  expect(api.get).toHaveBeenCalledOnce();
  expect(requestParams().has("conversationId")).toBe(false);
  expect(requestParams().get("since")).toBe("1000");
  expect(requestParams().get("sinceId")).toBe("global-later");
  expect(useChatStore.getState().messages.get("conv")).toHaveLength(100);
  expect(await loadOlderPersistedConversationMessages("conv")).toMatchObject({ loadedCount: 50, hasOlder: false });
});
