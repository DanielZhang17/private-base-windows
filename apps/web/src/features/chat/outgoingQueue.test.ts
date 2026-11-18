import { setLocalEncryptionKey } from "../../lib/local-key-encryption.js";
import { connectLocalMessageChannel } from "../../lib/local-message-changes.js";
import { handleMessageDeletion, startLocalHiddenMessageSync } from "../../lib/message-sync.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encryptMessageEdit, generateAESKey, generateIdentityKeyPair, toBase64Url } from "@e2ee-chat/crypto";
import { beginMessageHide, cleanupExpiredMessages, deleteOutgoing, finishMessageHide, getAppDB, getAllOutgoing, getMessageById, getMessageDeletion, messageHideKey, getMessages, saveMessage as writeOwnedMessage, getOutgoing, getOutgoingOperation, saveQueuedEdit, saveQueuedMessage, updateOutgoingIfPresent, rememberMessageDeletion, type LocalOutgoing } from "../../db/index.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { api } from "../../services/api.js";
import { prepareDirectPayloadFanout } from "../../lib/direct-messages.js";
import { prepareSenderKeyDistribution, finishSenderKeyDistribution } from "../../lib/group-session.js";
import { encryptGroupText } from "../../lib/message-processor.js";
import { stickerToken } from "../../lib/stickers.js";
import { discardOutgoing, getQueueSnapshot, refreshOutgoingQueue, retryOutgoing, startOutgoingQueue, subscribeQueue } from "./outgoingQueue.js";

const saveMessage = (row: Parameters<typeof writeOwnedMessage>[0], current?: () => boolean, ownerId = row.ownerId ?? "alice") =>
  writeOwnedMessage(row, current, ownerId);

vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: null, device: null, accessToken: null, sessionId: null })) };
});
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() }, resolveApiUrl: (path: string) => path }));
vi.mock("../../lib/key-manager.js", () => ({ keysLoaded: () => true }));
vi.mock("../../lib/direct-messages.js", () => ({ prepareDirectPayloadFanout: vi.fn() }));
vi.mock("../../lib/message-processor.js", () => ({ encryptGroupText: vi.fn() }));
vi.mock("../../lib/group-session.js", () => ({ prepareSenderKeyDistribution: vi.fn(async () => null), finishSenderKeyDistribution: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ touchConversationInCache: vi.fn() }));

const body = { conversationId: "chat", type: "text", ttlSeconds: null, fileId: null, messages: [{ id: "message", ciphertext: "ciphertext", iv: "iv", header: "header" }] };
const response = { id: "message", serverTimestamp: 123, expiresAt: 999999, expiryKind: "retention" };
const networkError = () => new TypeError("Failed to fetch");
async function seed(overrides: Partial<LocalOutgoing> = {}) {
  await saveQueuedMessage({ id: "message", conversationId: "chat", senderId: "alice", type: "text", content: "private text", timestamp: Date.now(), expiresAt: Date.now() + 60000, expiryKind: "retention", status: "sending" }, {
    id: "message", queuedAt: 1, conversationId: "chat", conversationType: "direct", userId: "alice", deviceId: "device", ttlSeconds: null, attempts: 0,
    status: "sending", retryable: true, error: null, nextAttemptAt: null, steps: [], ...overrides,
  });
}
async function queueText(id: string, queuedAt: number) {
  await saveQueuedMessage({ ...(await getMessageById("message"))!, id, type: "text", content: id, status: "sending" }, {
    ...(await getOutgoing("message", "alice"))!, id, queuedAt, steps: [], upload: undefined, fileId: undefined,
    sendDispatched: false, attempts: 0, status: "sending", retryable: true, nextAttemptAt: null, error: null,
  });
}
beforeEach(async () => {
  setLocalEncryptionKey(await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
  vi.clearAllMocks();
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  useAuthStore.setState({ user: { id: "alice" }, device: { id: "device" }, accessToken: "token", sessionId: "session" } as never);
  useChatStore.setState({ messages: new Map(), outgoingRemovalNotices: new Set() });
  vi.mocked(api.get).mockResolvedValue({ id: "chat", type: "direct", members: [] } as never);
  vi.mocked(prepareDirectPayloadFanout).mockResolvedValue(body as never);
  vi.mocked(prepareSenderKeyDistribution).mockResolvedValue(null);
  vi.mocked(encryptGroupText).mockResolvedValue({ ciphertext: "group-ciphertext", iv: "iv", header: "header" });
  vi.mocked(api.post).mockResolvedValue(response as never);
  vi.mocked(api.put).mockResolvedValue({ success: true } as never);
});

it("keeps the same outbox and display ID independent across accounts", async () => {
  await seed();
  await saveQueuedMessage({ ...(await getMessageById("message", "alice"))!, senderId: "bob", content: "Bob's pending text" },
    { ...(await getOutgoing("message", "alice"))!, userId: "bob", deviceId: "other-device" });
  await retryOutgoing("message");
  expect(await getOutgoing("message", "alice")).toBeUndefined();
  expect(await getOutgoing("message", "bob")).toMatchObject({ status: "sending", userId: "bob" });
  expect(await getMessageById("message", "alice")).toMatchObject({ status: "sent", content: "private text" });
  expect(await getMessageById("message", "bob")).toMatchObject({ status: "sending", content: "Bob's pending text" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const editBodies = new Map<string, import("@e2ee-chat/shared").MessageEditRequest>();
function editBody(messageId = "original") { return editBodies.get(messageId)!; }
async function seedEdit(conversationType: LocalOutgoing["conversationType"] = "direct", id = "edit", targetId = "original") {
  const key = generateAESKey(), identity = await generateIdentityKeyPair();
  const scope = { messageId: targetId, conversationId: "chat", senderId: "alice", senderDeviceId: "device" };
  editBodies.set(targetId, { messageId: targetId, conversationId: "chat", editSeq: 1,
    ...await encryptMessageEdit(key, identity.privateEd25519, scope, 1, "after") });
  const message = { id: targetId, conversationId: "chat", senderId: "alice", type: "text", content: "before",
    editKey: toBase64Url(key), editSigningKey: toBase64Url(identity.publicEd25519), editSenderDeviceId: "device", editKeyAccepted: true,
    timestamp: Date.now(), expiresAt: Date.now() + 60_000, expiryKind: "retention" as const, status: "sent" };
  await saveMessage(message);
  const row: LocalOutgoing & { editTargetId: string } = {
    id, editTargetId: message.id, queuedAt: Date.now(), conversationId: "chat", conversationType,
    userId: "alice", deviceId: "device", ttlSeconds: null, attempts: 0, status: "sending",
    retryable: true, error: null, nextAttemptAt: null, steps: [{ path: "/api/messages/edit", body: editBody(targetId), sendDispatched: false }],
  };
  await saveQueuedEdit(row, (await getMessageById(message.id, "alice", undefined, true))!.editKeyVersion!, "after", () => true);
  return message;
}

it("queues a text edit at its enqueue time without reading earlier upload bodies", async () => {
  const laterTime = Date.now() + 60_000;
  await seed({ queuedAt: laterTime, upload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" } });
  const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
  try {
    await seedEdit();
    expect(getAll).not.toHaveBeenCalled();
    expect((await getOutgoingOperation("edit"))?.queuedAt).toBeLessThan(laterTime);
  } finally { getAll.mockRestore(); }
});

it("orders an ordinary send without reading queued edit envelopes", async () => {
  await seed({ queuedAt: 20 });
  await seedEdit();
  const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
  try {
    await queueText("second", 2);
    expect((await getOutgoing("second", "alice"))?.queuedAt).toBe(21);
    const ranges = getAll.mock.calls.map(([range]) => range as IDBKeyRange);
    expect(ranges.filter((range) => range.includes('outgoing-account:["alice","message"]'))).toHaveLength(1);
    expect(ranges.some((range) => range.includes('outgoing-edit:["alice","edit"]'))).toBe(false);
  } finally { getAll.mockRestore(); }
});

it.each(["direct", "group"] as const)("queues an optimistic %s edit and retries its original ciphertext independently", async (kind) => {
  const message = await seedEdit(kind);
  expect(await getMessageById(message.id)).toMatchObject({ content: "before", pendingEdit: { id: "edit", content: "after" } });
  expect(await (await getAppDB()).get("accountState", "outgoing:edit")).toBeUndefined();
  const receipt = { editedAt: Date.now(), mutationSeq: 7, editSeq: 1 };
  vi.mocked(api.post).mockRejectedValueOnce(networkError()).mockResolvedValueOnce(receipt);
  await retryOutgoing("edit");
  expect(await getOutgoingOperation("edit")).toMatchObject({ status: "failed", retryable: true, sendDispatched: true });
  expect(JSON.stringify(await getOutgoingOperation("edit"))).not.toContain("after");
  await retryOutgoing("edit");
  expect(vi.mocked(api.post).mock.calls).toEqual(Array(2).fill(["/api/messages/edit", editBody()]));
  expect(api.get).not.toHaveBeenCalled();
  expect(prepareDirectPayloadFanout).not.toHaveBeenCalled();
  expect(prepareSenderKeyDistribution).not.toHaveBeenCalled();
  expect(encryptGroupText).not.toHaveBeenCalled();
  expect(await getOutgoingOperation("edit")).toBeUndefined();
  expect(await getMessageById(message.id)).toMatchObject({
    content: "after", pendingEdit: null, status: "sent", timestamp: message.timestamp,
    expiresAt: message.expiresAt, editedAt: receipt.editedAt, editSequence: 1,
  });
});

it("keeps a deletion when the edit receipt arrives later", async () => {
  const message = await seedEdit();
  vi.mocked(api.post).mockImplementationOnce(async () => {
    await rememberMessageDeletion(message.id, "chat", Date.now(), "alice");
    return { editedAt: Date.now(), mutationSeq: 7, editSeq: 1 } as never;
  });
  await retryOutgoing("edit");
  expect(await getOutgoingOperation("edit")).toBeUndefined();
  expect(await getMessageById(message.id)).toMatchObject({ content: "", deletedByUserId: "alice" });
  expect(await getMessageById(message.id)).not.toHaveProperty("pendingEdit");
});

it("publishes the newer cached chat-list preview when an older edit receipt resumes after reload", async () => {
  const original = await seedEdit();
  await saveMessage({ id: "newest", conversationId: "chat", senderId: "bob", type: "text", content: "newer message",
    timestamp: original.timestamp + 1, expiresAt: original.expiresAt, expiryKind: "retention", status: "delivered" });
  expect(useChatStore.getState().messages.get("chat")).toBeUndefined();
  vi.mocked(api.post).mockResolvedValueOnce({ editedAt: Date.now(), mutationSeq: 7, editSeq: 1 });
  await retryOutgoing("edit");
  expect(await getMessageById(original.id)).toMatchObject({ content: "after", editSequence: 1 });
  expect(useChatStore.getState().messages.get("chat")).toMatchObject([{ id: "newest", content: "newer message", timestamp: original.timestamp + 1 }]);
});

it.each(["pending", "failed", "locally hidden"])("retires a %s edit on Delete for everyone and refreshes the local queue", async (state) => {
  const original = await seedEdit();
  const stop = startLocalHiddenMessageSync(refreshOutgoingQueue);
  try {
    if (state === "failed") {
      vi.mocked(api.post).mockRejectedValueOnce(Object.assign(new Error("Encrypted edit is too large"), { status: 413 }));
      await retryOutgoing("edit");
      expect(await getOutgoingOperation("edit")).toMatchObject({ status: "failed", retryable: false });
    } else if (state === "locally hidden") {
      const hide = await beginMessageHide(original.id);
      await finishMessageHide(original.id, hide!.token, false, undefined, "alice");
      expect(await getMessageById(original.id)).toBeUndefined();
    }
    await refreshOutgoingQueue("edit");
    expect(getQueueSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "edit" })]));
    const deletion = { ids: [original.id], deletedAt: Date.now(), deletedByUserId: "alice" };
    await handleMessageDeletion({ conversationId: "chat", deletion });
    expect(await getOutgoingOperation("edit")).toBeUndefined();
    expect(await (await getAppDB()).get("accountState", 'outgoing-edit-status:["alice","edit"]')).toBeUndefined();
    await vi.waitFor(() => expect(getQueueSnapshot().some((row) => row.id === "edit")).toBe(false));
    if (state === "locally hidden") expect(await getMessageById(original.id)).toBeUndefined();
    else expect(await getMessageById(original.id)).toMatchObject({ content: "", deletedAt: deletion.deletedAt });
    expect(api.post).toHaveBeenCalledTimes(state === "failed" ? 1 : 0);
  } finally { stop(); }
});

it("uses only the tombstone's target range once earlier v5 edits are indexed", async () => {
  await seedEdit();
  await seedEdit("direct", "other-edit", "original-other");
  const db = await getAppDB();
  const target = 'outgoing-edit-target:["alice","original"]:edit';
  const otherTarget = 'outgoing-edit-target:["alice","original-other"]:other-edit';
  // Simulate a pre-release v5 queue whose edit records predate the target lookup.
  await db.delete("accountState", "outgoing-edit-target-index-v1");
  await db.delete("accountState", target);
  await db.delete("accountState", otherTarget);
  await rememberMessageDeletion("unrelated", "chat", Date.now(), "bob", "bob", undefined, "alice");
  expect(await db.get("accountState", target)).toBeDefined();
  expect(await db.get("accountState", otherTarget)).toBeDefined();

  const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
  const getAllKeys = vi.spyOn(IDBObjectStore.prototype, "getAllKeys");
  try {
    await handleMessageDeletion({ conversationId: "chat", deletion: { ids: ["original"], deletedAt: Date.now(), deletedByUserId: "alice" } });
    expect(getAll).toHaveBeenCalled();
    const ranges = getAll.mock.calls.map(([range]) => range as IDBKeyRange);
    expect(ranges.some((range) => range.includes(target))).toBe(true);
    expect(ranges.some((range) => range.includes(otherTarget) || range.includes('outgoing-edit:["alice","edit"]'))).toBe(false);
    expect(getAllKeys).not.toHaveBeenCalled();
    expect(await db.get("accountState", target)).toBeUndefined();
    expect(await getOutgoingOperation("edit")).toBeUndefined();
    expect(await getOutgoingOperation("other-edit")).toBeDefined();
  } finally { getAll.mockRestore(); getAllKeys.mockRestore(); }
});

it.each([true, false])("retires a failed edit on expiry and refreshes the queue (locally hidden=%s)", async (hidden) => {
  const original = await seedEdit();
  vi.mocked(api.post).mockRejectedValueOnce(Object.assign(new Error("Encrypted edit is too large"), { status: 413 }));
  const stop = startLocalHiddenMessageSync(refreshOutgoingQueue);
  try {
    await retryOutgoing("edit");
    expect(getQueueSnapshot()).toMatchObject([{ id: "edit", status: "failed", retryable: false }]);
    if (hidden) {
      const hide = await beginMessageHide(original.id);
      await finishMessageHide(original.id, hide!.token, false, undefined, "alice");
      expect(await getOutgoingOperation("edit")).toBeDefined();
    }
    await cleanupExpiredMessages(original.expiresAt + 1);
    const db = await getAppDB();
    for (const id of ['outgoing-edit:["alice","edit"]', 'outgoing-edit-status:["alice","edit"]', 'outgoing-edit-target:["alice","original"]:edit', 'message-edit-state:["alice","original"]']) {
      expect(await db.get("accountState", id)).toBeUndefined();
    }
    expect(await getMessageById(original.id)).toBeUndefined();
    await vi.waitFor(() => expect(getQueueSnapshot()).toEqual([]));
    expect(api.post).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it.each(["local hide", "expiry", "delete for everyone"])("retries a hidden prepared edit only after a local hide (%s)", async (outcome) => {
  const message = await seedEdit();
  vi.mocked(api.post).mockRejectedValueOnce(networkError());
  await retryOutgoing("edit");
  expect(await getOutgoingOperation("edit")).toMatchObject({ status: "failed", retryable: true });
  const hide = await beginMessageHide(message.id);
  await finishMessageHide(message.id, hide!.token, false, undefined, "alice");
  const db = await getAppDB();
  expect(await db.get("accountState", `message-edit-state:${JSON.stringify(["alice", message.id])}`)).toBeUndefined();
  expect(await getMessageById(message.id)).toBeUndefined();
  if (outcome === "expiry") await cleanupExpiredMessages(message.expiresAt + 1);
  if (outcome === "delete for everyone") await rememberMessageDeletion(message.id, "chat", Date.now(), "alice");

  if (outcome === "local hide") vi.mocked(api.post).mockResolvedValueOnce({ editedAt: Date.now(), mutationSeq: 7, editSeq: 1 });
  await retryOutgoing("edit");
  expect(api.post).toHaveBeenCalledTimes(outcome === "local hide" ? 2 : 1);
  for (const call of vi.mocked(api.post).mock.calls) expect(call).toEqual(["/api/messages/edit", editBody()]);
  expect(await getOutgoingOperation("edit")).toBeUndefined();
  expect(await getMessages("chat")).toEqual([]);
  expect(await getMessageById(message.id)).toBeUndefined();
  expect(useChatStore.getState().messages.get("chat") ?? []).toEqual([]);
});

it("restores committed text when a queued edit is discarded", async () => {
  const message = await seedEdit();
  await discardOutgoing("edit");
  expect(await getOutgoingOperation("edit")).toBeUndefined();
  expect(await getMessageById(message.id)).toMatchObject({ content: "before" });
  expect((await getMessageById(message.id))?.pendingEdit).toBeFalsy();
  expect(api.post).not.toHaveBeenCalled();
});

it.each(["during hide", "after Undo"])("keeps the in-flight edit when its acknowledgement arrives %s", async (timing) => {
  const message = await seedEdit();
  let sendReceipt!: () => void, reachedPost!: () => void;
  const ready = new Promise<void>((resolve) => { reachedPost = resolve; });
  const waiting = new Promise<void>((resolve) => { sendReceipt = resolve; });
  vi.mocked(api.post).mockImplementationOnce(async () => {
    reachedPost();
    await waiting;
    return { editedAt: Date.now(), mutationSeq: 7, editSeq: 1 } as never;
  });
  const posting = retryOutgoing("edit");
  await ready;
  const hide = await beginMessageHide(message.id);
  expect(await getMessages("chat")).toEqual([]);
  if (timing === "after Undo") {
    const restored = await finishMessageHide(message.id, hide!.token, true, undefined, "alice");
    expect(restored?.pendingEdit?.content).toBe("after");
  }
  sendReceipt();
  await posting;
  if (timing === "during hide") {
    expect(await getMessages("chat")).toEqual([]);
    await finishMessageHide(message.id, hide!.token, true, undefined, "alice");
  }
  expect(await getMessageById(message.id, "alice", undefined, true)).toMatchObject({ content: "after", editKey: message.editKey, editSequence: 1 });
  expect(await getOutgoingOperation("edit")).toBeUndefined();
});

it.each([
  { scenario: "recovers a pending text edit after a legacy rewrite", sticker: false, legacyRewrite: true },
  { scenario: "discards a queued sticker replacement on receipt", sticker: true, legacyRewrite: false },
  { scenario: "discards a queued sticker replacement recovered after a legacy rewrite", sticker: true, legacyRewrite: true },
])("$scenario", async ({ sticker, legacyRewrite }) => {
  const key = generateAESKey(), identity = await generateIdentityKeyPair();
  const scope = { messageId: "mine", conversationId: "chat", senderId: "alice", senderDeviceId: "device" };
  const legacy = { id: scope.messageId, conversationId: scope.conversationId, senderId: scope.senderId,
    type: "text", content: "before", timestamp: Date.now(), expiresAt: Date.now() + 60_000, status: "delivered" };
  await saveMessage({ ...legacy, editKey: toBase64Url(key), editSigningKey: toBase64Url(identity.publicEd25519), editSenderDeviceId: scope.senderDeviceId, editKeyAccepted: true });
  const editSeq = 1;
  const replacement = sticker ? stickerToken("genshin_hoyolab_21") : "pending revision";
  const body = { messageId: scope.messageId, conversationId: scope.conversationId, editSeq,
    ...await encryptMessageEdit(key, identity.privateEd25519, scope, editSeq, replacement) };
  const row: LocalOutgoing & { editTargetId: string } = {
    id: "legacy-race-edit", editTargetId: scope.messageId, queuedAt: Date.now(), conversationId: scope.conversationId,
    conversationType: "direct", userId: scope.senderId, deviceId: scope.senderDeviceId, ttlSeconds: null, attempts: 0,
    status: "sending", retryable: true, error: null, nextAttemptAt: null, steps: [{ path: "/api/messages/edit", body, sendDispatched: false }],
  };
  await saveQueuedEdit(row, (await getMessageById(legacy.id, "alice", undefined, true))!.editKeyVersion!, "pending revision", () => true);
  const db = await getAppDB();
  if (legacyRewrite) await db.put("displayMessages", { ...legacy, ownerId: "alice" });
  else {
    // Simulate the pending display text saved by the pre-merge client.
    await db.put("displayMessages", { ...legacy, ownerId: "alice", pendingEdit: { id: row.id, content: replacement } });
  }
  expect(await getMessages("chat")).toMatchObject([{ pendingEdit: { id: row.id, content: replacement } }]);
  vi.mocked(api.post).mockResolvedValueOnce({ editedAt: Date.now(), mutationSeq: 7, editSeq });
  await retryOutgoing(row.id);
  expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/messages/edit", body);
  expect(await getOutgoingOperation(row.id)).toBeUndefined();
  expect(await getMessageById(legacy.id)).toMatchObject({ content: sticker ? "before" : replacement, pendingEdit: null });
  const edits = await db.get("accountState", `message-edit-state:${JSON.stringify(["alice", legacy.id])}`);
  expect(edits.editSequence).toBe(sticker ? 0 : editSeq);
  expect(edits.envelope).toEqual(sticker ? undefined : body);
  expect(JSON.stringify(await db.getAll("accountState"))).not.toContain(replacement);
});

it("leaves an oversized edit discardable and releases the following send", async () => {
  await seedEdit();
  await seed({ queuedAt: Date.now() });
  vi.mocked(api.post).mockRejectedValueOnce(Object.assign(new Error("Encrypted edit is too large"), { status: 413, code: "EDIT_TOO_LARGE" }));
  await retryOutgoing("edit");
  expect(await getOutgoingOperation("edit")).toMatchObject({ status: "failed", retryable: false, nextAttemptAt: null });
  await retryOutgoing("message");
  expect(await getMessageById("message")).toMatchObject({ status: "sent" });
  await discardOutgoing("edit");
  expect(await getOutgoingOperation("edit")).toBeUndefined();
  expect(await getMessageById("original")).toMatchObject({ content: "before" });
});

it("tells a second tab to reload failed edit status only after it is durable", async () => {
  await seedEdit();
  vi.stubGlobal("BroadcastChannel", undefined);
  const receivingTab = vi.fn(async () => getOutgoingOperation("edit"));
  const stop = startLocalHiddenMessageSync(async () => { await receivingTab(); });
  const sender = connectLocalMessageChannel({ userId: "alice", deviceId: "device" }, () => {});
  const storage = vi.spyOn(Storage.prototype, "setItem");
  try {
    vi.mocked(api.post).mockRejectedValueOnce(Object.assign(new Error("Encrypted edit is too large"), { status: 413 }));
    await retryOutgoing("edit");
    expect(receivingTab).not.toHaveBeenCalled();
    const [[key, newValue]] = storage.mock.calls;
    const { nonce, ...hint } = JSON.parse(newValue);
    expect(typeof nonce).toBe("string");
    expect(hint).toEqual({ id: "edit", kind: "outbox", conversationId: "chat" });
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    await vi.waitFor(() => expect(receivingTab).toHaveBeenCalledOnce());
    await expect(receivingTab.mock.results[0].value).resolves.toMatchObject({ status: "failed", retryable: false });
  } finally { stop(); sender(); storage.mockRestore(); }
});

it("wakes an idle second tab to send a newly queued edit when its originator does not dispatch it", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const stopQueue = startOutgoingQueue();
  const stopSync = startLocalHiddenMessageSync(refreshOutgoingQueue);
  const sender = connectLocalMessageChannel({ userId: "alice", deviceId: "device" }, () => {});
  const storage = vi.spyOn(Storage.prototype, "setItem");
  try {
    await refreshOutgoingQueue();
    expect(getQueueSnapshot()).toEqual([]);
    const receipt = { editedAt: Date.now(), mutationSeq: 7, editSeq: 1 };
    vi.mocked(api.post).mockResolvedValueOnce(receipt);
    await seedEdit();
    expect(api.post).not.toHaveBeenCalled();
    const hint = storage.mock.calls.find(([, value]) => JSON.parse(value).kind === "outbox")!;
    expect(hint).toBeDefined();
    expect(JSON.parse(hint[1])).toMatchObject({ id: "edit", conversationId: "chat", kind: "outbox" });
    expect(await getOutgoingOperation("edit")).toMatchObject({ status: "sending" });
    window.dispatchEvent(new StorageEvent("storage", { key: hint[0], newValue: hint[1] }));
    await vi.waitFor(async () => expect(await getMessageById("original")).toMatchObject({ content: "after", editSequence: 1 }));
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/messages/edit", editBody());
    expect(await getOutgoingOperation("edit")).toBeUndefined();
  } finally { stopQueue(); stopSync(); sender(); storage.mockRestore(); }
});

it("refreshes only edit metadata for an outbox hint without an active consumer", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  await refreshOutgoingQueue();
  await seed({ upload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" } });
  await seedEdit();
  const stop = startLocalHiddenMessageSync(refreshOutgoingQueue);
  const get = vi.spyOn(IDBObjectStore.prototype, "get");
  const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
  const hint = () => window.dispatchEvent(new StorageEvent("storage", {
    key: 'privatebase:local-messages:["alice","device"]',
    newValue: JSON.stringify({ id: "edit", kind: "outbox", conversationId: "chat", nonce: crypto.randomUUID() }),
  }));
  try {
    hint();
    await vi.waitFor(() => expect(getQueueSnapshot()).toMatchObject([{ id: "edit", status: "sending", steps: [] }]));
    expect(get.mock.calls).toEqual([['outgoing-edit-status:["alice","edit"]']]);
    expect(getAll).not.toHaveBeenCalled();
    await (await getAppDB()).delete("accountState", 'outgoing-edit:["alice","edit"]');
    hint();
    await vi.waitFor(() => expect(getQueueSnapshot()).toEqual([]));
    expect(get.mock.calls).toEqual([['outgoing-edit-status:["alice","edit"]'], ['outgoing-edit-status:["alice","edit"]']]);
    expect(getAll).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  } finally { stop(); get.mockRestore(); getAll.mockRestore(); }
});

it("schedules independent edits with metadata and never reads the waiting attachment payload", async () => {
  await seed({ upload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" }, nextAttemptAt: Date.now() + 60_000 });
  const stop = startOutgoingQueue();
  const get = vi.spyOn(IDBObjectStore.prototype, "get");
  const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
  try {
    await vi.waitFor(() => expect(getQueueSnapshot().find((row) => row.id === "message")?.upload).toBeDefined());
    get.mockClear();
    getAll.mockClear();
    await seedEdit();
    await seedEdit("direct", "other-edit", "other-original");
    // An existing v5 edit is indexed once when its metadata is first needed.
    const db = await getAppDB();
    await db.delete("accountState", 'outgoing-edit-status:["alice","other-edit"]');
    vi.mocked(api.post).mockResolvedValue({ editedAt: Date.now(), mutationSeq: 7, editSeq: 1 });
    await refreshOutgoingQueue("edit");
    await refreshOutgoingQueue("other-edit");
    await vi.waitFor(async () => {
      expect(await getMessageById("original")).toMatchObject({ editSequence: 1 });
      expect(await getMessageById("other-original")).toMatchObject({ editSequence: 1 });
    });
    expect(vi.mocked(api.post).mock.calls).toEqual(expect.arrayContaining([
      ["/api/messages/edit", editBody()], ["/api/messages/edit", editBody("other-original")],
    ]));
    expect(get.mock.calls).not.toContainEqual(['outgoing-account:["alice","message"]']);
    expect(getAll.mock.calls.every(([range]) => !!range && !(range instanceof IDBKeyRange && range.includes('outgoing-account:["alice","message"]')))).toBe(true);
    expect(api.put).not.toHaveBeenCalled();
  } finally { stop(); get.mockRestore(); getAll.mockRestore(); }
});

it.each([0, 429, 503])("keeps a failed %s send durably and reuses its ciphertext on retry", async (status) => {
  await seed();
  vi.mocked(api.post).mockRejectedValueOnce(status ? Object.assign(new Error("Rate limit exceeded"), { status }) : networkError());
  await retryOutgoing("message");
  const failed = await getOutgoing("message");
  expect(failed).toMatchObject({ status: "failed", retryable: true, attempts: 1, error: status ? "errorRateLimitExceeded" : "errorFailedToFetch" });
  expect(failed!.nextAttemptAt! - Date.now()).toBeGreaterThan(1500);
  expect(await getMessageById("message")).toMatchObject({ status: "failed", content: "private text" });
  expect(JSON.stringify(failed)).not.toContain("private text");
  await retryOutgoing("message");
  expect(prepareDirectPayloadFanout).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.post).mock.calls).toEqual([["/api/messages/send-direct-batch", body], ["/api/messages/send-direct-batch", body]]);
  expect(await getAllOutgoing()).toEqual([]);
  expect(await getMessageById("message")).toMatchObject({ status: "sent", timestamp: 123 });
});

it.each(["direct", "group"] as const)("replays the same %s envelope after a response-parse failure or lost connection", async (conversationType) => {
  for (const failure of [new SyntaxError("Invalid JSON response"), networkError()]) {
    await seed({ conversationType, sendDispatched: false });
    let encryptions = 0;
    vi.mocked(prepareDirectPayloadFanout).mockImplementation(async () => ({ ...body, messages: [{ ...body.messages[0], ciphertext: `ciphertext-${++encryptions}` }] }) as never);
    vi.mocked(encryptGroupText).mockImplementation(async () => ({ ciphertext: `ciphertext-${++encryptions}`, iv: "iv", header: "header" }));
    let accepted: string | undefined;
    let dispatches = 0;
    const dispatchMarkers: (boolean | undefined)[] = [];
    vi.mocked(api.post).mockImplementation(async (_path, payload) => {
      dispatchMarkers.push((await getOutgoing("message"))?.sendDispatched);
      dispatches++;
      const envelope = JSON.stringify(payload);
      if (accepted === undefined) { accepted = envelope; throw failure; }
      // Model the endpoint's idempotency check: a different envelope cannot get the receipt.
      if (envelope !== accepted) throw Object.assign(new Error("Different envelope"), { status: 409 });
      return response as never;
    });
    await retryOutgoing("message");
    const failed = (await getOutgoing("message"))!;
    expect(failed).toMatchObject({ status: "failed", retryable: failure instanceof TypeError, sendDispatched: true });
    const steps = structuredClone(failed.steps);
    await retryOutgoing("message");
    expect(dispatches).toBe(2);
    expect(dispatchMarkers).toEqual([true, true]);
    expect(encryptions).toBe(1);
    expect(JSON.stringify(steps[0].body)).toBe(accepted);
    expect(await getOutgoing("message")).toBeUndefined();
    expect(await getMessageById("message")).toMatchObject({ status: "sent", timestamp: response.serverTimestamp });
  }
});

it("keeps a legacy terminal envelope with unknown dispatch state intact on retry", async () => {
  await seed({ status: "failed", retryable: false, steps: [{ path: "/api/messages/send-direct-batch", body: body as never }] });
  await retryOutgoing("message");
  expect(prepareDirectPayloadFanout).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/messages/send-direct-batch", body);
  expect(await getOutgoing("message")).toBeUndefined();
});

it.each(["direct", "group"] as const)("retries %s preparation with fresh encryption after a pre-send failure", async (conversationType) => {
  await seed({ conversationType, sendDispatched: false });
  const encrypt = conversationType === "direct" ? vi.mocked(prepareDirectPayloadFanout) : vi.mocked(encryptGroupText);
  encrypt.mockRejectedValueOnce(new Error("Preparation failed"));
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: false, sendDispatched: false });
  expect(api.post).not.toHaveBeenCalled();
  await retryOutgoing("message");
  expect(encrypt).toHaveBeenCalledTimes(2);
  expect(await getOutgoing("message")).toBeUndefined();
});

it("uses 2s, 5s, 15s, 60s backoff, and restores queued envelopes after reload", async () => {
  await seed({ steps: [{ path: "/api/messages/send-direct-batch", body: body as never }] });
  vi.mocked(api.post).mockRejectedValue(networkError());
  for (const delay of [2000, 5000, 15000, 60000, 60000]) {
    const before = Date.now();
    await retryOutgoing("message");
    expect((await getOutgoing("message"))!.nextAttemptAt).toBeGreaterThanOrEqual(before + delay);
  }
  expect(prepareDirectPayloadFanout).not.toHaveBeenCalled();
  vi.mocked(api.post).mockResolvedValue(response as never);
  const stop = startOutgoingQueue();
  window.dispatchEvent(new Event("online"));
  await vi.waitFor(async () => expect(await getOutgoing("message")).toBeUndefined());
  stop();
});

it("automatically retries at its persisted due time", async () => {
  await seed({ steps: [{ path: "/api/messages/send-direct-batch", body: body as never }], status: "failed", nextAttemptAt: Date.now() + 2000 });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const stop = startOutgoingQueue();
  await refreshOutgoingQueue();
  await vi.advanceTimersByTimeAsync(1999);
  expect(api.post).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  // IndexedDB uses real tasks; waitFor's interval remains real here.
  await vi.waitFor(async () => expect(await getOutgoing("message")).toBeUndefined());
  stop();
});

it("keeps non-retryable 4xx failures visible until manual discard", async () => {
  await seed();
  vi.mocked(api.post).mockRejectedValue(Object.assign(new Error("Not a member"), { status: 403 }));
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ retryable: false, status: "failed", nextAttemptAt: null, error: "errorNotAMember" });
  const stop = startOutgoingQueue();
  window.dispatchEvent(new Event("online"));
  await refreshOutgoingQueue();
  expect(api.post).toHaveBeenCalledTimes(1);
  await discardOutgoing("message");
  expect(await getOutgoing("message")).toBeUndefined();
  expect(await getMessageById("message")).toBeUndefined();
  stop();
});

it("F2-client: replays a group POST for a server receipt without advancing the sender key again", async () => {
  await seed({ conversationType: "group" });
  vi.mocked(api.post).mockRejectedValueOnce(networkError());
  await retryOutgoing("message");
  vi.mocked(api.get).mockResolvedValue({ messages: [{ ...response, senderDeviceId: "device" }], hasMore: false } as never);
  await retryOutgoing("message");
  expect(encryptGroupText).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(await getOutgoing("message")).toBeUndefined();
  expect(await getMessageById("message")).toMatchObject({ status: "sent" });
});

it("checks upload HTTP errors and retains encrypted upload bytes for retry", async () => {
  await seed({ upload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", uploadUrl: "/upload" } });
  vi.mocked(api.put).mockRejectedValueOnce(Object.assign(new Error("File upload failed (503)"), { status: 503 }));
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: true, error: "messageNotSent" });
  expect(api.post).not.toHaveBeenCalled();
  await retryOutgoing("message");
  expect(new Uint8Array(vi.mocked(api.put).mock.calls[1][1] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  expect(await getOutgoing("message")).toBeUndefined();
});

it.each(["upload-url", "PUT"])("marks a file rejected with 400 by %s failed and keeps Discard available", async (stage) => {
  await seed({ upload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/x-apple-diskimage" } });
  await saveMessage({ ...(await getMessageById("message"))!, type: "file", content: JSON.stringify({ fileId: "", fileName: "installer.dmg", mimeType: "application/x-apple-diskimage" }) });
  const error = Object.assign(new Error("Invalid upload"), { status: 400 });
  vi.mocked(api.post).mockResolvedValue({ fileId: "file", uploadUrl: "/upload" } as never);
  if (stage === "upload-url") vi.mocked(api.post).mockRejectedValueOnce(error);
  else vi.mocked(api.put).mockRejectedValueOnce(error);
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: false, nextAttemptAt: null, error: "fileCouldNotBeUploaded" });
  expect(await getMessageById("message")).toMatchObject({ status: "failed" });
  expect(useChatStore.getState().messages.get("chat")).toMatchObject([{ status: "failed" }]);
  expect(prepareDirectPayloadFanout).not.toHaveBeenCalled();
  const stop = startOutgoingQueue();
  try {
    window.dispatchEvent(new Event("online"));
    await refreshOutgoingQueue();
    expect(api.post).toHaveBeenCalledTimes(1);
    await discardOutgoing("message");
    expect(await getOutgoing("message")).toBeUndefined();
    expect(await getMessageById("message")).toBeUndefined();
  } finally { stop(); }
});

it("persists a failed upload retry even when its previous error needs normalization", async () => {
  await seed({ status: "failed", error: "Legacy upload diagnostic", upload: { bytes: new Uint8Array([1]), mimeType: "application/octet-stream" } });
  await saveMessage({ ...(await getMessageById("message"))!, type: "file" });
  vi.mocked(api.post).mockRejectedValueOnce(Object.assign(new Error("Invalid upload"), { status: 400 }));
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: false });
  expect(await getMessageById("message")).toMatchObject({ status: "failed" });
  expect(useChatStore.getState().messages.get("chat")).toMatchObject([{ status: "failed" }]);
});

it.each(["upload-url", "PUT"])("keeps network, 429 and 5xx %s failures retryable", async (stage) => {
  for (const error of [networkError(), Object.assign(new Error("Unavailable"), { status: 503 }), Object.assign(new Error("Rate limit exceeded"), { status: 429 })]) {
    await seed({ upload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/x-apple-diskimage" } });
    await saveMessage({ ...(await getMessageById("message"))!, type: "file", content: JSON.stringify({ fileId: "", fileName: "installer.dmg", mimeType: "application/x-apple-diskimage" }) });
    vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/files/upload-url" ? { fileId: "file", uploadUrl: "/upload" } : response) as never);
    if (stage === "upload-url") vi.mocked(api.post).mockRejectedValueOnce(error);
    else vi.mocked(api.put).mockRejectedValueOnce(error);
    await retryOutgoing("message");
    expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: true, nextAttemptAt: expect.any(Number) });
    expect(await getMessageById("message")).toMatchObject({ status: "failed" });
    await retryOutgoing("message");
    expect(await getOutgoing("message")).toBeUndefined();
    expect(await getMessageById("message")).toMatchObject({ status: "sent" });
  }
});

it.each(["image/avif", "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence", "video/quicktime"])("retries an older server's %s MIME rejection once as octet-stream without failing the attempt", async (mimeType) => {
  await seed({ upload: { bytes: new Uint8Array([1, 2, 3]), mimeType } });
  const content = JSON.stringify({ fileId: "", fileName: "original", mimeType, fileKey: "secret", iv: "iv" });
  await saveMessage({ ...(await getMessageById("message"))!, type: "file", content });
  const attempts: number[] = [];
  vi.mocked(api.post).mockImplementation(async (path, payload) => {
    if (path !== "/api/files/upload-url") return response as never;
    attempts.push((await getOutgoing("message"))!.attempts);
    if ((payload as { mimeType: string }).mimeType !== "application/octet-stream") {
      throw Object.assign(new Error("Invalid enum value"), { status: 400, body: { error: { formErrors: [], fieldErrors: { mimeType: ["Unsupported type"] } } } });
    }
    return { fileId: "file", uploadUrl: "/upload" } as never;
  });
  await retryOutgoing("message");
  expect(vi.mocked(api.post).mock.calls.filter(([path]) => path === "/api/files/upload-url").map(([, payload]) => (payload as { mimeType: string }).mimeType)).toEqual([mimeType, "application/octet-stream"]);
  expect(attempts).toEqual([1, 1]);
  expect(api.put).toHaveBeenCalledOnce();
  expect(await getOutgoing("message")).toBeUndefined();
  expect(await getMessageById("message")).toMatchObject({ status: "sent", content: JSON.stringify({ ...JSON.parse(content), fileId: "file" }) });
  expect(vi.mocked(prepareDirectPayloadFanout).mock.calls[0][2]).toBe(JSON.stringify({ ...JSON.parse(content), fileId: "file" }));
});

it("stops after one failed MIME fallback and remembers octet-stream for the next manual retry", async () => {
  await seed({ upload: { bytes: new Uint8Array([1]), mimeType: "image/avif" } });
  await saveMessage({ ...(await getMessageById("message"))!, type: "file", content: JSON.stringify({ fileId: "", mimeType: "image/avif" }) });
  vi.mocked(api.post).mockRejectedValue(Object.assign(new Error("Invalid type"), { status: 400, body: { error: { fieldErrors: { mimeType: ["Invalid type"] } } } }));
  await retryOutgoing("message");
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: false, attempts: 1, upload: { mimeType: "application/octet-stream" } });
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/files/upload-url" ? { fileId: "file", uploadUrl: "/upload" } : response) as never);
  await retryOutgoing("message");
  expect(vi.mocked(api.post).mock.calls[2]).toEqual(["/api/files/upload-url", { conversationId: "chat", mimeType: "application/octet-stream", sizeBytes: 1 }]);
  expect(await getOutgoing("message")).toBeUndefined();
});

it.each([
  { status: 400, fieldErrors: { sizeBytes: ["Too large"] }, mimeType: "image/avif" },
  { status: 403, fieldErrors: { mimeType: ["Unsupported"] }, mimeType: "image/avif" },
  { status: 503, fieldErrors: { mimeType: ["Unsupported"] }, mimeType: "image/avif" },
  { status: 400, fieldErrors: { mimeType: ["Unsupported"] }, mimeType: "application/octet-stream" },
])("does not hide other validation/server errors or repeat octet-stream ($status, $mimeType)", async ({ status, fieldErrors, mimeType }) => {
  await seed({ upload: { bytes: new Uint8Array([1]), mimeType } });
  vi.mocked(api.post).mockRejectedValue(Object.assign(new Error("Rejected"), { status, body: { error: { fieldErrors } } }));
  await retryOutgoing("message");
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(await getOutgoing("message")).toMatchObject({ status: "failed", attempts: 1, retryable: status >= 500 });
});

it("does not replay another user's pending messages or commit results after logout", async () => {
  await seed({ userId: "bob" });
  await retryOutgoing("message");
  expect(api.post).not.toHaveBeenCalled();
  await seed();
  vi.mocked(api.post).mockImplementation(async () => {
    useAuthStore.setState({ accessToken: null });
    return response as never;
  });
  await retryOutgoing("message");
  expect(await getOutgoing("message", "alice")).toBeDefined();
  expect(await getOutgoing("message", "bob")).toBeDefined();
  expect(await getMessageById("message", "alice")).toMatchObject({ status: "sending" });
});

it("keeps later group sends behind a failed send so Sender Keys are received in order", async () => {
  await seed({ conversationType: "group" });
  const first = (await getOutgoing("message"))!;
  const message = (await getMessageById("message"))!;
  await saveQueuedMessage({ ...message, id: "second", content: "second private text" }, { ...first, id: "second", queuedAt: 2 });
  let reject!: (reason: unknown) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  const sending = retryOutgoing("message");
  await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  await retryOutgoing("second");
  expect(encryptGroupText).toHaveBeenCalledTimes(1);
  reject(networkError());
  await sending;
  await retryOutgoing("second");
  expect(encryptGroupText).toHaveBeenCalledTimes(1);
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false } as never);
  await retryOutgoing("message");
  await retryOutgoing("second");
  expect(encryptGroupText).toHaveBeenCalledTimes(2);
  expect(await getAllOutgoing()).toEqual([]);
});

it("delivers two texts in order while an earlier permanently rejected file stays failed", async () => {
  await seed({ upload: { bytes: new Uint8Array([1]), mimeType: "application/octet-stream" } });
  await saveMessage({ ...(await getMessageById("message"))!, type: "file", content: JSON.stringify({ fileId: "", fileName: "installer.dmg" }) });
  vi.mocked(api.post).mockRejectedValueOnce(Object.assign(new Error("Invalid upload"), { status: 400 }));
  await retryOutgoing("message");
  vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (_conversation, id) => ({ ...body, messages: [{ ...body.messages[0], id }] }) as never);
  const published = vi.fn();
  const unsubscribe = subscribeQueue(published);
  const stop = startOutgoingQueue();
  try {
    // Let the startup drain finish with only the terminal failure. The scheduler
    // must wake this now-idle queue when later messages arrive.
    await vi.waitFor(() => expect(published).toHaveBeenCalled());
    await queueText("second", 2);
    await queueText("third", 3);
    await refreshOutgoingQueue();
    await vi.waitFor(async () => {
      expect(await getMessageById("second")).toMatchObject({ status: "sent" });
      expect(await getMessageById("third")).toMatchObject({ status: "sent" });
    });
    expect(vi.mocked(api.post).mock.calls.filter(([path]) => path === "/api/messages/send-direct-batch").map(([, payload]) => (payload as typeof body).messages[0].id)).toEqual(["second", "third"]);
    expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: false });
    expect(await getMessageById("message")).toMatchObject({ status: "failed" });
  } finally { stop(); unsubscribe(); }
});

it.each(["network", "429"])("keeps later texts behind a retryable %s file failure until it succeeds", async (failure) => {
  await seed({ upload: { bytes: new Uint8Array([1]), mimeType: "application/octet-stream" } });
  await saveMessage({ ...(await getMessageById("message"))!, type: "file", content: JSON.stringify({ fileId: "", fileName: "installer.dmg" }) });
  vi.mocked(api.post).mockRejectedValueOnce(failure === "network" ? networkError() : Object.assign(new Error("Rate limit exceeded"), { status: 429 }));
  await retryOutgoing("message");
  await queueText("second", 2);
  await queueText("third", 3);
  vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (_conversation, id) => ({ ...body, messages: [{ ...body.messages[0], id }] }) as never);
  await retryOutgoing("second");
  await retryOutgoing("third");
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(await getMessageById("second")).toMatchObject({ status: "sending" });
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/files/upload-url" ? { fileId: "file", uploadUrl: "/upload" } : response) as never);
  const stop = startOutgoingQueue();
  try {
    await retryOutgoing("message");
    await vi.waitFor(async () => expect(await getAllOutgoing()).toEqual([]));
    expect(vi.mocked(api.post).mock.calls.filter(([path]) => path === "/api/messages/send-direct-batch").map(([, payload]) => (payload as typeof body).messages[0].id)).toEqual(["message", "second", "third"]);
  } finally { stop(); }
});

it.each([true, false])("flushes both waiting texts immediately on discard without a queue consumer or online event (retryable: %s)", async (retryable) => {
  await seed({ status: "failed", retryable, nextAttemptAt: retryable ? Date.now() + 60000 : null });
  await queueText("second", 2);
  await queueText("third", 3);
  vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (_conversation, id) => ({ ...body, messages: [{ ...body.messages[0], id }] }) as never);
  if (retryable) {
    await retryOutgoing("second");
    expect(api.post).not.toHaveBeenCalled();
  }
  await discardOutgoing("message");
  expect(await getAllOutgoing()).toEqual([]);
  expect(await getMessageById("second")).toMatchObject({ status: "sent" });
  expect(await getMessageById("third")).toMatchObject({ status: "sent" });
  expect(vi.mocked(api.post).mock.calls.map(([, payload]) => (payload as typeof body).messages[0].id)).toEqual(["second", "third"]);
});

it("moves a terminal group retry after pending work and encrypts it at the current chain position", async () => {
  await seed({ conversationType: "group", status: "failed", retryable: false, sendDispatched: false, steps: [{ path: "/api/messages/send", body: { id: "message", conversationId: "chat", type: "text", ciphertext: "outdated", iv: "iv", header: "old" } }] });
  await queueText("second", 2);
  await retryOutgoing("message");
  expect(api.post).not.toHaveBeenCalled();
  expect(await getOutgoing("message")).toMatchObject({ status: "sending", retryable: true, steps: [] });
  expect((await getOutgoing("message"))!.queuedAt).toBeGreaterThan((await getOutgoing("second"))!.queuedAt);
  await retryOutgoing("second");
  await retryOutgoing("message");
  expect(encryptGroupText).toHaveBeenNthCalledWith(1, "chat", "second");
  expect(encryptGroupText).toHaveBeenNthCalledWith(2, "chat", "private text");
  expect(JSON.stringify(vi.mocked(api.post).mock.calls)).not.toContain("outdated");
  expect(await getAllOutgoing()).toEqual([]);
});

it.each([
  { status: "failed", result: "success" }, { status: "failed", result: "permanent failure" },
  { status: "sending", result: "success" }, { status: "sending", result: "permanent failure" },
] as const)("recovers a reload mid-manual-retry of a $status row and lets later messages send after $result", async ({ status, result }) => {
  await seed({ status, retryable: false, error: status === "failed" ? "messageNotSent" : null, sendDispatched: false });
  let finishLookup!: (value: never) => void;
  vi.mocked(api.get).mockReturnValueOnce(new Promise((resolve) => { finishLookup = resolve; }));
  const sending = retryOutgoing("message");
  let stop: (() => void) | undefined;
  try {
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce());
    // The durable record at the interruption point must be recoverable without its old runtime.
    expect(await getOutgoing("message")).toMatchObject({ status: "sending", retryable: true, error: null, sendDispatched: false });
    await queueText("second", Date.now() + 1);
    vi.resetModules();
    useAuthStore.setState({ sessionId: "reloaded-session" } as never);
    const restored = await import("./outgoingQueue.js");
    vi.mocked(api.post).mockImplementation(async (_path, payload) => {
      if (result === "permanent failure" && (payload as typeof body).messages[0].id === "message") throw Object.assign(new Error("Rejected"), { status: 403 });
      return response as never;
    });
    vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (_conversation, id) => ({ ...body, messages: [{ ...body.messages[0], id }] }) as never);
    stop = restored.startOutgoingQueue();
    await vi.waitFor(async () => expect(await getMessageById("second")).toMatchObject({ status: "sent" }));
    if (result === "success") expect(await getOutgoing("message")).toBeUndefined();
    else {
      expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: false, error: "messageNotSent" });
      expect(await getMessageById("message")).toMatchObject({ status: "failed" });
      await restored.discardOutgoing("message");
    }
    expect(await getAllOutgoing()).toEqual([]);
  } finally {
    stop?.();
    finishLookup({ id: "chat", type: "direct", members: [] } as never);
    await sending;
  }
});

it("repairs an older stuck manual-retry row without an error and releases later messages", async () => {
  await seed({ status: "sending", retryable: false, error: null });
  await queueText("second", 2);
  vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (_conversation, id) => ({ ...body, messages: [{ ...body.messages[0], id }] }) as never);
  const stop = startOutgoingQueue();
  try {
    await vi.waitFor(async () => expect(await getMessageById("second")).toMatchObject({ status: "sent" }));
    expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: false, error: "messageNotSent" });
    expect(await getMessageById("message")).toMatchObject({ status: "failed" });
    await discardOutgoing("message");
    expect(await getAllOutgoing()).toEqual([]);
  } finally { stop(); }
});

it("turns a file whose encryption was interrupted by reload into a visible failed send", async () => {
  await seed({ retryable: false, error: "File encryption was interrupted. Attach the file again." });
  const stop = startOutgoingQueue();
  await vi.waitFor(async () => expect(await getOutgoing("message")).toMatchObject({ status: "failed" }));
  expect(await getMessageById("message")).toMatchObject({ status: "failed" });
  expect(api.post).not.toHaveBeenCalled();
  stop();
});

it("does not repeatedly request the ordinary send lock while another tab holds it", async () => {
  await seed();
  await refreshOutgoingQueue();
  let release!: () => void;
  let tail = new Promise<void>((resolve) => { release = resolve; });
  const request = vi.fn((_name: string, action: () => Promise<void>) => {
    const task = tail.then(action);
    tail = task.catch(() => undefined);
    return task;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  const stop = startOutgoingQueue();
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(request).toHaveBeenCalledOnce();
    expect(api.post).not.toHaveBeenCalled();

    release();
    await vi.waitFor(async () => expect(await getMessageById("message")).toMatchObject({ status: "sent" }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(api.post).toHaveBeenCalledOnce();
    expect(await getOutgoing("message")).toBeUndefined();
  } finally { stop(); release(); await tail; }
});

it("sends a message enqueued during its conversation drain without waiting for another conversation", async () => {
  await refreshOutgoingQueue();
  await seed();
  await saveQueuedMessage({ ...(await getMessageById("message"))!, id: "waiting", conversationId: "other" },
    { ...(await getOutgoing("message"))!, id: "waiting", conversationId: "other" });
  vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (_conversation, id) => ({ ...body, messages: [{ ...body.messages[0], id }] }) as never);

  let releaseChat!: () => void, releaseOther!: () => void;
  const chatLock = new Promise<void>((resolve) => { releaseChat = resolve; });
  const otherLock = new Promise<void>((resolve) => { releaseOther = resolve; });
  const request = vi.fn(async (name: string, action: () => Promise<void>) => {
    await (name.endsWith(":other") ? otherLock : chatLock);
    await action();
  });
  vi.stubGlobal("navigator", { locks: { request } });
  const stop = startOutgoingQueue();
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await queueText("second", 2);
    // The lock holder completed the row this drain originally read.
    await deleteOutgoing("message");
    releaseChat();
    await vi.waitFor(async () => expect(await getMessageById("second")).toMatchObject({ status: "sent" }));
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/messages/send-direct-batch", expect.objectContaining({
      messages: [expect.objectContaining({ id: "second" })],
    }));
    expect(await getOutgoing("waiting")).toBeDefined();
    expect(request.mock.calls.filter(([name]) => name.endsWith(":other"))).toHaveLength(1);
  } finally {
    stop();
    await deleteOutgoing("waiting");
    releaseChat();
    releaseOther();
    await Promise.all(request.mock.results.map(({ value }) => value));
  }
});

it.each(["while waiting for the lock", "after reading the display row"])("keeps file encryption completed in another tab %s", async (interleaving) => {
  await seed({ retryable: false, error: "fileEncryptionWasInterruptedAttachTheFileAgain" });
  await saveMessage({ ...(await getMessageById("message"))!, type: "file" });
  await refreshOutgoingQueue();
  const initial = (await getOutgoing("message"))!;
  const bytes = new Uint8Array([4, 5, 6]);
  const ready = { ...initial, upload: { bytes, mimeType: "image/png" }, retryable: true, error: null, nextAttemptAt: Date.now() + 60000 };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const request = vi.fn(async (_name: string, action: () => Promise<void>) => { await held; await action(); });
  vi.stubGlobal("navigator", { locks: { request } });
  const get = IDBObjectStore.prototype.get;
  let updated = false;
  let preparing: Promise<boolean> | undefined;
  const read = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
    const request = get.call(this, key);
    if (interleaving === "after reading the display row" && this.name === "displayMessages" && this.transaction.mode === "readonly" && Array.isArray(key) && key[0] === "alice" && key[1] === "message") {
      request.addEventListener("success", () => {
        if (!updated) { updated = true; preparing = updateOutgoingIfPresent(ready); }
      });
    }
    return request;
  });
  const stop = startOutgoingQueue();
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    if (interleaving === "while waiting for the lock") await updateOutgoingIfPresent(ready);
    release();
    await vi.waitFor(() => {
      const row = getQueueSnapshot().find((entry) => entry.id === "message");
      expect(row?.status === "failed" || !!row?.upload).toBe(true);
    });
    if (interleaving === "after reading the display row") expect(await preparing).toBe(true);
    const persisted = await getOutgoing("message");
    expect(persisted).toMatchObject({ upload: { mimeType: "image/png" }, retryable: true, error: null, status: "sending" });
    expect(Array.from(persisted?.upload?.bytes ?? [])).toEqual(Array.from(bytes));
    expect(await getMessageById("message")).toMatchObject({ status: "sending" });
    expect(api.post).not.toHaveBeenCalled();
  } finally { release(); stop(); read.mockRestore(); }
});

it("does not overwrite another tab's prepared envelope after a metadata lookup fails", async () => {
  await seed();
  const newer = { ...body, messages: [{ ...body.messages[0], ciphertext: "newer-ciphertext" }] };
  vi.mocked(api.get).mockImplementationOnce(async () => {
    const current = (await getOutgoing("message"))!;
    await updateOutgoingIfPresent({ ...current, steps: [{ path: "/api/messages/send-direct-batch", body: newer as never }], nextAttemptAt: Date.now() + 60000 });
    throw networkError();
  });
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ steps: [{ body: newer }], error: null, status: "sending", retryable: true });
  expect(api.post).not.toHaveBeenCalled();
});

it("does not delete another tab's newer outbox progress after a send receipt arrives", async () => {
  await seed({ steps: [{ path: "/api/messages/send-direct-batch", body: body as never }] });
  const newer = { ...body, messages: [{ ...body.messages[0], ciphertext: "newer-ciphertext" }] };
  vi.mocked(api.post).mockImplementationOnce(async () => {
    const current = (await getOutgoing("message"))!;
    await updateOutgoingIfPresent({ ...current, steps: [{ path: "/api/messages/send-direct-batch", body: newer as never }], nextAttemptAt: Date.now() + 60000 });
    return response as never;
  });
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ steps: [{ body: newer }], retryable: true });
  expect(await getMessageById("message")).toMatchObject({ status: "sending" });
});

it("replays the same sender-key distribution before its already encrypted group message", async () => {
  await seed({ conversationType: "group" });
  const distribution = { path: "/api/messages/send-direct-batch", body: { conversationId: "chat", type: "sender_key_distribution", messages: [{ id: "distribution", ciphertext: "encrypted-distribution", iv: "iv", header: "header" }] }, distributed: { senderDeviceId: "device", senderKeyId: 1, recipientDeviceIds: ["peer"] } } as const;
  vi.mocked(prepareSenderKeyDistribution).mockResolvedValue(distribution as never);
  vi.mocked(api.post).mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { status: 503 }));
  await retryOutgoing("message");
  expect((await getOutgoing("message"))!.steps).toHaveLength(2);
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false } as never);
  await retryOutgoing("message");
  expect(prepareSenderKeyDistribution).toHaveBeenCalledTimes(1);
  expect(encryptGroupText).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
  expect(vi.mocked(api.post).mock.calls[2][0]).toBe("/api/messages/send");
  expect(finishSenderKeyDistribution).toHaveBeenCalledTimes(1);
  expect(await getAllOutgoing()).toEqual([]);
});

it("keeps a queued timed message through retention cleanup until the server accepts it", async () => {
  await seed({ ttlSeconds: 30, status: "failed", nextAttemptAt: Date.now() + 60000 });
  const message = (await getMessageById("message"))!;
  // Queued offline for longer than its optimistic TTL.
  await saveQueuedMessage({ ...message, expiryKind: "timed", expiresAt: Date.now() - 1000, status: "failed" }, (await getOutgoing("message"))!);
  expect(await cleanupExpiredMessages()).toEqual([]);
  expect(await getMessageById("message")).toMatchObject({ content: "private text" });
  await retryOutgoing("message");
  expect(api.post).toHaveBeenCalledWith("/api/messages/send-direct-batch", body);
  expect(await getOutgoing("message")).toBeUndefined();
  // The server's expiry replaces the estimate; ordinary retention applies again once it is sent.
  expect(await getMessageById("message")).toMatchObject({ status: "sent", expiresAt: response.expiresAt });
  expect(await cleanupExpiredMessages(response.expiresAt + 1)).toEqual(["message"]);
});

it.each(["text", "file"])("delivers queued %s after legacy cleanup deletes only its display row", async (type) => {
  const bytes = new Uint8Array([1, 2, 3]);
  const prepared = { ...body, type, ttlSeconds: 30, ...(type === "file" ? { fileId: "file-1" } : {}) };
  await seed({
    ttlSeconds: 30, steps: [{ path: "/api/messages/send-direct-batch", body: prepared as never }],
    ...(type === "file" ? { fileId: "file-1", upload: { bytes, mimeType: "image/png", uploadUrl: "/upload" } } : {}),
  });
  // A v5 tab's cleanup does not know about syncState's outgoing: entries.
  await (await getAppDB()).delete("displayMessages", ["alice", "message"]);
  vi.mocked(api.post).mockRejectedValue(networkError());
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: true, attempts: 1 });
  expect(await getMessageById("message")).toBeUndefined();
  expect(useChatStore.getState().messages.get("chat")).toBeUndefined();
  vi.mocked(api.post).mockResolvedValue(response as never);
  await retryOutgoing("message");
  expect(vi.mocked(api.post).mock.calls).toEqual([
    ["/api/messages/send-direct-batch", prepared], ["/api/messages/send-direct-batch", prepared],
  ]);
  if (type === "file") expect(api.put).toHaveBeenCalledExactlyOnceWith("/upload", bytes.buffer);
  expect(prepareDirectPayloadFanout).not.toHaveBeenCalled();
  expect(await getOutgoing("message")).toBeUndefined();
  expect(await getMessageById("message")).toBeUndefined();
  expect(useChatStore.getState().messages.get("chat")).toBeUndefined();
  expect(useChatStore.getState().outgoingRemovalNotices.size).toBe(0);
});

it.each(["needs encryption", "non-retryable", "expired PUT", "expired reservation"])("retires an orphan that is %s and delivers the next message", async (reason) => {
  const prepared = { ...body, type: "file", fileId: "expired" };
  await seed({
    fileId: "expired", upload: { bytes: new Uint8Array([1, 2]), mimeType: "image/png", uploadUrl: "/expired", uploaded: reason !== "expired PUT" },
    steps: reason === "needs encryption" ? [] : [{ path: "/api/messages/send-direct-batch", body: prepared as never }],
    retryable: reason !== "non-retryable", status: "failed",
  });
  const second = { ...body, messages: [{ ...body.messages[0], id: "second" }] };
  await saveQueuedMessage({ ...(await getMessageById("message"))!, id: "second" }, {
    ...(await getOutgoing("message"))!, id: "second", queuedAt: 2, status: "sending", retryable: true,
    fileId: undefined, upload: undefined, steps: [{ path: "/api/messages/send-direct-batch", body: second as never }],
  });
  await (await getAppDB()).delete("displayMessages", ["alice", "message"]);
  if (reason === "expired PUT") vi.mocked(api.put).mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
  if (reason === "expired reservation") vi.mocked(api.post).mockImplementation(async (_path, payload) => {
    if ((payload as typeof prepared).fileId) throw Object.assign(new Error("File not found"), { status: 404 });
    return response as never;
  });
  const stop = startOutgoingQueue();
  try {
    await vi.waitFor(async () => expect(await getAllOutgoing()).toEqual([]));
    expect(api.post).toHaveBeenCalledWith("/api/messages/send-direct-batch", second);
    expect(await getMessageById("message")).toBeUndefined();
    expect(await getMessageById("second")).toMatchObject({ status: "sent" });
    expect(useChatStore.getState().outgoingRemovalNotices).toEqual(new Set(["chat"]));
    expect(prepareDirectPayloadFanout).not.toHaveBeenCalled();
  } finally { stop(); }
});

it("retires a non-retryable orphan before a manual send checks conversation ordering", async () => {
  await seed({ retryable: false, status: "failed" });
  await saveQueuedMessage({ ...(await getMessageById("message"))!, id: "second" }, {
    ...(await getOutgoing("message"))!, id: "second", queuedAt: 2, retryable: true,
  });
  await (await getAppDB()).delete("displayMessages", ["alice", "message"]);
  await retryOutgoing("second");
  expect(await getAllOutgoing()).toEqual([]);
  expect(await getMessageById("second")).toMatchObject({ status: "sent" });
  expect(useChatStore.getState().outgoingRemovalNotices).toEqual(new Set(["chat"]));
});

it("does not retire an earlier in-flight orphan waiting on metadata without Web Locks", async () => {
  vi.stubGlobal("navigator", {});
  await seed();
  await saveQueuedMessage({ ...(await getMessageById("message"))!, id: "second" }, {
    ...(await getOutgoing("message"))!, id: "second", queuedAt: 2,
  });
  let finishLookup!: (value: never) => void;
  vi.mocked(api.get).mockReturnValueOnce(new Promise((resolve) => { finishLookup = resolve; }));
  vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (_conversation, id) => ({
    ...body, messages: [{ ...body.messages[0], id }],
  }) as never);
  const sending = retryOutgoing("message");
  try {
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    // The active attempt still holds the content needed to finish encryption.
    await (await getAppDB()).delete("displayMessages", ["alice", "message"]);
    await retryOutgoing("second");
    expect.soft(await getOutgoing("message")).toMatchObject({ status: "sending", steps: [] });
    expect.soft(await getOutgoing("second")).toMatchObject({ attempts: 0 });
    expect.soft(api.post).not.toHaveBeenCalled();
    expect.soft(useChatStore.getState().outgoingRemovalNotices.size).toBe(0);
  } finally {
    finishLookup({ id: "chat", type: "direct", members: [] } as never);
    await sending;
  }
  expect(await getMessageById("message")).toMatchObject({ status: "sent" });
  await retryOutgoing("second");
  expect(vi.mocked(api.post).mock.calls.map(([, payload]) => (payload as typeof body).messages[0].id)).toEqual(["message", "second"]);
  expect(await getAllOutgoing()).toEqual([]);
});

it("publishes a file id to the display record only once the upload is attached to an accepted message", async () => {
  const content = (fileId: string) => JSON.stringify({ fileId, fileName: "photo.png", mimeType: "image/png", size: 3, fileKey: "key", iv: "iv" });
  await seed({ upload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" } });
  await saveQueuedMessage({ ...(await getMessageById("message"))!, type: "file", content: content("") }, (await getOutgoing("message"))!);
  let finishUpload!: (value: never) => void;
  vi.mocked(api.put).mockReturnValueOnce(new Promise((resolve) => { finishUpload = resolve; }));
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/files/upload-url" ? { fileId: "file-1", uploadUrl: "/upload" } : response) as never);
  const displayed = () => useChatStore.getState().messages.get("chat")?.find((entry) => entry.id === "message");
  const sending = retryOutgoing("message");
  await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  // FilePreview loads as soon as it sees a file id, and the server refuses unattached files.
  expect(displayed()).toMatchObject({ status: "sending", content: content("") });
  expect((await getMessageById("message"))!.content).toBe(content(""));
  expect(await getOutgoing("message")).toMatchObject({ fileId: "file-1" });
  finishUpload({ success: true } as never);
  await sending;
  expect(vi.mocked(prepareDirectPayloadFanout).mock.calls[0].slice(2)).toEqual([content("file-1"), "file", { ttlSeconds: null, fileId: "file-1" }]);
  expect(displayed()).toMatchObject({ status: "sent", content: content("file-1") });
  expect((await getMessageById("message"))!.content).toBe(content("file-1"));
});

it("F3: retains uploaded ciphertext through a lost send response and renews an expired reservation after reload", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  await seed({ upload: { bytes, mimeType: "image/png", uploadUrl: "/old-upload" }, fileId: "old-file" });
  await saveQueuedMessage({ ...(await getMessageById("message"))!, type: "file", content: JSON.stringify({ fileId: "", fileKey: "secret", iv: "iv" }) }, (await getOutgoing("message"))!);
  // Also supply the old raw PUT path so reverting the fix fails on lost bytes, not a mock mismatch.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  vi.mocked(api.post).mockRejectedValueOnce(networkError());
  await retryOutgoing("message");
  expect(Array.from((await getOutgoing("message"))?.upload?.bytes ?? [])).toEqual(Array.from(bytes));
  expect((await getOutgoing("message"))?.upload?.uploaded).toBe(true);
  // Simulate server cleanup of the unattached upload while the browser was closed.
  vi.mocked(api.post).mockImplementation(async (path, payload) => {
    if (path === "/api/files/upload-url") return { fileId: "new-file", uploadUrl: "/new-upload" } as never;
    if ((payload as { fileId?: string }).fileId === "old-file") throw Object.assign(new Error("File not found"), { status: 404 });
    return response as never;
  });
  vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (_conversation, id, _text, type, options) => ({ ...body, type, fileId: options?.fileId, messages: [{ ...body.messages[0], id }] }) as never);
  // The previously prepared envelope uses the old reservation, as a restored queue would.
  const restored = (await getOutgoing("message"))!;
  const firstStep = restored.steps[0];
  if (firstStep.path === "/api/messages/edit") throw new Error("Expected a file send");
  firstStep.body.fileId = "old-file";
  const { saveOutgoing } = await import("../../db/index.js");
  await saveOutgoing(restored);
  await retryOutgoing("message");
  expect(vi.mocked(api.put).mock.calls.map(([path]) => path)).toEqual(["/old-upload", "/new-upload"]);
  expect(api.post).toHaveBeenCalledWith("/api/files/upload-url", { conversationId: "chat", mimeType: "image/png", sizeBytes: bytes.length });
  for (const [, buffer] of vi.mocked(api.put).mock.calls) expect(new Uint8Array(buffer as ArrayBuffer)).toEqual(bytes);
  expect(await getOutgoing("message")).toBeUndefined();
  expect(JSON.parse((await getMessageById("message"))!.content).fileId).toBe("new-file");
});

it("F3: renews a reservation when a resumed PUT returns 404", async () => {
  await seed({ upload: { bytes: new Uint8Array([4, 5]), mimeType: "image/png", uploadUrl: "/expired" }, fileId: "expired" });
  vi.mocked(api.put).mockRejectedValueOnce(Object.assign(new Error("Not found"), { status: 404 }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/files/upload-url" ? { fileId: "renewed", uploadUrl: "/renewed" } : response) as never);
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toBeUndefined();
  expect(api.put).toHaveBeenCalledWith("/renewed", new Uint8Array([4, 5]).buffer);
  expect(api.post).toHaveBeenCalledWith("/api/files/upload-url", { conversationId: "chat", mimeType: "image/png", sizeBytes: 2 });
});

it("F4: discard waits on the same conversation lock as a retry in another tab", async () => {
  await seed();
  const tails = new Map<string, Promise<unknown>>();
  const request = vi.fn((name: string, callback: () => Promise<unknown>) => {
    const task = (tails.get(name) ?? Promise.resolve()).then(callback);
    tails.set(name, task.catch(() => undefined));
    return task;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  let reject!: (error: unknown) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  const sending = retryOutgoing("message");
  await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  vi.resetModules();
  const otherTab = await import("./outgoingQueue.js");
  const discarding = otherTab.discardOutgoing("message");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const before = await getOutgoing("message");
  reject(networkError());
  await sending;
  await discarding;
  expect(before).toBeDefined();
  expect(request.mock.calls.map(([name]) => name)).toEqual(["e2ee-outgoing:alice:device:chat", "e2ee-outgoing:alice:device:chat"]);
  expect(await getOutgoing("message")).toBeUndefined();
});

it.each(["file", "edit"])("drains an edit and an ordinary upload independently while the %s request is held", async (held) => {
  await seed({ upload: { bytes: new Uint8Array([1, 2]), mimeType: "image/png", uploadUrl: "/slow-upload" }, fileId: "file" });
  await seedEdit();
  const tails = new Map<string, Promise<unknown>>();
  const request = vi.fn((name: string, callback: () => Promise<unknown>) => {
    const task = (tails.get(name) ?? Promise.resolve()).then(callback);
    tails.set(name, task.catch(() => undefined));
    return task;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(api.put).mockImplementation(async () => {
    if (held === "file") await stalled;
    return { success: true } as never;
  });
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path !== "/api/messages/edit") return response as never;
    if (held === "edit") await stalled;
    return { editedAt: Date.now(), mutationSeq: 7, editSeq: 1 } as never;
  });
  const stop = startOutgoingQueue();
  try {
    await vi.waitFor(async () => {
      expect(api.put).toHaveBeenCalled();
      expect(api.post).toHaveBeenCalledWith("/api/messages/edit", editBody());
      expect(await getOutgoingOperation(held === "file" ? "edit" : "message")).toBeUndefined();
    });
    expect(await getOutgoingOperation(held === "file" ? "message" : "edit")).toBeDefined();
    expect(request.mock.calls.map(([name]) => name)).toEqual(expect.arrayContaining([
      "e2ee-outgoing:alice:device:chat", "e2ee-outgoing-edit:alice:device:original",
    ]));
  } finally {
    release();
    await vi.waitFor(async () => expect(await getAllOutgoing()).toEqual([]));
    stop();
  }
});

it("serializes competing retries for the same edit target across tabs", async () => {
  await seedEdit();
  const tails = new Map<string, Promise<unknown>>();
  const request = vi.fn((name: string, callback: () => Promise<unknown>) => {
    const task = (tails.get(name) ?? Promise.resolve()).then(callback);
    tails.set(name, task.catch(() => undefined));
    return task;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  let release!: (value: never) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  const first = retryOutgoing("edit");
  await vi.waitFor(() => expect(api.post).toHaveBeenCalledOnce());
  vi.resetModules();
  const otherTab = await import("./outgoingQueue.js");
  const retry = otherTab.retryOutgoing("edit");
  try {
    await vi.waitFor(() => expect(request.mock.calls.map(([name]) => name))
      .toEqual(Array(2).fill("e2ee-outgoing-edit:alice:device:original")));
    expect(api.post).toHaveBeenCalledOnce();
  } finally {
    release({ editedAt: Date.now(), mutationSeq: 7, editSeq: 1 } as never);
    await Promise.all([first, retry]);
  }
  expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/messages/edit", editBody());
  expect(await getOutgoingOperation("edit")).toBeUndefined();
});

it("F4: a failed attempt cannot recreate an entry deleted by another tab without Web Locks", async () => {
  vi.stubGlobal("navigator", {});
  await seed();
  let reject!: (error: unknown) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  const sending = retryOutgoing("message");
  await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  vi.resetModules();
  const otherTab = await import("./outgoingQueue.js");
  await otherTab.discardOutgoing("message");
  reject(networkError());
  await sending;
  expect(await getOutgoing("message")).toBeUndefined();
  expect(await getMessageById("message")).toBeUndefined();
});

it("R3-F3: a pending file PUT does not block text sends in another conversation", async () => {
  await seed({ upload: { bytes: new Uint8Array([1, 2]), mimeType: "image/png", uploadUrl: "/slow-upload" }, fileId: "file" });
  let finishUpload!: (value: never) => void;
  vi.mocked(api.put).mockReturnValueOnce(new Promise((resolve) => { finishUpload = resolve; }));
  const sendingFile = retryOutgoing("message");
  await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  const first = (await getOutgoing("message"))!;
  const message = (await getMessageById("message"))!;
  await saveQueuedMessage({ ...message, id: "other-text", conversationId: "other", content: "other text" }, {
    ...first, id: "other-text", queuedAt: 2, conversationId: "other", upload: undefined, fileId: undefined,
  });
  vi.mocked(api.get).mockImplementation(async (path) => ({ id: path.endsWith("/other") ? "other" : "chat", type: "direct", members: [] }) as never);
  vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (conversation, id) => ({ ...body, conversationId: conversation.id, messages: [{ ...body.messages[0], id }] }) as never);
  const sendingText = retryOutgoing("other-text");
  try {
    await vi.waitFor(async () => expect(await getOutgoing("other-text")).toBeUndefined());
    expect(await getOutgoing("message")).toBeDefined();
    expect(api.post).toHaveBeenCalledWith("/api/messages/send-direct-batch", expect.objectContaining({ conversationId: "other" }));
  } finally {
    finishUpload({ success: true } as never);
    await Promise.all([sendingFile, sendingText]);
  }
});

it("repairs a legacy localized interrupted-file error without loading its locale", async () => {
  await seed({ retryable: false, status: "failed", error: "Die Dateiverschlüsselung wurde unterbrochen. Hängen Sie die Datei erneut an." });
  const message = (await getMessageById("message"))!;
  await saveMessage({ ...message, type: "file" });
  await refreshOutgoingQueue();
  expect((await getOutgoing("message"))!.error).toBe("fileEncryptionWasInterruptedAttachTheFileAgain");
});

it("normalizes a legacy error without overwriting newer queue progress", async () => {
  await seed({ error: "old diagnostic" });
  const { updateOutgoingErrorIfUnchanged, updateOutgoingIfPresent } = await import("../../db/index.js");
  const row = (await getOutgoing("message"))!;
  await updateOutgoingIfPresent({ ...row, attempts: 3, steps: [{ path: "/api/messages/send-direct-batch", body: body as never }] });
  await updateOutgoingErrorIfUnchanged("message", "old diagnostic", "messageNotSent", "alice");
  expect(await getOutgoing("message")).toMatchObject({ attempts: 3, error: "messageNotSent", steps: [{ path: "/api/messages/send-direct-batch" }] });
  await updateOutgoingErrorIfUnchanged("message", "old diagnostic", "fileExpired", "alice");
  expect((await getOutgoing("message"))!.error).toBe("messageNotSent");
});

it("persists and displays Sending while a retry of a transient failure is in flight", async () => {
  await seed();
  vi.mocked(api.post).mockRejectedValueOnce(networkError());
  await retryOutgoing("message");
  expect(await getMessageById("message")).toMatchObject({ status: "failed" });
  let finish!: (value: unknown) => void;
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => { dispatched = resolve; });
  vi.mocked(api.post).mockImplementationOnce(() => {
    dispatched(); return new Promise((resolve) => { finish = resolve; });
  });
  const retry = retryOutgoing("message");
  await started;
  try {
    expect(await getMessageById("message")).toMatchObject({ status: "sending" });
    expect(useChatStore.getState().messages.get("chat")?.[0]).toMatchObject({ status: "sending" });
  } finally { finish(response); await retry; }
  expect(await getMessageById("message")).toMatchObject({ status: "sent" });
});

it.each(["direct", "group"] as const)("completes a deleted %s replay and unblocks the next message without restoring plaintext", async (conversationType) => {
  vi.mocked(api.get).mockResolvedValue({ id: "chat", type: conversationType, members: [] });
  await seed({ conversationType });
  await queueText("later", 2);
  // A possibly submitted group envelope blocks its successor until its replay receipt arrives.
  vi.mocked(api.post).mockRejectedValueOnce(networkError());
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ status: "failed" });
  vi.mocked(api.post).mockResolvedValueOnce({ ...response, deleted: true, deletedAt: 500, deletedByUserId: "alice" });
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toBeUndefined();
  expect(await getMessageById("message")).toMatchObject({ content: "", deletedAt: 500 });
  expect(useChatStore.getState().messages.get("chat")?.find((message) => message.id === "message")).toMatchObject({ content: "", deletedAt: 500 });
  await retryOutgoing("later");
  expect(await getOutgoing("later")).toBeUndefined();
  expect(await getMessageById("later")).toMatchObject({ status: "sent" });
});

it("scopes a deleted outbox receipt to its owner even when the display row is missing", async () => {
  await seed();
  vi.mocked(api.post).mockRejectedValueOnce(networkError());
  await retryOutgoing("message");
  await (await getAppDB()).delete("displayMessages", ["alice", "message"]);
  vi.mocked(api.post).mockResolvedValueOnce({ ...response, deleted: true, deletedAt: 500, deletedByUserId: "alice" });
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toBeUndefined();
  expect(await getMessageDeletion("message", "alice")).toMatchObject({ ownerId: "alice", deletedAt: 500 });
  expect(await getMessageDeletion("message", "carol")).toBeUndefined();
});

it.each(["hide", "delete"])("guards the persisted send receipt when another tab races its publication with %s", async (kind) => {
  const { openDB } = await import("idb");
  await seed();
  const db = await getAppDB(), tabB = await openDB(db.name);
  const get = IDBObjectStore.prototype.get;
  let raced: Promise<unknown> | undefined;
  const read = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
    const request = get.call(this, key);
    if (this.name === "displayMessages" && this.transaction.mode === "readonly" && Array.isArray(key) && key[0] === "alice" && key[1] === "message") {
      request.addEventListener("success", () => {
        if (raced || request.result?.status !== "sent") return;
        const tx = tabB.transaction("accountState", "readwrite");
        raced = Promise.all([tx.store.put(kind === "hide"
          ? { id: messageHideKey("message", "alice"), ownerId: "alice", undoToken: "other-tab-undo", undoDeadline: Date.now() + 5000 }
          : { id: "deleted-message:message", deletedAt: 500, deletedByUserId: "alice", conversationId: "chat" }), tx.done]);
      });
    }
    return request;
  });
  try {
    await retryOutgoing("message");
    expect(raced).toBeDefined();
    await raced;
    const displayed = useChatStore.getState().messages.get("chat")?.find((message) => message.id === "message");
    if (kind === "hide") {
      expect(displayed).toBeUndefined();
      // Pending Undo deliberately retains the record. Its presence must not imply visibility.
      expect((await getMessageById("message"))?.content).toBe("private text");
    } else expect(displayed).toMatchObject({ content: "", deletedAt: 500 });
  } finally { read.mockRestore(); tabB.close(); }
});
