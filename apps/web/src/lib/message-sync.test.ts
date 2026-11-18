import { setLocalEncryptionKey } from "./local-key-encryption.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { historyDeletionLookupSchema, WSFrameType, type WSMessageFrame, type ConversationWithMembers } from "@e2ee-chat/shared";
import { clearCryptoState, commitReceivedMessage, getMessages, getAppDB, messageHideKey, indexImportedDeletion, importedDeletionPrefix, getMessageById, getReceiveReceipt, getSession, getSyncState, saveMessage as writeOwnedMessage, saveSyncState } from "../db/index.js";
import { api } from "../services/api.js";
import { useChatStore } from "../stores/chatStore.js";
import { decryptMessage } from "./message-processor.js";
import { ingestMessageFrame, loadPersistedConversationMessages, reconcileImportedHistoryDeletions, reconcileLocalMessageChange, refreshImportedConversationMessages, refreshLatestConversationPreview,
  resetMessageSyncState, restoreVerifiedLegacyHistory, syncMessages, syncConversationMessages, loadOlderPersistedConversationMessages, verifyHistoryDisclosure } from "./message-sync.js";
import { capabilities } from "../platform/capabilities.js";
import { exportHistoryTransfer, historyArchiveIsCurrent, importHistoryTransferItem } from "../db/history-transfer.js";
import { showMessageNotification } from "./browser-notifications.js";

const saveMessage = (row: Parameters<typeof writeOwnedMessage>[0], current?: () => boolean, ownerId = row.ownerId ?? "bob") =>
  writeOwnedMessage(row, current, ownerId);

vi.mock("../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
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
const saveCommittedMessage = (message: Parameters<typeof writeOwnedMessage>[0]) =>
  commitReceivedMessage(message.id, {
    message, ownerId: "bob", deviceId: "bob-device", direct: true,
    expiresAt: message.expiresAt ?? Date.now() + 60_000,
  });
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
  setLocalEncryptionKey(await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
  resetMessageSyncState();
  const db = await getAppDB();
  await Promise.all(Array.from(db.objectStoreNames, (name) => db.clear(name)));
  useChatStore.setState({ messages: new Map(), unreadCounts: new Map(), activeConversationId: "conv" });
  vi.resetAllMocks();
  vi.mocked(decryptMessage).mockImplementation((...args) => completeDecrypt("decrypted", args[2]));
});
afterEach(() => vi.restoreAllMocks());

it.each([false, true])("keeps a finalized v5 hide invisible during live replay (decrypt fails %s)", async (fails) => {
  const db = await getAppDB();
  await db.put("accountState", { id: "hidden-message:legacy-hidden" });
  await db.put("accountState", { id: "received:legacy-hidden", expiresAt: null });
  useChatStore.setState({ activeConversationId: null });
  vi.mocked(decryptMessage).mockImplementation(async (_kind, _incoming, receive) => {
    if (fails) throw new Error("receive key already consumed");
    const session = { id: "alice:alice-device", state: "updated ratchet", updatedAt: Date.now() };
    await commitReceivedMessage(receive.messageId, await receive.prepare(new TextEncoder().encode("hidden plaintext")), { session });
    return "hidden plaintext";
  });
  const incoming = frame("legacy-hidden");
  await ingestMessageFrame(incoming);
  await ingestMessageFrame(incoming);
  expect(decryptMessage).toHaveBeenCalledOnce();
  expect(await getReceiveReceipt(incoming.id, "bob", "bob-device")).toMatchObject({ ownerId: "bob" });
  expect(await db.get("displayMessages", ["bob", incoming.id])).toBeUndefined();
  expect(useChatStore.getState().messages.get("conv")).toBeUndefined();
  expect(useChatStore.getState().unreadCounts.get("conv")).toBeUndefined();
  if (!fails) expect(await getSession("alice:alice-device")).toMatchObject({ state: "updated ratchet" });
});

it("advances the live receive ratchet without unread counts or notifications for a hidden fanout sibling", async () => {
  const db = await getAppDB();
  await db.put("accountState", { id: messageHideKey("family:copied-device", "bob"), ownerId: "bob" });
  useChatStore.setState({ activeConversationId: null });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.mocked(decryptMessage).mockImplementation(async (_kind, _incoming, receive) => {
    const session = { id: "alice:alice-device", state: "ratchet after hidden fanout", updatedAt: Date.now() };
    await commitReceivedMessage(receive.messageId, await receive.prepare(new TextEncoder().encode("hidden plaintext")), { session });
    return "hidden plaintext";
  });
  const incoming = frame("family:this-device", Date.now());
  await ingestMessageFrame(incoming);
  expect(await getReceiveReceipt(incoming.id, "bob", "bob-device")).toMatchObject({ hidden: true });
  expect(await getSession("alice:alice-device")).toMatchObject({ state: "ratchet after hidden fanout" });
  expect(useChatStore.getState().messages.get("conv")).toBeUndefined();
  expect(useChatStore.getState().unreadCounts.get("conv")).toBeUndefined();
  expect(showMessageNotification).not.toHaveBeenCalled();
});

it("remembers an empty live cache across syncs and reloads without walking imported history again", async () => {
  const db = await getAppDB();
  await db.put("displayMessages", { id: "old", conversationId: "conv", senderId: "alice", ownerId: "bob",
    content: "transfer", type: "text", status: "delivered", timestamp: Date.now(), importedAt: Date.now(), expiresAt: null });
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false });
  await syncMessages({ force: true });
  expect(await getSyncState(syncStateId)).toBeUndefined();
  resetMessageSyncState();
  const transaction = vi.spyOn(db, "transaction");
  await syncMessages({ force: true });
  expect(transaction.mock.calls.some(([stores]) => [stores].flat().includes("messages"))).toBe(false);
  expect(requestParams(1).get("since")).toBe("0");
});

it("reconciles transferred display IDs even when the ordinary mutation cursor already passed the deletion", async () => {
  const time = Date.now();
  await importHistoryTransferItem("bob", { entry: { kind: "conversation", conversation: {
    id: "conv", type: "direct", name: null, avatarUrl: null, invitePolicy: "any_member", createdBy: "alice",
    updatedAt: time, createdAt: time, members: [{ conversationId: "conv", userId: "bob", role: "member",
      joinedAt: time, acceptedAt: time, user: { username: "bob", displayName: "Bob", avatarUrl: null } }],
  } } });
  await saveMessage({ id: "old:new-device", direct: true, conversationId: "conv", senderId: "alice", type: "text",
    status: "failed", content: "", timestamp: time, expiresAt: time + 60_000, ownerId: "bob" });
  await importHistoryTransferItem("bob", { entry: { kind: "message", message: {
    id: "old:old-device", conversationId: "conv", senderId: "alice", type: "text",
    status: "delivered", content: "previously copied", timestamp: time, expiresAt: time + 60_000,
  } } });
  await saveSyncState("message-mutations:bob:bob-device", 10);
  vi.mocked(api.get).mockResolvedValue({ messages: [], mutations: [], hasMore: false, mutationCursor: 11 });
  vi.mocked(api.post).mockResolvedValue({ deletions: [{ id: "old:old-device", conversationId: "conv", senderId: "alice",
    deletedAt: time + 1, deletedByUserId: "alice" }] });
  await syncMessages({ force: true });
  expect(api.post).toHaveBeenCalledWith("/api/messages/history-deletions", { messages: [
    { id: "old:old-device", conversationId: "conv", senderId: "alice" },
  ] });
  expect(await getMessageById("old:new-device")).toMatchObject({ content: "", deletedAt: time + 1 });
  expect(await getSyncState("message-mutations:bob:bob-device")).toMatchObject({ value: 11 });
});

it("pins a committed deletion watermark and checks all selected imports before disclosure", async () => {
  const now = Date.now(), db = await getAppDB();
  const transaction = db.transaction(["displayMessages", "accountState"], "readwrite");
  for (let i = 0; i < 502; i++) {
    const id = `copied-${i.toString().padStart(3, "0")}`;
    const row = { id, conversationId: i === 501 ? "unselected" : "conv", senderId: "alice", ownerId: "bob",
      type: "text", status: "delivered", content: "private", timestamp: now, expiresAt: now + 60_000,
      importedAt: now, transferSourceId: `${id}:old-device`, direct: true };
    await transaction.objectStore("displayMessages").put(row);
    await indexImportedDeletion(transaction.objectStore("accountState"), row);
  }
  await transaction.done;
  await saveCommittedMessage({ ...frame("live", now), id: "live", conversationId: "conv", senderId: "alice", type: "text",
    content: "live private", status: "delivered" });
  const mutation = { ...frame("live", now), deletedAt: now + 1, mutationSeq: 3 };
  vi.mocked(api.get).mockResolvedValueOnce({ mutations: [mutation], mutationCursor: 3, mutationHighWater: 8, hasMoreMutations: true })
    .mockResolvedValueOnce({ mutations: [], mutationCursor: 8, mutationHighWater: 8, hasMoreMutations: false });
  vi.mocked(api.post).mockImplementation(async (_path, body) => ({ deletions: historyDeletionLookupSchema.parse(body).messages
    .filter(({ id }) => id === "copied-500:old-device").map((message) => ({ ...message, deletedAt: now + 1, deletedByUserId: "alice" })) }) as never);
  await verifyHistoryDisclosure(new Set(["conv"]), () => true);
  expect(requestParams(0).get("mutationThrough")).toBeNull();
  expect(requestParams(1).get("mutationThrough")).toBe("8");
  expect(requestParams(1).get("mutationSince")).toBe("3");
  expect(await getSyncState("message-mutations:bob:bob-device")).toMatchObject({ value: 8 });
  expect(vi.mocked(api.post).mock.calls.map(([, body]) => (body as { messages: unknown[] }).messages.length)).toEqual([100, 100, 100, 100, 100, 1]);
  expect(await getMessageById("live", "bob")).toMatchObject({ content: "", deletedAt: now + 1 });
  expect(await getMessageById("copied-500", "bob")).toMatchObject({ content: "", deletedAt: now + 1 });
  expect(await getMessageById("copied-501", "bob")).toMatchObject({ content: "private" });
});

it.each([false, true])("only retries the outstanding deletion batch after a 429 (cancelled: %s)", async (cancelled) => {
  let hitThrottle!: () => void;
  const throttled = new Promise<void>((resolve) => { hitThrottle = resolve; });
  const seen: string[] = [];
  let current = true;
  vi.mocked(api.get).mockResolvedValue({ mutations: [], mutationCursor: 0, mutationHighWater: 0, hasMoreMutations: false });
  vi.mocked(api.post).mockImplementation(async (_path, body) => {
    const [first] = historyDeletionLookupSchema.parse(body).messages;
    seen.push(first.id);
    if (seen.length === 2) {
      hitThrottle();
      throw Object.assign(new Error("Rate limited"), { status: 429 });
    }
    return { deletions: [] } as never;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const candidates = Array.from({ length: 101 }, (_, index) => ({ id: `row-${index}`, displayId: `row-${index}`, conversationId: "conv", senderId: "alice" }));
    const preflight = verifyHistoryDisclosure(new Set(["conv"]), () => current, candidates).catch((error: unknown) => error);
    await throttled;
    await vi.advanceTimersByTimeAsync(999);
    expect(seen).toEqual(["row-0", "row-100"]);
    current = !cancelled;
    await vi.advanceTimersByTimeAsync(1);
    expect(await preflight).toEqual(cancelled ? new Error("History disclosure session changed") : undefined);
    expect(seen).toEqual(cancelled ? ["row-0", "row-100"] : ["row-0", "row-100", "row-100"]);
    expect(api.get).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("restores addressed pending-chat history and reconciles a failed row before refreshing history pages", async () => {
  const now = Date.now(), db = await getAppDB();
  const conversation: ConversationWithMembers = { id: "conv", type: "direct", name: null, avatarUrl: null, invitePolicy: "any_member", createdBy: "alice",
    createdAt: now, updatedAt: now, members: [{ conversationId: "conv", userId: "bob", role: "member", joinedAt: now,
      acceptedAt: null, user: { username: "bob", displayName: "Bob", avatarUrl: null } }] };
  const row = { id: "legacy", conversationId: "conv", senderId: "alice", type: "text", timestamp: now,
    expiresAt: now + 60_000, expiryKind: "retention" } as const;
  const failed = { ...row, ownerId: "bob", status: "failed", content: "" } as const;
  await db.put("legacyMessages", { ...row, content: "recovered text", status: "delivered" });
  await db.put("legacyMessages", { ...row, id: "unverified", content: "other cached row", status: "delivered" });
  await saveMessage(failed);
  useChatStore.getState().setMessages("conv", [failed]);
  vi.mocked(api.post).mockResolvedValueOnce({ ids: [row.id] });
  expect(await restoreVerifiedLegacyHistory(conversation, () => true)).toBe(1);
  expect(api.post).toHaveBeenCalledWith("/api/messages/history-ownership?purpose=local", expect.objectContaining({ messages: expect.any(Array) }));
  await refreshImportedConversationMessages(conversation.id);
  expect(useChatStore.getState().messages.get("conv")).toMatchObject([{ id: row.id, content: "recovered text", status: "delivered" }]);
  expect((await exportHistoryTransfer("bob", [conversation])).items).toEqual([]);
});

it("invalidates an archive containing a previous device's deleted message after relinking the same account", async () => {
  const now = Date.now();
  const conversation: ConversationWithMembers = { id: "conv", type: "direct", name: null, avatarUrl: null, invitePolicy: "any_member",
    createdBy: "alice", createdAt: now - 10_000, updatedAt: now, members: [{ conversationId: "conv", userId: "bob", role: "member",
      joinedAt: now - 10_000, acceptedAt: now - 10_000, user: { username: "bob", displayName: "Bob", avatarUrl: null } }] };
  const wire = "prior:previous-device";
  await commitReceivedMessage(wire, { ownerId: "bob", deviceId: "previous-device", direct: true, expiresAt: now + 60_000, message: {
    id: wire, conversationId: "conv", senderId: "alice", type: "text", content: "previous device plaintext",
    timestamp: now - 5_000, status: "delivered", expiresAt: now + 60_000,
  } });
  await clearCryptoState();
  const { candidates, revisions } = await exportHistoryTransfer("bob", [conversation]);
  // The current device's mutation stream has no addressed envelope for this row.
  vi.mocked(api.get).mockResolvedValueOnce({ mutations: [], mutationCursor: 7, mutationHighWater: 7, hasMoreMutations: false });
  vi.mocked(api.post).mockResolvedValueOnce({ deletions: [{ id: wire, conversationId: "conv", senderId: "alice", deletedAt: now, deletedByUserId: "alice" }] });
  await verifyHistoryDisclosure(new Set(["conv"]), () => true, candidates);
  expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/messages/history-deletions", { messages: [{ id: wire, conversationId: "conv", senderId: "alice" }] });
  expect(await getMessageById("prior", "bob")).toMatchObject({ content: "", deletedAt: now });
  expect(await historyArchiveIsCurrent(revisions, true)).toBe(false);
  const rebuilt = await exportHistoryTransfer("bob", [conversation]);
  expect(JSON.stringify(rebuilt.items)).not.toContain("previous device plaintext");
  expect(rebuilt.candidates).toEqual([]);
});

it("filters foreign imports before the page limit and during cross-tab reconciliation", async () => {
  const time = Date.now();
  const db = await getAppDB();
  const tx = db.transaction("displayMessages", "readwrite");
  const row = { conversationId: "conv", senderId: "alice", type: "text", status: "delivered",
    timestamp: time, expiresAt: time + 60_000, importedAt: time, transferSourceId: "wire" };
  await Promise.all([
    ...Array.from({ length: 101 }, (_, i) => tx.store.put({ ...row, id: `foreign-${i}`,
      timestamp: time + 1, ownerId: "alice", content: "private older history" })),
    tx.store.put({ ...row, id: "mine", ownerId: "bob", content: "my imported history" }),
    tx.done,
    db.put("legacyMessages", { ...row, id: "unknown", content: "unowned import" }),
  ]);
  expect(await loadPersistedConversationMessages("conv")).toEqual({ loadedCount: 1, hasOlder: false });
  await reconcileLocalMessageChange("foreign-0");
  await reconcileLocalMessageChange("unknown");
  expect(useChatStore.getState().messages.get("conv")?.map(({ id, content }) => ({ id, content })))
    .toEqual([{ id: "mine", content: "my imported history" }]);
});

it("budgets deletion lookups and retries from its durable continuation after a 429", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const db = await getAppDB();
  const tx = db.transaction(["displayMessages", "accountState"], "readwrite");
  for (let i = 0; i < 120; i++) {
    const id = `owned-${i.toString().padStart(3, "0")}`;
    const row = { id, conversationId: "conv", senderId: "alice", type: "text", status: "delivered",
      content: id, timestamp: now, expiresAt: now + 300_000, ownerId: "bob", transferSourceId: id, importedAt: now };
    await tx.objectStore("displayMessages").put(row);
    await indexImportedDeletion(tx.objectStore("accountState"), row);
  }
  await tx.done;
  vi.mocked(api.post).mockResolvedValueOnce({ deletions: [] }).mockRejectedValueOnce({ status: 429 })
    .mockResolvedValueOnce({ deletions: [] });
  await Promise.all([reconcileImportedHistoryDeletions(), reconcileImportedHistoryDeletions()]);
  expect(api.post).toHaveBeenCalledTimes(1);
  const key = 'history-deletions:["bob","bob-device"]';
  expect(await getSyncState(key)).toMatchObject({ cursorId: importedDeletionPrefix("bob") + "owned-099" });
  now += 30_000;
  await reconcileImportedHistoryDeletions();
  expect(await getSyncState(key)).toMatchObject({ cursorId: importedDeletionPrefix("bob") + "owned-099" });
  await reconcileImportedHistoryDeletions();
  expect(api.post).toHaveBeenCalledTimes(2);
  now += 30_000;
  await reconcileImportedHistoryDeletions();
  const batches = vi.mocked(api.post).mock.calls.map(([, body]) => (body as { messages: { id: string }[] }).messages);
  expect(batches.map((batch) => batch.length)).toEqual([100, 20, 20]);
  expect(batches[1][0].id).toBe("owned-100");
  expect(batches[2]).toEqual(batches[1]);
  expect((await getSyncState(key))?.cursorId).toBeUndefined();
  expect(await getSyncState("message-mutations:bob:bob-device")).toBeUndefined();
});

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
    await saveCommittedMessage({ id: "saved", conversationId: "conv", senderId: "alice", type: "text", content: "original", timestamp: 1, expiresAt: null, status: "read" });
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

  it.each([["sending", "sent"], ["failed", "sent"], ["delivered", "delivered"], ["read", "read"]])(
    "treats a sender-targeted key confirmation as acceptance when previously %s", async (previous, status) => {
      const echo = { ...frame("echo", 200), senderId: "bob", senderDeviceId: "bob-device", recipientDeviceId: "bob-device",
        header: JSON.stringify({ recipientDeviceId: "alice-device", editKey: { nonce: "x".repeat(16), ciphertext: "x".repeat(107) } }),
        editKeyAccepted: true };
      await saveMessage({ id: echo.id, conversationId: echo.conversationId, senderId: echo.senderId, type: "text", content: "sent locally",
        timestamp: 100, expiresAt: null, status: previous, editKey: "A".repeat(43), editSigningKey: "signing-key", editSenderDeviceId: echo.senderDeviceId });
      await ingestMessageFrame(echo);
      expect(decryptMessage).not.toHaveBeenCalled();
      expect(await getMessageById(echo.id)).toMatchObject({ status, editKeyAccepted: true, timestamp: 200 });
      expect(useChatStore.getState().messages.get(echo.conversationId)).toMatchObject([{ id: echo.id, status, editKeyAccepted: true }]);
    },
  );

  it.each([true, false])("reconciles the local key from the accepted echo after a legacy drain (%s)", async (keyed) => {
    const echo = frame("echo", 200);
    const local = { id: echo.id, conversationId: "conv", senderId: "bob", type: "text", content: "sent locally", timestamp: 200,
      expiresAt: echo.expiresAt, expiryKind: "retention" as const, status: "delivered", editKey: "A".repeat(43),
      editSigningKey: "signing-key", editSenderDeviceId: "bob-device" };
    await saveMessage(local);
    await loadPersistedConversationMessages("conv");
    const header = keyed ? JSON.stringify({ editKey: { nonce: "x".repeat(16), ciphertext: "x".repeat(107) } }) : "{}";
    await ingestMessageFrame({ ...echo, senderId: "bob", senderDeviceId: "bob-device", header, editKeyAccepted: keyed });
    expect(decryptMessage).not.toHaveBeenCalled();
    const stored = await getMessageById(echo.id, "bob", undefined, true);
    const displayed = useChatStore.getState().messages.get("conv")?.[0];
    if (keyed) {
      expect(stored).toMatchObject({ editKeyAccepted: true, editKey: local.editKey });
      expect(displayed).toMatchObject({ editKeyAccepted: true });
    } else {
      expect(stored?.editKey).toBeUndefined();
      expect(displayed?.editKeyAccepted).toBeUndefined();
      expect(await (await getAppDB()).get("accountState", `message-edit-state:${JSON.stringify(["bob", echo.id])}`)).toBeUndefined();
    }
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
    await saveCommittedMessage({ id: "saved", conversationId: "conv", senderId: "alice", type: "text", content: "original", timestamp: 200, expiresAt: saved.expiresAt, expiryKind: "retention", status: "read" });
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
  it("redacts a quarantined direct sibling before checkpointing a deletion of an already hidden message", async () => {
    const db = await getAppDB();
    useChatStore.setState({ conversations: [] });
    const original = frame("hidden-legacy");
    await db.put("legacyMessages", { id: "hidden-legacy:old-device", conversationId: "conv", senderId: "alice", type: "file",
      content: '{"fileId":"removed-file","fileKey":"previous device file key"}', timestamp: original.timestamp,
      expiresAt: original.expiresAt, status: "delivered" });
    await db.put("accountState", { id: messageHideKey(original.id, "bob"), ownerId: "bob" });
    vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false, mutations: [
      { ...original, deletedAt: 300, deletedByUserId: "alice", mutationSeq: 1 },
    ], mutationCursor: 1, hasMoreMutations: false });
    await syncMessages({ force: true });
    expect(await db.get("legacyMessages", "hidden-legacy:old-device")).toMatchObject({ content: "", deletedAt: 300 });
    expect(await getMessageById(original.id, "bob")).toBeUndefined();
    expect(await getSyncState("message-mutations:bob:bob-device")).toMatchObject({ value: 1 });
  });
  it("clears file keys, local decrypted file cache, and store content on a realtime deletion", async () => {
    const { handleMessageDeletion } = await import("./message-sync.js");
    const db = await getAppDB();
    const attachment = { id: "file-message", conversationId: "conv", senderId: "alice", type: "file", content: JSON.stringify({ fileId: "private-file", fileKey: "key", iv: "iv" }), timestamp: 100, expiresAt: Date.now() + 60_000, expiryKind: "retention" as const, status: "delivered" };
    await saveMessage(attachment);
    await db.put("accountFiles", { id: "private-file", blob: new Blob(["decrypted"]) });
    await loadPersistedConversationMessages("conv");
    await handleMessageDeletion({ conversationId: "conv", deletion: { ids: [attachment.id], deletedAt: 300, deletedByUserId: "alice" } });
    expect(await db.get("accountFiles", "private-file")).toBeUndefined();
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
    const local = { ownerId: "bob", id: "hidden", conversationId: "conv", senderId: "alice", type: "file", content: JSON.stringify({ fileId: "private-file", fileKey: "key" }), timestamp: 100, expiresAt: Date.now() + 60_000, expiryKind: "retention" as const, status: "delivered" };
    await saveCommittedMessage(local);
    await db.put("accountFiles", { id: "private-file", blob: new Blob(["private"]) });
    await loadPersistedConversationMessages("conv");
    await deleteMessageForLocalUserOnly("conv", "hidden");
    expect(useChatStore.getState().messages.get("conv")).toEqual([]);
    expect(await db.get("accountFiles", "private-file")).toBeUndefined();
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
  await commitReceivedMessage("cross-tab", { ownerId: "bob", deviceId: "bob-device", expiresAt: Date.now() + 60_000, message: { id: "cross-tab", conversationId: "conv", senderId: "alice", type: "text", content: "must be removed", timestamp: 100, expiresAt: Date.now() + 60_000, status: "delivered" } }, { session: { id: "session", state: "advanced ratchet", updatedAt: 100 } });
  expect(await getMessageById("cross-tab")).toMatchObject({ content: "", deletedAt: 300 });
  expect((await (await getAppDB()).get("receiveSessions", "session"))?.state).toBe("advanced ratchet");
});

it.each([
  { userId: "bob", deviceId: "bob-device", displayId: "logical" },
  { userId: "alice", deviceId: "recipient-1", displayId: "logical" },
  { userId: "alice", deviceId: "recipient-2", displayId: "logical:recipient-2" },
  { userId: "bob", deviceId: "sender-other", displayId: "logical:sender-other" },
])("maps direct tombstones to one display bubble on $deviceId", async ({ userId, deviceId, displayId }) => {
  const { useAuthStore } = await import("../stores/authStore.js");
  vi.spyOn(useAuthStore, "getState").mockReturnValue({ user: { id: userId }, device: { id: deviceId } } as never);
  const original = { id: displayId, ownerId: userId, direct: true, conversationId: "conv", senderId: "bob", type: "text", content: "private", timestamp: 100, expiresAt: Date.now() + 60_000, expiryKind: "retention" as const, status: "delivered" };
  await saveMessage(original);
  await loadPersistedConversationMessages("conv");
  const ids = ["logical", "logical:recipient-2", "logical:sender-other"];
  for (const id of ids) await ingestMessageFrame({ ...frame(id), senderId: "bob", senderDeviceId: "bob-device", ciphertext: "", header: "", iv: "", deletedAt: 300, deletedByUserId: "bob" });
  const displayed = useChatStore.getState().messages.get("conv");
  expect(displayed).toHaveLength(1);
  expect(displayed![0]).toMatchObject({ id: "logical", content: "", deletedAt: 300 });
  expect(await simulateReload()).toHaveLength(1);
  expect((await (await getAppDB()).getAll("displayMessages"))).toHaveLength(1);
  expect(decryptMessage).not.toHaveBeenCalled();
});
it("ignores unknown local tombstone echoes for every direct fanout envelope", async () => {
  for (const id of ["unknown", "unknown:other-device"]) await ingestMessageFrame({ ...frame(id), senderId: "bob", senderDeviceId: "bob-device", deletedAt: 300 });
  expect(useChatStore.getState().messages.get("conv") ?? []).toEqual([]);
  expect(await (await getAppDB()).getAll("displayMessages")).toEqual([]);
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
  expect(useChatStore.getState().messages.get("conv")![0]).toMatchObject({ id: "new-logical", content: "", deletedAt: 300 });
});

describe("delete for me Undo", () => {
  const local = () => ({ ownerId: "bob", id: "undo-file", conversationId: "conv", senderId: "alice", type: "file", content: JSON.stringify({ fileId: "undo-attachment", fileKey: "secret", iv: "secret-iv" }), timestamp: 100, expiresAt: Date.now() + 60_000, expiryKind: "retention" as const, status: "delivered" });
  async function prepare() {
    const message = local();
    await saveCommittedMessage(message);
    const db = await getAppDB();
    await db.put("accountFiles", { id: "undo-attachment", blob: new Blob(["private"]) });
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
    expect(await getMessages("conv", 100, "bob")).toEqual([]);
    expect((await getMessageById(message.id))?.content).toBe(message.content);
    expect(await db.get("accountFiles", "undo-attachment")).toBeDefined();
    expect(await undo!()).toBe(true);
    expect((await simulateReload())[0].content).toBe(message.content);
    expect(await db.get("accountState", messageHideKey(message.id, "bob"))).toBeUndefined();
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
    expect(await db.get("accountFiles", "undo-attachment")).toBeUndefined();
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
    expect(await db.get("accountState", messageHideKey(message.id, "bob"))).toMatchObject({ undoDeadline: deadline });
    const tabB = await openDB(db.name);
    try {
      vi.setSystemTime(deadline - 1);
      await commitAbandonedMessageHides(tabB);
      expect(await tabB.get("displayMessages", ["bob", message.id])).toBeDefined();
      expect(await tabB.get("accountFiles", "undo-attachment")).toBeDefined();
      expect(await getMessages("conv", 100, "bob")).toEqual([]);
      expect(await undo!()).toBe(true);
      expect((await getMessageById(message.id))?.content).toBe(message.content);
      expect(await tabB.get("accountState", messageHideKey(message.id, "bob"))).toBeUndefined();
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
      expect((await reopened.get("displayMessages", ["bob", message.id]))?.content).toBe(message.content);
      expect(await reopened.get("accountFiles", "undo-attachment")).toBeDefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(await reopened.get("displayMessages", ["bob", message.id])).toBeUndefined();
      expect(await reopened.get("accountFiles", "undo-attachment")).toBeUndefined();
      expect(await reopened.get("accountState", messageHideKey(message.id, "bob"))).toEqual({ id: messageHideKey(message.id, "bob"), messageId: message.id, ownerId: "bob" });
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
      expect(await db.get("displayMessages", ["bob", message.id])).toBeDefined();
    } finally { restore(); }
    await vi.advanceTimersByTimeAsync(30_000);
    await commitAbandonedMessageHides(db);
    expect(await db.get("displayMessages", ["bob", message.id])).toBeUndefined();
    expect(await db.get("accountFiles", "undo-attachment")).toBeUndefined();
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
      expect(await reloaded.get("displayMessages", ["bob", message.id])).toBeUndefined();
      expect(await reloaded.get("accountFiles", "undo-attachment")).toBeUndefined();
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
    expect(await db.get("accountFiles", "undo-attachment")).toBeUndefined();
    expect(await undo!()).toBe(true);
    expect((await simulateReload())[0]).toMatchObject({ content: "", deletedAt: 300 });
  });
});

it("applies mutations even on an empty message page and persists a separate account/device cursor", async () => {
  await ingestMessageFrame(frame("old", 100));
  await saveSyncState(syncStateId, 10_000, "newer");
  const mutation = { ...frame("old", 100), ciphertext: "", deletedAt: 200, deletedByUserId: "alice", mutationSeq: 7 };
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false, mutations: [mutation], editStream: true, hasMoreMutations: false });
  await syncMessages({ force: true });
  expect(await getMessageById("old")).toMatchObject({ content: "", deletedAt: 200 });
  expect((await getSyncState(syncStateId))?.value).toBe(10_000);
  expect((await getSyncState("message-mutations-edits:bob:bob-device"))?.value).toBe(7);
  resetMessageSyncState();
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false, mutations: [], editStream: true, hasMoreMutations: false });
  await syncMessages({ force: true });
  expect(requestParams(1).get("editSince")).toBe("7");
});
it("paginates mutations independently and never advances the global mutation cursor from conversation backfill", async () => {
  const mutation = (id: string, mutationSeq: number) => ({ ...frame(id), deletedAt: 200, deletedByUserId: "alice", mutationSeq });
  vi.mocked(api.get).mockResolvedValueOnce({ messages: [], hasMore: false, editStream: true, mutations: [mutation("one", 1)], hasMoreMutations: true })
    .mockResolvedValueOnce({ messages: [], hasMore: false, editStream: true, mutations: [mutation("two", 2)], hasMoreMutations: false });
  await syncMessages({ force: true });
  expect(requestParams(1).get("editSince")).toBe("1");
  expect((await getSyncState("message-mutations-edits:bob:bob-device"))?.value).toBe(2);
  vi.mocked(api.get).mockResolvedValueOnce({ messages: [], hasMore: false, editStream: true, mutations: [mutation("backfill", 99)], hasMoreMutations: false });
  await syncMessages({ conversationId: "conv", since: 0 });
  expect((await getSyncState("message-mutations-edits:bob:bob-device"))?.value).toBe(2);
});

it.each([true, false])("checkpoints and drains deletion pages despite a retryable ordinary failure (edit stream=%s)", async (editStream) => {
  const cursorId = `${editStream ? "message-mutations-edits" : "message-mutations"}:bob:bob-device`;
  const queryCursor = editStream ? "editSince" : "mutationSince";
  await saveSyncState(syncStateId, 50, "known");
  for (const id of ["deleted-first", "deleted-second"]) {
    await saveMessage({ id, conversationId: "conv", senderId: "alice", type: "text", content: "Erase this", timestamp: 10, expiresAt: null, status: "read" });
  }
  const broken = frame("blocked", 100);
  const mutation = (id: string, mutationSeq: number) => ({ ...frame(id), deletedAt: 200, deletedByUserId: "alice", mutationSeq });
  vi.mocked(api.get).mockResolvedValueOnce({
    editStream, messages: [broken], hasMore: true, mutations: [mutation("deleted-first", 1)], mutationCursor: 1, hasMoreMutations: true,
  }).mockResolvedValueOnce({
    editStream, messages: editStream ? [] : [broken], hasMore: !editStream,
    mutations: [mutation("deleted-second", 2)], mutationCursor: 2, hasMoreMutations: false,
  }).mockResolvedValueOnce({ editStream, messages: [broken], hasMore: false, mutations: [], mutationCursor: 2 });
  vi.mocked(decryptMessage).mockImplementationOnce(async () => {
    expect(await getSyncState(cursorId)).toMatchObject({ value: 1 });
    throw new DOMException("Ordinary message write failed", "QuotaExceededError");
  });

  await expect(syncMessages({ force: true })).rejects.toThrow("Ordinary message write failed");
  expect(decryptMessage).toHaveBeenCalledTimes(1);
  expect(requestParams(1).get("mutationsOnly")).toBe("1");
  expect(requestParams(1).get(queryCursor)).toBe("1");
  for (const id of ["deleted-first", "deleted-second"]) {
    expect(await getMessageById(id)).toMatchObject({ content: "", deletedAt: 200 });
  }
  expect(await getSyncState(cursorId)).toMatchObject({ value: 2 });
  expect(await getSyncState(syncStateId)).toMatchObject({ value: 50, cursorId: "known" });
  await syncMessages({ force: true });
  expect(requestParams(2).get(queryCursor)).toBe("2");
  expect(await getSyncState(syncStateId)).toMatchObject({ value: 100, cursorId: "blocked" });
});

it("does not regress the account/device mutation cursor when another tab finishes an older page", async () => {
  const { advanceMutationCursor } = await import("../db/index.js");
  const id = "message-mutations-edits:bob:bob-device";
  await Promise.all([advanceMutationCursor(id, 9), advanceMutationCursor(id, 4)]);
  expect((await getSyncState(id))?.value).toBe(9);
  expect(await getSyncState("message-mutations-edits:other:bob-device")).toBeUndefined();
  expect(await getSyncState("message-mutations-edits:bob:other-device")).toBeUndefined();
});

it("resumes both cursors independently through Worker rollback and upgrade", async () => {
  const scope = "bob:bob-device";
  await saveSyncState(`message-mutations-edits:${scope}`, 19);
  await saveSyncState(`message-mutations:${scope}`, 5);
  vi.mocked(api.get).mockResolvedValueOnce({
    messages: [], hasMore: false, mutations: [], mutationCursor: 40,
  }).mockResolvedValueOnce({
    messages: [], hasMore: false, mutations: [], mutationCursor: 23, editStream: true,
  });
  await syncMessages({ force: true });
  expect(requestParams(0).get("mutationSince")).toBe("5");
  expect(requestParams(0).get("editSince")).toBe("19");
  expect(await getSyncState(`message-mutations-edits:${scope}`)).toMatchObject({ value: 19 });
  await syncMessages({ force: true });
  expect(requestParams(1).get("mutationSince")).toBe("40");
  expect(requestParams(1).get("editSince")).toBe("19");
  expect(await getSyncState(`message-mutations-edits:${scope}`)).toMatchObject({ value: 23 });
});

it("shrinks an oversized sync request and retries with both cursors intact", async () => {
  await saveSyncState(syncStateId, 100, "known");
  await saveSyncState("message-mutations:bob:bob-device", 7);
  await saveSyncState("message-mutations-edits:bob:bob-device", 19);
  vi.mocked(api.get).mockRejectedValueOnce(Object.assign(new Error("Sync page too large"), { status: 413, code: "SYNC_PAGE_TOO_LARGE" }))
    .mockResolvedValueOnce({ messages: [], hasMore: false, mutations: [], editStream: true, mutationCursor: 23 });
  await syncMessages({ force: true });
  expect(requestParams(0).get("limit")).toBe("250");
  expect(requestParams(1).get("limit")).toBe("125");
  for (const [key, value] of Object.entries({ since: "100", sinceId: "known", mutationSince: "7", editSince: "19" })) {
    expect(requestParams(1).get(key)).toBe(value);
  }
  expect(await getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: 23 });
});

it.each([true, false])("tries to drain mutations after an oversized single-row message page (mutations fit=%s)", async (mutationsFit) => {
  await saveSyncState(syncStateId, 100, "known");
  await saveSyncState("message-mutations-edits:bob:bob-device", 19);
  const tooLarge = Object.assign(new Error("Sync page too large"), { status: 413, code: "SYNC_PAGE_TOO_LARGE" });
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (mutationsFit && path.includes("mutationsOnly=1")) {
      return { messages: [], hasMore: false, mutations: [], editStream: true, mutationCursor: 20 };
    }
    throw tooLarge;
  });
  await expect(syncMessages({ force: true })).rejects.toBe(tooLarge);
  expect(vi.mocked(api.get).mock.calls.map((_, index) => requestParams(index).get("limit")))
    .toEqual(["250", "125", "62", "31", "15", "7", "3", "1", "1"]);
  expect(requestParams(7).get("mutationsOnly")).toBeNull();
  expect(requestParams(8).get("mutationsOnly")).toBe("1");
  expect(await getSyncState(syncStateId)).toMatchObject({ value: 100, cursorId: "known" });
  expect(await getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: mutationsFit ? 20 : 19 });
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
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [{ ...frame("old-deleted", 100), deletedAt: 200, deletedByUserId: "alice", mutationSeq: 1 }], hasMoreMutations: false, mutationCursor: 1 });
  await syncMessages({ force: true });
  expect(useChatStore.getState().messages.get("conv")).toEqual([expect.objectContaining({ id: "old-deleted", content: "", deletedAt: 200 })]);
  await loadPersistedConversationMessages("conv");
  expect(useChatStore.getState().messages.get("conv")).toEqual([
    expect.objectContaining({ id: "old-deleted", content: "", deletedAt: 200 }),
    expect.objectContaining({ id: "newer", content: "newer cached content" }),
  ]);
});
it("persists the server's drained high-water cursor even when all mutations were filtered out", async () => {
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false, mutations: [], editStream: true, hasMoreMutations: false, mutationCursor: 5000 });
  await syncMessages({ force: true });
  expect((await getSyncState("message-mutations-edits:bob:bob-device"))?.value).toBe(5000);
  resetMessageSyncState();
  await syncMessages({ force: true });
  expect(requestParams(1).get("editSince")).toBe("5000");
});

it.each([false, true])("pages all 220 cached messages past an injected oldest tombstone (equal timestamps=%s)", async (tied) => {
  const base = { ownerId: "bob", conversationId: "conv", senderId: "alice", type: "text", expiresAt: Date.now() + 60000, expiryKind: "retention", status: "delivered" };
  const db = await getAppDB(), tx = db.transaction("displayMessages", "readwrite");
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
  const db = await getAppDB(); await db.put("accountFiles", { id: "victim-file", blob: new Blob(["private"]) });
  await ingestMessageFrame({ ...frame("victim:suffix"), deletedAt: 300, deletedByUserId: "alice" });
  expect((await getMessageById("victim"))?.content).toBe(victim.content);
  expect(await db.get("accountFiles", "victim-file")).toBeDefined();
  expect(await getMessageById("victim:suffix")).toBeUndefined();
  expect(await db.get("accountState", "deleted-message:victim")).toBeUndefined();
  // Even an exact-ID tombstone/event cannot cross that ownership boundary.
  await ingestMessageFrame({ ...frame("victim"), deletedAt: 400, deletedByUserId: "alice" });
  const { handleMessageDeletion } = await import("./message-sync.js");
  await handleMessageDeletion({ conversationId: "conv", deletion: { ids: ["victim"], deletedAt: 500, deletedByUserId: "alice" } });
  expect((await getMessageById("victim"))?.content).toBe(victim.content);
  expect(await db.get("accountFiles", "victim-file")).toBeDefined();
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

it("keeps the oldest loaded cursor when new history arrives inside the window", async () => {
  const db = await getAppDB();
  const row = { conversationId: "conv", senderId: "alice", ownerId: "bob", type: "text", status: "delivered",
    content: "history", expiresAt: Date.now() + 60_000 };
  const tx = db.transaction("displayMessages", "readwrite");
  await Promise.all([...Array.from({ length: 230 }, (_, i) => tx.store.put({ ...row, id: `m${i}`, timestamp: i + 1 })), tx.done]);
  await loadPersistedConversationMessages("conv");
  await loadOlderPersistedConversationMessages("conv");
  await db.put("displayMessages", { ...row, id: "imported", timestamp: 100, importedAt: Date.now() });
  expect(await refreshImportedConversationMessages("conv")).toMatchObject({ loadedCount: 201, hasOlder: true });
  expect(useChatStore.getState().messages.get("conv")).toHaveLength(201);
  expect(await loadOlderPersistedConversationMessages("conv")).toEqual({ loadedCount: 30, hasOlder: false });
  expect(useChatStore.getState().messages.get("conv")).toHaveLength(231);
});

it("refreshes only the latest visible imported chat preview without opening the chat", async () => {
  const db = await getAppDB();
  const base = { conversationId: "conv", senderId: "alice", type: "text", status: "delivered",
    importedAt: Date.now(), expiresAt: Date.now() + 60_000 };
  await db.put("displayMessages", { ...base, id: "first", timestamp: 1, ownerId: "bob", content: "older copy" });
  await db.put("displayMessages", { ...base, id: "second", timestamp: 2, ownerId: "bob", content: "the preview" });
  await db.put("displayMessages", { ...base, id: "foreign", timestamp: 3, ownerId: "alice", content: "foreign copy" });
  await refreshLatestConversationPreview("conv");
  expect(useChatStore.getState().messages.get("conv")).toEqual([expect.objectContaining({ id: "second", content: "the preview" })]);
});

it("labels only a known, decrypted sticker for the local notification", async () => {
  vi.spyOn(capabilities, "nativeCallNotifications", "get").mockReturnValue(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  useChatStore.setState({ activeConversationId: null, conversations: [{ id: "conv", members: [{ userId: "alice", user: { displayName: "Alice" } }] }] as ConversationWithMembers[] });
  vi.mocked(decryptMessage).mockImplementationOnce((...args) => completeDecrypt("[[sticker:genshin:genshin_hoyolab_21]]", args[2]))
    .mockImplementationOnce((...args) => completeDecrypt("[[sticker:genshin:genshin_hoyolab_818]]", args[2]));
  await ingestMessageFrame(frame("known-sticker", Date.now()));
  await ingestMessageFrame(frame("unknown-sticker", Date.now()));
  expect(vi.mocked(showMessageNotification).mock.calls).toEqual([["Alice", "conv", "sticker"], ["Alice", "conv"]]);
});
