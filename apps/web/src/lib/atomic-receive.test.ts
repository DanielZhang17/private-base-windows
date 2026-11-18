import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDistribution, generateIdentityKeyPair, generateSenderKey, initSessionAsInitiator,
  concat, encryptMessageEdit, generateAESKey, ratchetEncrypt, ratchetDecrypt, senderKeyEncrypt, toBase64Url, x3dhInitiate,
  type EditKeyToSeal, type IdentityKeyPair,
  type RatchetSession,
} from "@e2ee-chat/crypto";
import { WSFrameType, type InitialMessageHeader, type MessageEditFrame, type WSMessageFrame } from "@e2ee-chat/shared";
import { stickerToken } from "./stickers.js";

const fixtures = vi.hoisted(() => ({ auth: { sessionId: "login" as string | null, user: { id: "bob" } as { id: string } | null, device: { id: "bob-device" } as { id: string } | null }, conversationType: "direct", metadataErrors: {} as Record<string, unknown>, get: vi.fn(), post: vi.fn(), markKeyReady: vi.fn() }));
vi.mock("../services/api.js", () => ({ api: { get: fixtures.get, post: fixtures.post } }));
vi.mock("../stores/authStore.js", () => ({ useAuthStore: { getState: () => fixtures.auth } }));
vi.mock("../stores/callStore.js", () => ({ useCallStore: { getState: () => ({ markKeyReady: fixtures.markKeyReady }) } }));
vi.mock("./conversation-cache.js", () => ({
  getCachedConversation: (id: string) => id in fixtures.metadataErrors ? undefined : ({ id, type: id === "other" ? "direct" : fixtures.conversationType }),
  ensureConversationInCache: async (id: string) => { throw fixtures.metadataErrors[id]; }, upsertConversationInCache: vi.fn(), touchConversationInCache: vi.fn(),
}));
const password = "receive-test-password";
const testCallKey = toBase64Url(new Uint8Array(32));
let database: typeof import("../db/index.js");
let sync: typeof import("./message-sync.js");
let keys: typeof import("./key-manager.js");
let chat: typeof import("../stores/chatStore.js");
let sender: RatchetSession;
let author: IdentityKeyPair;
let initial: InitialMessageHeader;
const saveOwnedMessage = (row: import("../db/index.js").LocalMessage) => database.saveMessage(row, undefined, row.ownerId ?? "bob");
const encode = (value: string) => new TextEncoder().encode(value);

async function reload() {
  sync.resetMessageSyncState();
  (await database.getAppDB()).close();
  keys.lockLocalCryptoState();
  vi.resetModules();
  database = await import("../db/index.js");
  keys = await import("./key-manager.js");
  sync = await import("./message-sync.js");
  chat = await import("../stores/chatStore.js");
  chat.useChatStore.setState({ messages: new Map(), unreadCounts: new Map(), activeConversationId: "conv" });
  await keys.loadKeys(password);
}
async function direct(id: string, text = id, bootstrap = false, msgType: WSMessageFrame["msgType"] = "text", editKey?: EditKeyToSeal) {
  const encrypted = await ratchetEncrypt(sender, encode(text), editKey);
  return frame(id, msgType, {
    ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv),
    header: JSON.stringify({ ...encrypted.header, recipientDeviceId: "bob-device", ...(bootstrap ? { initial } : {}), editKey: encrypted.sealedEditKey }),
  });
}
function frame(id: string, msgType: WSMessageFrame["msgType"], encrypted: Pick<WSMessageFrame, "ciphertext" | "iv" | "header">): WSMessageFrame {
  return {
    type: WSFrameType.Message, id, conversationId: "conv", senderId: "alice", senderDeviceId: "alice-device",
    msgType, ...encrypted, timestamp: Date.now(), expiresAt: Date.now() + 60_000, expiryKind: "retention",
  };
}
/** Abort an actual IDB transaction after its output write was enqueued, after all crypto. */
function crashOnOutput(storeName = "displayMessages") {
  const original = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = original.apply(this, args);
    if (this.name === storeName) this.transaction.abort();
    return request;
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  fixtures.post.mockReset().mockResolvedValue({ edits: [] });
  fixtures.auth = { sessionId: "login", user: { id: "bob" }, device: { id: "bob-device" } };
  fixtures.conversationType = "direct";
  fixtures.metadataErrors = {};
  database = await import("../db/index.js");
  const db = await database.getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  keys = await import("./key-manager.js");
  await keys.initializeKeys(password);
  sync = await import("./message-sync.js");
  sync.resetMessageSyncState();
  chat = await import("../stores/chatStore.js");
  chat.useChatStore.setState({ messages: new Map(), unreadCounts: new Map(), activeConversationId: "conv" });
  const alice = author = await generateIdentityKeyPair();
  const bob = keys.getIdentityKeyPair();
  const signed = keys.getSignedPreKey()!;
  const otp = keys.peekOneTimePreKey(1)!;
  const result = await x3dhInitiate(alice.privateX25519, alice.publicEd25519, {
    deviceId: "bob-device", identityKey: toBase64Url(bob.publicEd25519),
    signedPreKey: toBase64Url(signed.keyPair.publicKey), signedPreKeyId: signed.id,
    signedPreKeySig: toBase64Url(signed.signature), oneTimePreKey: { id: otp.id, key: toBase64Url(otp.keyPair.publicKey) },
  });
  sender = await initSessionAsInitiator(result.sharedSecret, signed.keyPair.publicKey);
  initial = { identityKey: toBase64Url(alice.publicEd25519), ephemeralKey: toBase64Url(result.ephemeralPublicKey), signedPreKeyId: signed.id, oneTimePreKeyId: otp.id };
});
afterEach(() => { sync.resetMessageSyncState(); vi.useRealTimers(); vi.restoreAllMocks(); keys.lockLocalCryptoState(); });

describe("atomic receive crash recovery", () => {
  it.each(["initial", "normal", "skipped", "group"])("replays a %s message after abort and fresh modules using the same IDB", async (kind) => {
    let envelope: WSMessageFrame;
    if (kind === "group") {
      fixtures.conversationType = "group";
      const group = await generateSenderKey();
      await sync.ingestMessageFrame(await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution"));
      const encrypted = await senderKeyEncrypt(group, encode("recoverable"));
      envelope = frame("target", "text", { ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv), header: JSON.stringify(encrypted.header) });
    } else {
      if (kind !== "initial") {
        await sync.ingestMessageFrame(await direct("first", "first", true));
        const { encryptForDevice } = await import("./session-manager.js");
        const reply = await encryptForDevice("alice", "alice-device", encode("reply"));
        await ratchetDecrypt(sender, reply.result.header, reply.result.ciphertext, reply.result.iv);
      }
      envelope = await direct("target", "recoverable", kind === "initial");
      if (kind === "skipped") await sync.ingestMessageFrame(await direct("later"));
    }
    const db = await database.getAppDB();
    const before = { sessions: await db.getAll("receiveSessions"), senderKeys: await db.getAll("receiveSenderKeys") };
    const crash = crashOnOutput();
    await expect(sync.ingestMessageFrame(envelope)).rejects.toThrow();
    crash.mockRestore();
    expect(await database.getMessageById("target")).toBeUndefined();
    expect({ sessions: await db.getAll("receiveSessions"), senderKeys: await db.getAll("receiveSenderKeys") }).toEqual(before);
    if (kind === "initial") expect(keys.peekOneTimePreKey(1)).toBeDefined();
    await reload();
    await sync.ingestMessageFrame(envelope);
    expect(await database.getMessageById("target")).toMatchObject({ content: "recoverable", status: "delivered" });
    const reloaded = await database.getAppDB();
    for (const record of await reloaded.getAll("receiveSessions")) {
      expect(JSON.parse(record.state).rootKey).toEqual(expect.any(String));
    }
    for (const record of await reloaded.getAll("receiveSenderKeys")) {
      expect(record.chainKey).toEqual(expect.any(String));
      expect(record).not.toHaveProperty("state");
    }
    if (kind === "initial") expect(keys.peekOneTimePreKey(1)).toBeUndefined();
    if (kind === "skipped") {
      const state = JSON.parse((await database.getSession("alice:alice-device"))!.state);
      expect(state.skippedKeys).toEqual([]);
    }
  });
});


it.each(["direct", "group"])("skips stored %s messages before crypto and leaves the state byte-for-byte unchanged", async (kind) => {
  let envelope: WSMessageFrame;
  if (kind === "direct") {
    envelope = await direct("stored", "stored plaintext", true);
  } else {
    fixtures.conversationType = "group";
    const group = await generateSenderKey();
    await sync.ingestMessageFrame(await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution"));
    const encrypted = await senderKeyEncrypt(group, encode("stored plaintext"));
    envelope = frame("stored", "text", { ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv), header: JSON.stringify(encrypted.header) });
  }
  await sync.ingestMessageFrame(envelope);
  await reload();
  const db = await database.getAppDB();
  const before = { sessions: await db.getAll("receiveSessions"), senderKeys: await db.getAll("receiveSenderKeys") };
  const decrypt = vi.spyOn(crypto.subtle, "decrypt");
  await sync.ingestMessageFrame(envelope);
  expect(decrypt).not.toHaveBeenCalled();
  expect({ sessions: await db.getAll("receiveSessions"), senderKeys: await db.getAll("receiveSenderKeys") }).toEqual(before);
  expect(await database.getMessageById("stored")).toMatchObject({ content: "stored plaintext" });
});

it.each(["sender_key_distribution", "system", "key_exchange"] as const)("commits a %s effect and receipt atomically with its ratchet", async (kind) => {
  const group = await generateSenderKey();
  const payload = kind === "sender_key_distribution"
    ? { conversationId: "conv", distribution: createDistribution(group) }
    : kind === "system"
      ? { kind: "call_offer", callId: "call", conversationId: "conv", initiatorId: "alice", callType: "audio", callKey: testCallKey, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }
      : { kind: "control" };
  const envelope = await direct("control", JSON.stringify(payload), true, kind);
  const db = await database.getAppDB();
  const crash = crashOnOutput(kind === "sender_key_distribution" ? "receiveSenderKeys" : kind === "system" ? "receivePendingCalls" : "accountState");
  await expect(sync.ingestMessageFrame(envelope)).rejects.toThrow();
  crash.mockRestore();
  expect(await db.getAll("receiveSessions")).toEqual([]);
  expect(await db.getAll("receiveSenderKeys")).toEqual([]);
  expect(await db.getAll("receivePendingCalls")).toEqual([]);
  expect(await db.get("accountState", database.receiveKey("received:", "control", "bob", "bob-device"))).toBeUndefined();
  expect(fixtures.markKeyReady).not.toHaveBeenCalled();
  await reload();
  await sync.ingestMessageFrame(envelope);
  const reopened = await database.getAppDB();
  expect(await reopened.get("accountState", database.receiveKey("received:", "control", "bob", "bob-device"))).toEqual({ id: database.receiveKey("received:", "control", "bob", "bob-device"), ownerId: "bob", deviceId: "bob-device", expiresAt: envelope.expiresAt, ...(kind === "system" ? { pendingCallId: "call" } : kind === "key_exchange" ? { failure: "terminal_receive_error" } : {}) });
  expect(await database.getMessageById("control")).toBeUndefined();
  if (kind === "system") {
    expect(await database.getPendingCall("call")).toMatchObject({ callKey: testCallKey });
    expect(fixtures.markKeyReady).toHaveBeenCalledExactlyOnceWith("call", true);
  }
  if (kind === "sender_key_distribution") expect(await reopened.getAll("receiveSenderKeys")).toHaveLength(1);
  const before = await reopened.getAll("receiveSessions");
  const decrypt = vi.spyOn(crypto.subtle, "decrypt");
  await sync.ingestMessageFrame(envelope);
  expect(decrypt).not.toHaveBeenCalled();
  expect(await reopened.getAll("receiveSessions")).toEqual(before);
  expect(chat.useChatStore.getState().messages.size).toBe(0);
});

it("serializes distinct messages through the commit, with no advanced state visible before it", async () => {
  await sync.ingestMessageFrame(await direct("initial", "initial", true));
  const first = await direct("first");
  const second = await direct("second");
  const commit = database.commitReceivedMessage;
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const committed = vi.spyOn(database, "commitReceivedMessage").mockImplementationOnce(async (...args) => {
    started();
    await gate;
    return commit(...args);
  });
  const pendingFirst = sync.ingestMessageFrame(first);
  await ready;
  const pendingSecond = sync.ingestMessageFrame(second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(committed).toHaveBeenCalledTimes(1);
  expect(await database.getMessageById("first")).toBeUndefined();
  expect(await database.getMessageById("second")).toBeUndefined();
  release();
  await Promise.all([pendingFirst, pendingSecond]);
  expect(await database.getMessageById("first")).toMatchObject({ content: "first" });
  expect(await database.getMessageById("second")).toMatchObject({ content: "second" });
  expect(JSON.parse((await database.getSession("alice:alice-device"))!.state).recvMessageNumber).toBe(3);
});

it.each([true, false])("shows a failed message for an already advanced legacy initial (bootstrap metadata: %s), without rebuilding or rolling back", async (metadata) => {
  const envelope = await direct("lost", "lost plaintext", true);
  await sync.ingestMessageFrame(envelope);
  const db = await database.getAppDB();
  // Recreate the previous build's split-write crash, retaining its advanced ratchet.
  const session = (await database.getSession("alice:alice-device"))!;
  if (!metadata) delete session.x3dhEphemeralKey;
  await db.put("receiveSessions", session);
  await db.delete("displayMessages", ["bob", "lost"]);
  await db.delete("accountState", database.receiveKey("received:", "lost", "bob", "bob-device"));
  await reload();
  const reopened = await database.getAppDB();
  const before = await reopened.getAll("receiveSessions");
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await sync.ingestMessageFrame(envelope);
  expect(await database.getMessageById("lost")).toMatchObject({ status: "failed", content: "" });
  expect(chat.useChatStore.getState().messages.get("conv")).toMatchObject([{ id: "lost", status: "failed" }]);
  expect(await reopened.getAll("receiveSessions")).toEqual(before);
  log.mockRestore();
});

it("never resets a sender chain when another distribution for the same key arrives", async () => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey();
  const payload = JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) });
  await sync.ingestMessageFrame(await direct("distribution", payload, true, "sender_key_distribution"));
  const encrypted = await senderKeyEncrypt(group, encode("group text"));
  await sync.ingestMessageFrame(frame("group", "text", { ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv), header: JSON.stringify(encrypted.header) }));
  const db = await database.getAppDB();
  const before = await db.getAll("receiveSenderKeys");
  await sync.ingestMessageFrame(await direct("distribution-again", payload, false, "sender_key_distribution"));
  expect(await db.getAll("receiveSenderKeys")).toEqual(before);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function groupEnvelope(id: string, group: Awaited<ReturnType<typeof generateSenderKey>>, editKey?: EditKeyToSeal) {
  const encrypted = await senderKeyEncrypt(group, encode("group plaintext"), editKey);
  return frame(id, "text", { ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv),
    header: JSON.stringify({ ...encrypted.header, editKey: encrypted.sealedEditKey }) });
}

const editScope = { messageId: "original", conversationId: "conv", senderId: "alice", senderDeviceId: "alice-device" };

function editCompanion(key: Uint8Array, scope = editScope): EditKeyToSeal {
  return { scope, bytes: concat(key, author.publicEd25519) };
}

async function revision(key: Uint8Array, editSeq: number, content = "revised " + editSeq, scope = editScope): Promise<MessageEditFrame> {
  return { ...scope, ...await encryptMessageEdit(key, author.privateEd25519, scope, editSeq, content),
    editSeq, mutationSeq: 10 + editSeq, editedAt: Date.now(), expiresAt: Date.now() + 60_000 };
}

async function waitForRevision(id: string, content: string) {
  await vi.waitFor(async () => expect(await database.getMessageById(id)).toMatchObject({ content }), { timeout: 7_000 });
}

async function editLookupRate() {
  return (await database.getAppDB()).get("accountState", "edit-lookup-rate:bob:bob-device");
}

it.each(["direct", "group"] as const)("pulls a %s edit when the original arrives after a dropped hint", async (kind) => {
  const key = generateAESKey();
  let original: WSMessageFrame;
  if (kind === "group") {
    fixtures.conversationType = "group";
    const group = await generateSenderKey();
    await sync.ingestMessageFrame(await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution"));
    original = await groupEnvelope("original", group, editCompanion(key));
  } else {
    original = await direct("original:bob-device", "original", true, "text", editCompanion(key));
  }
  const before = await database.getSession("alice:alice-device");
  await sync.ingestMessageEdit(await revision(key, 2));
  await sync.ingestMessageEdit(await revision(key, 1));
  expect(await database.getSession("alice:alice-device")).toEqual(before);
  expect(await database.getMessageById(original.id)).toBeUndefined();
  const db = await database.getAppDB();
  const latest = await revision(key, 2);
  expect(fixtures.post).not.toHaveBeenCalled();
  expect(JSON.stringify(await db.getAll("accountState"))).not.toContain("pending-message-edit:");
  fixtures.post.mockResolvedValueOnce({ edits: [latest] });
  await sync.ingestMessageFrame({ ...original, latestEditSeq: 2 });
  await waitForRevision(original.id, "revised 2");
  expect(fixtures.post).toHaveBeenCalledExactlyOnceWith("/api/messages/edits/latest", { ids: ["original"], after: { original: 0 } });
  expect(await database.getMessageById(original.id, "bob", undefined, true)).toMatchObject({
    content: "revised 2", status: "delivered", editKey: toBase64Url(key), editSequence: 2,
    editSigningKey: toBase64Url(author.publicEd25519), editSenderDeviceId: "alice-device",
  });
  expect(chat.useChatStore.getState().messages.get("conv")).toMatchObject([{ id: "original", content: "revised 2" }]);
  const ratchet = await database.getSession("alice:alice-device");
  await sync.ingestMessageEdit(await revision(key, 3));
  expect(await database.getSession("alice:alice-device")).toEqual(ratchet);
  await sync.ingestMessageFrame({ ...await direct("ordinary", "ordinary"), conversationId: "other" });
  expect(await database.getMessageById("ordinary")).toMatchObject({ content: "ordinary" });
});

it("pulls a revision queued after a deferred original even when its frame advertised no edits", async () => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey(), key = generateAESKey();
  const distribution = await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution");
  const original = { ...await groupEnvelope("original", group, editCompanion(key)), latestEditSeq: null };
  await sync.ingestMessageFrame(original);
  expect(await database.getMessageById("original")).toBeUndefined();
  const edit = await revision(key, 1);
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [{ edit, mutationSeq: 11 }], mutationCursor: 11 });
  await sync.syncMessages({ force: true });
  expect(await database.getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: 11 });
  expect(fixtures.post).not.toHaveBeenCalled();
  fixtures.post.mockResolvedValueOnce({ edits: [edit] });
  await sync.ingestMessageFrame(distribution);
  await waitForRevision("original", "revised 1");
  expect(fixtures.post).toHaveBeenCalledExactlyOnceWith("/api/messages/edits/latest", { ids: ["original"], after: { original: 0 } });
  expect(await database.getMessageById("original")).toMatchObject({ content: "revised 1", editSequence: 1 });
});

it("ignores an edit on a device with only a legacy original and no edit key", async () => {
  const original = await direct("original", "legacy text", true);
  await sync.ingestMessageFrame(original);
  await sync.ingestMessageEdit(await revision(generateAESKey(), 1));
  expect(await database.getMessageById("original")).toMatchObject({ content: "legacy text" });
  expect((await database.getMessageById("original", "bob", undefined, true))?.editKey).toBeUndefined();
});

it("consumes a revision cleanly when a legacy tab committed the keyed original first", async () => {
  const key = generateAESKey();
  const original = await direct("original", "unchanged legacy text", true, "text", editCompanion(key));
  // The legacy client decrypts the same body with the same ratchet and ignores
  // the unknown header field. Replaying that field cannot rewind the ratchet.
  const { editKey, ...legacyHeader } = JSON.parse(original.header);
  await sync.ingestMessageFrame({ ...original, header: JSON.stringify(legacyHeader) });
  const before = await database.getSession("alice:alice-device");
  const edit = await revision(key, 1);
  fixtures.get.mockResolvedValue({ messages: [{ ...original, latestEditSeq: 1 }], hasMore: false, editStream: true, mutations: [{ edit, mutationSeq: 11 }], mutationCursor: 11 });
  await sync.syncMessages({ force: true });
  expect(await database.getSession("alice:alice-device")).toEqual(before);
  expect(await database.getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: 11 });
  expect(fixtures.post).not.toHaveBeenCalled();
  expect(await database.getMessageById(original.id)).toMatchObject({ content: "unchanged legacy text" });
  expect((await database.getMessageById(original.id, "bob", undefined, true))?.editKey).toBeUndefined();
});

it.each([false, undefined])("honors a negative key receipt separately from an omitted legacy field (%s)", async (editKeyAccepted) => {
  const key = generateAESKey();
  const original = await direct("original", "rollback text", true, "text", editCompanion(key));
  await sync.ingestMessageFrame({ ...original, editKeyAccepted });
  expect((await database.getMessageById(original.id, "bob", undefined, true))?.editKey).toBe(editKeyAccepted === false ? undefined : toBase64Url(key));

  // A negative authoritative receipt also supersedes an earlier legacy echo.
  await sync.ingestMessageFrame({ ...original, editKeyAccepted: false, latestEditSeq: 1 });
  await sync.ingestMessageEdit(await revision(key, 1));
  await sync.reconcileConversationEdits("conv");
  expect(await database.getMessageById(original.id)).toMatchObject({ content: "rollback text" });
  expect((await database.getMessageById(original.id, "bob", undefined, true))?.editKey).toBeUndefined();
  expect(chat.useChatStore.getState().messages.get("conv")?.[0]?.editKeyAccepted).toBeUndefined();
  expect((await (await database.getAppDB()).getAllKeys("accountState")).some((id) => String(id).startsWith("edit-lookup:"))).toBe(false);
  expect(fixtures.post).not.toHaveBeenCalled();
});

it("forgets cached and in-flight edit credentials while keeping committed text", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original text", true, "text", editCompanion(key)));
  await sync.ingestMessageEdit(await revision(key, 1, "committed revision"));
  const db = await database.getAppDB();
  const message = (await database.getMessageById("original", "bob", undefined, true))!;
  expect(message.editKey).toBe(toBase64Url(key));
  await db.put("displayMessages", { ...message, id: "inline-legacy", content: "cached text" });
  const token = await database.getEditKeyResetToken();

  keys.lockLocalCryptoState();
  expect((await database.getMessageById("original", "bob", undefined, true))?.editKey).toBeUndefined();
  await keys.resetLocalCryptoState();
  expect(await database.getEditKeyResetToken()).not.toBe(token);
  await keys.initializeKeys(password);
  await database.commitReceivedMessage("late-original", {
    ownerId: "bob", message: { ...message, id: "late-original", content: "late text" }, expiresAt: message.expiresAt!, editKeyResetToken: token,
  });

  expect((await db.getAllKeys("accountState")).filter((id) => String(id).startsWith("message-edit-state:"))).toEqual([]);
  for (const [id, content] of [["original", "committed revision"], ["inline-legacy", "cached text"], ["late-original", "late text"]]) {
    const restored = await database.getMessageById(id, "bob", undefined, true);
    expect(restored).toMatchObject({ content });
    expect(restored?.editKey).toBeUndefined();
    expect(restored?.editSigningKey).toBeUndefined();
    expect(restored?.editKeyAccepted).toBeUndefined();
  }
});

it("wraps edit keys on receipt and queues only ciphertext while locked across a reload", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  const db = await database.getAppDB();
  const edit = await revision(key, 2, "second encrypted revision");
  const stored = await db.get("accountState", 'message-edit-state:["bob","original"]');
  expect(stored).toMatchObject({ wrappedKey: { iv: expect.any(String), ciphertext: expect.any(String) } });
  expect(JSON.stringify([await db.get("displayMessages", ["bob", "original"]), stored])).not.toContain(toBase64Url(key));
  expect(chat.useChatStore.getState().messages.get("conv")?.[0]).not.toHaveProperty("editKey");
  expect((await database.getMessageById("original", "bob", undefined, true))?.editKey).toBe(toBase64Url(key));

  keys.lockLocalCryptoState();
  expect((await database.getMessageById("original", "bob", undefined, true))?.editKey).toBeUndefined();
  await sync.ingestMessageEdit(edit);
  const earlier = await revision(key, 1, "earlier encrypted revision");
  await sync.ingestMessageEdit(earlier);
  const queuedIds = await database.lockedEditIds("bob:bob-device");
  expect(await Promise.all(queuedIds.map(database.readLockedEdit))).toEqual([edit, earlier]);
  expect(await database.getMessageById("original")).toMatchObject({ content: "original" });
  await reload();
  fixtures.get.mockRejectedValueOnce(new TypeError("Offline"));
  await expect(sync.runUnlockSync()).rejects.toThrow("Offline");
  expect(await database.getMessageById("original")).toMatchObject({ content: "second encrypted revision", editSequence: 2 });
  expect(await database.lockedEditIds("bob:bob-device")).toEqual([]);
});

it("discards an authenticated sticker replacement from the locked edit queue after unlock", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  keys.lockLocalCryptoState();
  const edit = await revision(key, 1, stickerToken("genshin_hoyolab_21"));
  await sync.ingestMessageEdit(edit);
  expect(await database.lockedEditIds("bob:bob-device")).toHaveLength(1);

  await reload();
  fixtures.get.mockRejectedValueOnce(new TypeError("Offline"));
  await expect(sync.runUnlockSync()).rejects.toThrow("Offline");
  expect(await database.getMessageById("original")).toMatchObject({ content: "original" });
  expect(await database.lockedEditIds("bob:bob-device")).toEqual([]);
});

it.each([true, false])("applies a locked fallback after rejecting a newer unauthentic revision (legacy queue=%s)", async (legacyQueue) => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  keys.lockLocalCryptoState();
  const valid = await revision(key, 1, "valid fallback");
  if (legacyQueue) {
    const id = "locked-message-edit:bob:bob-device:original";
    await (await database.getAppDB()).put("accountState", { id, edit: valid });
  } else await sync.ingestMessageEdit(valid);
  // The author signs both envelopes. Only the first opens with the original edit key.
  await sync.ingestMessageEdit(await revision(generateAESKey(), 2, "invalid newer revision"));
  expect(await database.lockedEditIds("bob:bob-device")).toHaveLength(2);
  await reload();
  fixtures.get.mockRejectedValueOnce(new TypeError("Offline"));
  await expect(sync.runUnlockSync()).rejects.toThrow("Offline");
  expect(await database.getMessageById("original")).toMatchObject({ content: "valid fallback", editSequence: 1 });
  expect(await database.lockedEditIds("bob:bob-device")).toEqual([]);
});

it.each([true, false])("preserves a locked edit through offline unlock of its deferred original (sender key ready=%s)", async (hasSenderKey) => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey(), key = generateAESKey();
  const { prepareRemoteSenderKey } = await import("./group-session.js");
  const senderKey = await prepareRemoteSenderKey("conv", "alice", "alice-device", JSON.stringify(createDistribution(group)));
  const original = await groupEnvelope("original", group, editCompanion(key));
  await sync.ingestMessageFrame(original);
  expect(await database.getMessageById(original.id)).toBeUndefined();

  // Another tab saves the distribution to the shared database without draining this receive.
  if (hasSenderKey) await database.saveSenderKey(senderKey);
  keys.lockLocalCryptoState();
  await sync.ingestMessageEdit(await revision(key, 1, "revision available offline"));
  expect(await database.lockedEditIds("bob:bob-device")).toHaveLength(1);
  await reload();
  fixtures.get.mockRejectedValue(new TypeError("Offline"));
  fixtures.post.mockRejectedValue(new TypeError("Offline"));
  await expect(sync.runUnlockSync()).rejects.toThrow("Offline");
  if (!hasSenderKey) {
    expect(await database.lockedEditIds("bob:bob-device")).toHaveLength(1);
    await database.saveSenderKey(senderKey);
    await expect(sync.runUnlockSync()).rejects.toThrow("Offline");
  }
  expect(await database.getMessageById(original.id)).toMatchObject({ content: "revision available offline", editSequence: 1 });
  expect(await database.lockedEditIds("bob:bob-device")).toEqual([]);
});

it("replays a locked edit when a rollback Worker later delivers its original", async () => {
  const key = generateAESKey();
  const original = await direct("original:bob-device", "original", true, "text", editCompanion(key));
  const edit = await revision(key, 1, "revision from the locked queue");
  keys.lockLocalCryptoState();
  fixtures.get.mockResolvedValueOnce({ messages: [], hasMore: false, mutations: [{ edit, mutationSeq: 11 }], editStream: true, mutationCursor: 11 });
  await sync.syncMessages({ force: true });
  expect(await database.getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: 11 });

  await reload();
  fixtures.post.mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
  fixtures.get.mockResolvedValueOnce({ messages: [], hasMore: false, mutations: [], mutationCursor: 0 });
  await sync.runUnlockSync();
  expect(await database.lockedEditIds("bob:bob-device")).toHaveLength(1);
  expect(await database.getMessageById(original.id)).toBeUndefined();

  fixtures.get.mockResolvedValueOnce({ messages: [original], hasMore: false, mutations: [], mutationCursor: 0 });
  await sync.syncMessages({ force: true });
  expect(await database.getMessageById(original.id)).toMatchObject({ content: "revision from the locked queue", editSequence: 1 });
  expect(await database.lockedEditIds("bob:bob-device")).toEqual([]);
  expect(fixtures.post).not.toHaveBeenCalled();
});

it("reads locked edit ciphertext after only the sync page that can resolve it", async () => {
  const firstKey = generateAESKey(), laterKey = generateAESKey();
  const laterScope = { ...editScope, messageId: "original-later" };
  const pages = [
    await direct("ordinary", "first page", true),
    { ...await direct("original:bob-device", "original", false, "text", editCompanion(firstKey)), latestEditSeq: 1 },
    { ...await direct("original-later:bob-device", "later original", false, "text", editCompanion(laterKey, laterScope)), latestEditSeq: 1 },
  ];
  keys.lockLocalCryptoState();
  const prefix = "locked-message-edit:bob:bob-device:";
  const legacyId = prefix + "original";
  await (await database.getAppDB()).put("accountState", { id: legacyId, edit: await revision(firstKey, 1, "legacy queued revision") });
  await sync.ingestMessageEdit(await revision(laterKey, 1, "later queued revision", laterScope));
  await sync.ingestMessageEdit(await revision(generateAESKey(), 1, "still missing", { ...editScope, messageId: "missing" }));
  await reload();

  const reads: string[] = [], pageReads: string[][] = [];
  const get = IDBObjectStore.prototype.get;
  vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
    if (this.name === "accountState" && this.transaction.mode === "readonly" && typeof key === "string" && key.startsWith(prefix)) reads.push(key);
    return get.call(this, key);
  });
  let nextPage = 0;
  fixtures.get.mockImplementation(async () => {
    if (nextPage) pageReads.push(reads.splice(0));
    else reads.length = 0; // The initial sweep handles originals available before the first page.
    return { messages: [pages[nextPage++]], hasMore: nextPage < pages.length, editStream: true };
  });
  await sync.syncMessages({ force: true });
  pageReads.push(reads);
  expect(pageReads).toEqual([[], [legacyId], [prefix + "original-later:0000000000000001"]]);
  expect(await database.getMessageById(pages[1].id)).toMatchObject({ content: "legacy queued revision", editSequence: 1 });
  expect(await database.getMessageById(pages[2].id)).toMatchObject({ content: "later queued revision", editSequence: 1 });
  expect(await database.lockedEditIds("bob:bob-device")).toEqual([prefix + "missing:0000000000000001"]);
});

it.each([true, false])("reconciles a provisional sender key after a legacy drain with no original replay (confirmed=%s)", async (confirmed) => {
  const key = toBase64Url(generateAESKey());
  const timestamp = Date.now() - 1000;
  await saveOwnedMessage({
    id: "authored", conversationId: "conv", senderId: "bob", type: "text", status: "sending", content: "authored text",
    timestamp, expiresAt: Date.now() + 60_000, editKey: key, editSigningKey: toBase64Url(keys.getIdentityKeyPair().publicEd25519),
    editSenderDeviceId: "bob-device",
  });
  const db = await database.getAppDB();
  await db.put("displayMessages", { ...await db.get("displayMessages", ["bob", "authored"]), status: "sent" });
  await database.saveSyncState("message-sync:bob:bob-device", timestamp, "authored");
  await reload();
  await sync.loadPersistedConversationMessages("conv");
  expect((await database.getMessageById("authored", "bob", undefined, true))?.editKeyAccepted).toBeUndefined();
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [], mutationCursor: 0 });
  fixtures.post.mockResolvedValueOnce({ edits: [], confirmed: confirmed ? ["authored"] : [] });
  await sync.syncConversationMessages("conv");
  await vi.waitFor(async () => {
    expect(await editLookupRate()).toBeDefined();
    expect((await editLookupRate())?.lease).toBeUndefined();
  });
  expect(fixtures.post).toHaveBeenCalledExactlyOnceWith("/api/messages/edits/latest", { ids: ["authored"], after: { authored: 0 }, confirm: true });
  expect((await database.getMessageById("authored", "bob", undefined, true))).toMatchObject({ editKey: key, editKeyAccepted: confirmed ? true : undefined });
  expect(chat.useChatStore.getState().messages.get("conv")?.[0]?.editKeyAccepted).toBe(confirmed ? true : undefined);
});

it("migrates plaintext inline and side-record edit keys using the verified password", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  const db = await database.getAppDB();
  const { wrappedKey, ...old } = await db.get("accountState", 'message-edit-state:["bob","original"]');
  await db.put("accountState", { ...old, editKey: toBase64Url(key) });
  await db.put("displayMessages", { ...await db.get("displayMessages", ["bob", "original"]), id: "inline",
    editKey: toBase64Url(key), editKeyAccepted: true, editSenderDeviceId: old.editSenderDeviceId, editSigningKey: old.editSigningKey });
  keys.lockLocalCryptoState();
  await expect(keys.loadKeys("wrong password")).rejects.toThrow();
  expect((await database.getMessageById("inline", "bob", undefined, true))?.editKey).toBeUndefined();
  await keys.loadKeys(password);
  for (const id of ["original", "inline"]) {
    const state = await db.get("accountState", `message-edit-state:${JSON.stringify(["bob", id])}`);
    expect(state.wrappedKey.iv).not.toBe(wrappedKey.iv);
    expect(state.editKey).toBeUndefined();
    expect((await db.get("displayMessages", ["bob", id])).editKey).toBeUndefined();
    expect((await database.getMessageById(id, "bob", undefined, true))?.editKey).toBe(toBase64Url(key));
  }
  await sync.ingestMessageEdit(await revision(key, 1));
  expect(await database.getMessageById("original")).toMatchObject({ content: "revised 1" });
});

it("updates stale in-memory content from newer cached history after unlock", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  const stale = chat.useChatStore.getState().messages;
  const edit = await revision(key, 1);
  await sync.ingestMessageEdit(edit);
  // The tab can retain its old view while an unlocked peer tab updates IndexedDB.
  keys.lockLocalCryptoState();
  chat.useChatStore.setState({ messages: stale });
  await keys.loadKeys(password);
  await sync.loadPersistedConversationMessages("conv");
  expect(chat.useChatStore.getState().messages.get("conv")).toMatchObject([{ id: "original", content: "revised 1", editSequence: 1 }]);
});

it.each([true, false])("reloads edit eligibility changed by a peer at the same revision (eligible=%s)", async (eligible) => {
  const original = { id: "authored", conversationId: "conv", senderId: "bob", type: "text", status: "sent",
    content: "same committed text", editSequence: 1, timestamp: Date.now(), expiresAt: Date.now() + 60_000,
    editKey: toBase64Url(generateAESKey()), editSigningKey: toBase64Url(keys.getIdentityKeyPair().publicEd25519),
    editSenderDeviceId: "bob-device", editKeyAccepted: eligible ? undefined : true };
  await saveOwnedMessage(original);
  await sync.loadPersistedConversationMessages("conv");
  const visible = () => chat.useChatStore.getState().messages.get("conv")?.[0];
  expect(visible()?.editKeyAccepted).toBe(original.editKeyAccepted);
  expect(await database.reconcileMessageEditKey({ ...original, senderDeviceId: "bob-device" }, eligible, () => true, "bob")).toBe(true);
  await sync.loadPersistedConversationMessages("conv");
  expect(visible()).toMatchObject({ content: original.content, editSequence: 1,
    editKeyAccepted: eligible ? true : undefined, editSenderDeviceId: eligible ? "bob-device" : undefined });
});

it.each([true, false])("publishes the committed key eligibility change to an open peer tab (accepted=%s)", async (accepted) => {
  const original = { id: "authored", conversationId: "conv", senderId: "bob", type: "text", status: "sent",
    content: "original text", timestamp: Date.now(), expiresAt: Date.now() + 60_000, editKey: toBase64Url(generateAESKey()),
    editSigningKey: toBase64Url(keys.getIdentityKeyPair().publicEd25519), editSenderDeviceId: "bob-device", editKeyAccepted: accepted ? undefined : true };
  await saveOwnedMessage(original);
  await sync.loadPersistedConversationMessages("conv");
  const visible = () => chat.useChatStore.getState().messages.get("conv")?.[0];
  expect(visible()?.editKeyAccepted).toBe(original.editKeyAccepted);
  vi.stubGlobal("BroadcastChannel", undefined);
  const { connectLocalMessageChannel } = await import("./local-message-changes.js");
  const peer = sync.startLocalHiddenMessageSync();
  const sender = connectLocalMessageChannel({ userId: "bob", deviceId: "bob-device" }, () => {});
  const storage = vi.spyOn(Storage.prototype, "setItem");
  try {
    expect(await database.reconcileMessageEditKey({ ...original, senderDeviceId: "bob-device" }, accepted, () => true, "bob")).toBe(true);
    expect((await database.getMessageById(original.id))?.editKeyAccepted).toBe(accepted ? true : undefined);
    expect(visible()?.editKeyAccepted).toBe(original.editKeyAccepted);
    expect(storage).toHaveBeenCalledOnce();
    const [[key, newValue]] = storage.mock.calls;
    const { nonce, ...hint } = JSON.parse(newValue);
    expect(typeof nonce).toBe("string");
    expect(hint).toEqual({ id: original.id, conversationId: original.conversationId, kind: "edit" });
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    await vi.waitFor(() => expect(visible()?.editKeyAccepted).toBe(accepted ? true : undefined));
    expect(visible()?.content).toBe(original.content);
  } finally { peer(); sender(); storage.mockRestore(); vi.unstubAllGlobals(); }
});

it("clears a discarded pending edit from the same committed revision after unlock", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  await sync.ingestMessageEdit(await revision(key, 1, "committed revision"));
  const original = (await database.getMessageById("original", "bob", undefined, true))!;
  fixtures.auth = { ...fixtures.auth, user: { id: "alice" }, device: { id: "alice-device" } };
  chat.useChatStore.setState({ messages: new Map() });
  await saveOwnedMessage({ ...original, ownerId: "alice" });
  const authored = (await database.getMessageById(original.id, "alice", undefined, true))!;
  const draft = {
    id: "queued-edit", editTargetId: original.id, conversationId: original.conversationId, conversationType: "direct",
    userId: original.senderId, deviceId: original.editSenderDeviceId!, queuedAt: Date.now(), ttlSeconds: null,
    steps: [{ path: "/api/messages/edit", body: await revision(key, 2, "discarded revision"), sendDispatched: false }],
    status: "failed", retryable: false, attempts: 1, nextAttemptAt: null, error: "messageEditFailed",
  } as const;
  const queued = await database.saveQueuedEdit({ ...draft, steps: [...draft.steps] }, authored.editKeyVersion!, "discarded revision", () => true);
  expect(queued).toMatchObject({ pendingEdit: { content: "discarded revision" }, editSequence: 1 });
  await sync.loadPersistedConversationMessages("conv");
  const visible = () => chat.useChatStore.getState().messages.get("conv")?.[0];
  expect(visible()).toMatchObject({ pendingEdit: { content: "discarded revision" }, editSequence: 1 });
  keys.lockLocalCryptoState();
  // The peer tab can discard an outbox operation using its durable metadata.
  expect(await database.finishQueuedEdit((await database.getOutgoingOperation(draft.id))!, () => true)).toBe(true);
  expect(visible()?.pendingEdit?.content).toBe("discarded revision");
  await keys.loadKeys(password);
  await sync.loadPersistedConversationMessages("conv");
  expect(await database.getOutgoingOperation(draft.id)).toBeUndefined();
  expect(visible()).toMatchObject({ content: "committed revision", pendingEdit: null, editSequence: 1 });
});

it.each(["failed publication", "missed peer hint"])("refreshes a stale visible revision on replay after a %s", async (cause) => {
  const key = generateAESKey();
  const original = await direct("original:bob-device", "original", true, "text", editCompanion(key));
  await sync.ingestMessageFrame(original);
  const store = chat.useChatStore;
  const stale = store.getState().messages;
  const edit = await revision(key, 1);
  const cursor = "message-mutations-edits:bob:bob-device";
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [{ edit, mutationSeq: 11 }], mutationCursor: 11 });
  if (cause === "failed publication") {
    const read = vi.spyOn(database, "getMessageById").mockRejectedValueOnce(new DOMException("Cache read failed", "UnknownError"));
    await expect(sync.syncMessages({ force: true })).rejects.toThrow("Cache read failed");
    read.mockRestore();
  } else {
    await sync.ingestMessageEdit(edit);
    store.setState({ messages: stale });
  }
  expect(await database.getMessageById(original.id)).toMatchObject({ content: "revised 1", editSequence: 1 });
  expect(store.getState().messages.get("conv")?.[0]?.content).toBe("original");
  expect(await database.getSyncState(cursor)).toBeUndefined();

  const decrypt = vi.spyOn(crypto.subtle, "decrypt");
  const write = vi.spyOn(database, "applyReceivedEdit");
  await sync.syncMessages({ force: true });
  expect(store.getState().messages.get("conv")?.[0]).toMatchObject({ content: "revised 1", editSequence: 1 });
  expect(await database.getSyncState(cursor)).toMatchObject({ value: 11 });
  expect(decrypt).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it("refreshes the visible revision if a peer wins the commit after the initial read", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  const apply = database.applyReceivedEdit;
  vi.spyOn(database, "applyReceivedEdit").mockImplementationOnce(async (...args) => {
    expect(await apply(...args)).toMatchObject({ editSequence: 1 });
    return undefined;
  });
  await sync.ingestMessageEdit(await revision(key, 1));
  expect(chat.useChatStore.getState().messages.get("conv")?.[0]).toMatchObject({ content: "revised 1", editSequence: 1 });
});

it("chooses the newest visible cached message as preview after an older edit on cold sync", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  const newer = { ...await direct("newest", "newest visible"), timestamp: Date.now() + 100, serverTimestamp: Date.now() + 100 };
  await sync.ingestMessageFrame(newer);
  await saveOwnedMessage({ ...(await database.getMessageById(newer.id))!, id: "expired", timestamp: newer.timestamp + 1, expiresAt: 1, expiryKind: "timed" });
  chat.useChatStore.setState({ messages: new Map() });
  const edit = await revision(key, 1, "revised older");
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, mutations: [{ edit, mutationSeq: 11 }], editStream: true, mutationCursor: 11 });
  await sync.syncMessages({ force: true });
  expect(await database.getMessageById("original")).toMatchObject({ content: "revised older" });
  expect(chat.useChatStore.getState().messages.get("conv")).toMatchObject([
    { id: newer.id, content: "newest visible", timestamp: newer.serverTimestamp },
  ]);
});

it("keeps an overdue queued timed message as the newest preview after an older edit", async () => {
  const key = generateAESKey(), now = Date.now();
  await sync.ingestMessageFrame({ ...await direct("original", "original", true, "text", editCompanion(key)), timestamp: now - 120_000 });
  await database.saveQueuedMessage({ id: "queued", conversationId: "conv", senderId: "bob", type: "text", content: "timed draft",
    timestamp: now - 90_000, expiresAt: now - 30_000, expiryKind: "timed", status: "failed" }, {
    id: "queued", queuedAt: now - 90_000, conversationId: "conv", conversationType: "direct", userId: "bob", deviceId: "bob-device",
    ttlSeconds: 60, steps: [], attempts: 1, status: "failed", retryable: true, nextAttemptAt: now + 60_000, error: "errorFailedToFetch",
  });
  chat.useChatStore.setState({ messages: new Map() });
  await sync.ingestMessageEdit(await revision(key, 1, "revised older"));
  expect(await database.getMessageById("original")).toMatchObject({ content: "revised older" });
  expect(chat.useChatStore.getState().messages.get("conv")).toMatchObject([{ id: "queued", content: "timed draft", status: "failed" }]);
});

it("replays the original when persisting its latest-edit lookup fails", async () => {
  const key = generateAESKey();
  const original = { ...await direct("original", "original", true, "text", editCompanion(key)), latestEditSeq: 1, serverTimestamp: 101 };
  const lookupId = "edit-lookup:bob:bob-device:original";
  const cursor = "message-sync:bob:bob-device";
  await database.saveSyncState(cursor, 100, "previous");
  fixtures.get.mockResolvedValue({ messages: [original], hasMore: false, mutations: [], editStream: true, mutationCursor: 11 });
  fixtures.post.mockResolvedValueOnce({ edits: [await revision(key, 1)] });
  const put = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (args[0]?.id === lookupId) throw new DOMException("Could not persist lookup", "QuotaExceededError");
    return put.apply(this, args);
  });
  try {
    await expect(sync.syncMessages({ force: true })).rejects.toThrow("Could not persist lookup");
  } finally { fault.mockRestore(); }
  expect(fixtures.post).not.toHaveBeenCalled();
  expect(await database.getMessageById("original")).toMatchObject({ content: "original" });
  expect(await database.getSyncState(cursor)).toMatchObject({ value: 100, cursorId: "previous" });
  expect(await database.getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: 11 });
  await sync.syncMessages({ force: true });
  expect(fixtures.get).toHaveBeenLastCalledWith(expect.stringContaining("since=100"));
  await waitForRevision("original", "revised 1");
  expect(await database.getSyncState(cursor)).toMatchObject({ value: 101, cursorId: "original" });
});

it("repairs a stale original after another tab checkpoints its edit first", async () => {
  const key = generateAESKey();
  const stale = { ...await direct("original:bob-device", "original", true, "text", editCompanion(key)), latestEditSeq: null, serverTimestamp: 101 };
  const edit = await revision(key, 1, "recovered revision");
  const repairId = "edit-repair:bob:bob-device:original";
  fixtures.get.mockResolvedValueOnce({ messages: [], hasMore: false, mutations: [{ edit, mutationSeq: edit.mutationSeq }], editStream: true });
  await sync.syncMessages({ force: true });
  const db = await database.getAppDB();
  expect(await db.get("accountState", repairId)).toEqual({ id: repairId, conversationId: edit.conversationId, senderId: edit.senderId,
    senderDeviceId: edit.senderDeviceId, expiresAt: edit.expiresAt });
  expect(await database.getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: edit.mutationSeq });
  expect(fixtures.post).not.toHaveBeenCalled();

  await reload();
  fixtures.get.mockResolvedValueOnce({ messages: [stale], hasMore: false, mutations: [], editStream: true });
  fixtures.post.mockResolvedValueOnce({ edits: [edit] });
  await sync.syncMessages({ force: true });
  await waitForRevision(stale.id, "recovered revision");
  expect(await (await database.getAppDB()).get("accountState", repairId)).toBeUndefined();
  expect(await database.getSyncState("message-sync:bob:bob-device")).toMatchObject({ cursorId: stale.id, value: 101 });
  expect(fixtures.post).toHaveBeenCalledExactlyOnceWith("/api/messages/edits/latest", { ids: ["original"], after: { original: 0 } });
  await vi.waitFor(() => expect(chat.useChatStore.getState().messages.get("conv")).toMatchObject([{ id: "original", content: "recovered revision" }]));
});

it("pulls all 131 revisions in bounded batches after sync checkpoints their hints first", async () => {
  const edits = new Map<string, MessageEditFrame>(), messages: WSMessageFrame[] = [];
  for (let i = 0; i < 131; i++) {
    const messageId = `original-${i}`, scope = { ...editScope, messageId }, key = generateAESKey();
    const edit = await revision(key, 1, `revised ${i}`, scope);
    edits.set(messageId, { ...edit, mutationSeq: i + 1 });
    messages.push({ ...await direct(messageId, `original ${i}`, i === 0, "text", editCompanion(key, scope)), latestEditSeq: 1 });
  }
  const mutations = [...edits.values()].map((edit) => ({ edit, mutationSeq: edit.mutationSeq }));
  fixtures.get.mockResolvedValueOnce({ messages: [], hasMore: false, editStream: true, mutations, mutationCursor: 131 });
  await sync.syncMessages({ force: true });
  expect(fixtures.post).not.toHaveBeenCalled();
  expect(await database.getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: 131 });
  expect(JSON.stringify(await (await database.getAppDB()).getAll("accountState"))).not.toContain("pending-message-edit:");

  fixtures.get.mockResolvedValueOnce({ messages, hasMore: false, editStream: true, mutations: [], mutationCursor: 131 });
  fixtures.post.mockImplementation(async (_path, { ids }: { ids: string[] }) => ({ edits: ids.map((id) => edits.get(id)) }));
  await sync.syncMessages({ force: true });
  await vi.waitFor(async () => expect((await database.getMessages("conv", 131)).filter((message) => message.editSequence === 1)).toHaveLength(131), { timeout: 7_000 });
  expect(fixtures.post.mock.calls.map(([, body]) => body.ids.length)).toEqual([50, 50, 31]);
  expect(await database.getMessageById("original-130")).toMatchObject({ content: "revised 130" });
}, 12_000);

it("checks only the latest cached window on open and resumes older history from a persisted bookmark", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const key = toBase64Url(generateAESKey());
  const idAt = (i: number) => `original-${String(i).padStart(3, "0")}`;
  const idsFrom = (start: number, count: number) => Array.from({ length: count }, (_, index) => idAt(start + index));
  for (let i = 0; i < 260; i++) await saveOwnedMessage({
    id: idAt(i), conversationId: "conv", senderId: "alice", type: "text", content: "original",
    timestamp: i + 1, expiresAt, status: "delivered", editKeyAccepted: true, editKey: key,
    editSigningKey: toBase64Url(author.publicEd25519), editSenderDeviceId: "alice-device", editSequence: 1,
  });
  await sync.reconcileConversationEdits("conv");
  const bookmark = "edit-history:bob:bob-device:conv";
  await vi.waitFor(() => expect(fixtures.post).toHaveBeenCalledTimes(2), { timeout: 4_000 });
  await vi.waitFor(async () => expect((await editLookupRate())?.lease).toBeUndefined());
  expect(fixtures.post.mock.calls.flatMap(([, body]) => body.ids)).toEqual(idsFrom(160, 100));
  expect(await database.getSyncState(bookmark)).toMatchObject({ cursorId: idAt(160), value: 161 });
  expect(fixtures.post.mock.calls.every(([, body]) => Object.values(body.after).every((seq) => seq === 1))).toBe(true);

  await reload();
  fixtures.post.mockClear();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false });
  await sync.syncMessages({ force: true });
  await vi.waitFor(() => expect(fixtures.post).toHaveBeenCalledExactlyOnceWith("/api/messages/edits/latest", {
    ids: idsFrom(110, 50), after: Object.fromEntries(idsFrom(110, 50).map((id) => [id, 1])),
  }));
  expect(await database.getSyncState(bookmark)).toMatchObject({ cursorId: idAt(110), value: 111 });
}, 12_000);

it.each([[503, 2_000], [429, 60_000]])("advances ordinary sync while latest-edit lookup is in flight and backs off after HTTP %s", async (status, delay) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const key = generateAESKey(), expiresAt = Date.now() + 300_000;
  const original = { ...await direct("original", "original", true, "text", editCompanion(key)), latestEditSeq: 1, serverTimestamp: 101, expiresAt };
  const ordinary = { ...await direct("ordinary", "next page"), conversationId: "other", serverTimestamp: 102, expiresAt };
  const edit = { ...await revision(key, 1), expiresAt };
  let rejectLookup!: (error: Error) => void;
  const response = new Promise<never>((_, reject) => { rejectLookup = reject; });
  fixtures.post.mockReturnValueOnce(response).mockResolvedValue({ edits: [edit] });
  fixtures.get.mockResolvedValueOnce({ messages: [original], hasMore: true, editStream: true, mutations: [], mutationCursor: 11 });
  fixtures.get.mockResolvedValueOnce({ messages: [ordinary], hasMore: false, editStream: true, mutations: [], mutationCursor: 12 });

  await expect(sync.syncMessages({ force: true })).resolves.toBeUndefined();
  await vi.waitFor(() => expect(fixtures.post).toHaveBeenCalledTimes(1));
  expect(await database.getMessageById("ordinary")).toMatchObject({ content: "next page", conversationId: "other" });
  expect(await database.getSyncState("message-sync:bob:bob-device")).toMatchObject({ value: 102, cursorId: "ordinary" });
  expect(await database.getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: 12 });
  expect(await database.getMessageById("original")).toMatchObject({ content: "original" });

  rejectLookup(Object.assign(new Error("Lookup unavailable"), { status }));
  await vi.waitFor(async () => expect((await editLookupRate())?.lease).toBeUndefined());
  const nextAt = (await editLookupRate()).nextAt;
  expect(nextAt - Date.now()).toBeGreaterThan(delay - 500);
  expect(await (await database.getAppDB()).get("accountState", "edit-lookup:bob:bob-device:original")).toMatchObject({ messageId: "original" });
  if (status === 503) {
    await reload();
    fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [], mutationCursor: 12 });
    await sync.syncMessages({ force: true });
  }
  await vi.advanceTimersByTimeAsync(nextAt - Date.now() - 1);
  expect(fixtures.post).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await waitForRevision("original", "revised 1");
  expect(fixtures.post).toHaveBeenCalledTimes(2);
});

it("ignores an edit grafted onto a different original message family", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  await sync.ingestMessageEdit({ ...await revision(key, 1), senderDeviceId: "other-device" });
  expect(await database.getMessageById("original", "bob", undefined, true)).toMatchObject({ content: "original", editKey: toBase64Url(key) });
});

it.each(["direct", "group"] as const)("checks a %s edit key's signing identity against the authenticated device", async (kind) => {
  const impersonator = await generateIdentityKeyPair();
  const companion = { scope: editScope, bytes: concat(generateAESKey(), impersonator.publicEd25519) };
  if (kind === "group") {
    fixtures.conversationType = "group";
    const group = await generateSenderKey();
    await sync.ingestMessageFrame(await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution"));
    await sync.ingestMessageFrame(await groupEnvelope("original", group, companion));
  } else {
    await sync.ingestMessageFrame(await direct("original", "original", true, "text", companion));
  }
  expect(await database.getSession("alice:alice-device")).toMatchObject({ peerIdentityKey: toBase64Url(author.publicEd25519) });
  expect(await database.getMessageById("original")).toMatchObject({ content: kind === "group" ? "group plaintext" : "original" });
  expect((await database.getMessageById("original", "bob", undefined, true))?.editKey).toBeUndefined();
});

it.each(["decryption", "write"] as const)("leaves a per-message edit replayable when keys lock during %s", async (phase) => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  const edit = await revision(key, 1, "revised after unlock");
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [{ edit, mutationSeq: 11 }], mutationCursor: 11 });
  const before = await database.getSession("alice:alice-device");
  const started = deferred(), release = deferred();
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  const put = IDBObjectStore.prototype.put;
  const intercept = phase === "decryption"
    ? vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
      const plaintext = await decrypt(...args);
      started.resolve();
      await release.promise;
      return plaintext;
    })
    : vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      if (this.name === "displayMessages") keys.lockLocalCryptoState();
      return request;
    });
  const pending = sync.syncMessages({ force: true });
  const queued = expect(pending).resolves.toBeUndefined();
  if (phase === "decryption") {
    await started.promise;
    keys.lockLocalCryptoState();
    release.resolve();
  }
  await queued;
  intercept.mockRestore();
  expect(await database.getSession("alice:alice-device")).toEqual(before);
  expect(await database.getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: 11 });
  const queuedIds = await database.lockedEditIds("bob:bob-device");
  expect(await Promise.all(queuedIds.map(database.readLockedEdit))).toEqual([edit]);
  expect(await database.getMessageById("original")).toMatchObject({ content: "original" });
  await keys.loadKeys(password);
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [], mutationCursor: 11 });
  await sync.runUnlockSync();
  expect(await database.getMessageById("original")).toMatchObject({ content: "revised after unlock", editSequence: 1 });
  expect(await database.lockedEditIds("bob:bob-device")).toEqual([]);
});

it("pulls again on open if locking interrupted a live pull after the edit cursor advanced", async () => {
  const key = generateAESKey();
  const edit = await revision(key, 1);
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [{ edit, mutationSeq: 11 }], mutationCursor: 11 });
  await sync.syncMessages({ force: true });
  expect(await database.getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: 11 });
  const original = await direct("original:bob-device", "original", true, "text", editCompanion(key));
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  const locked = deferred();
  const intercept = vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
    const plaintext = await decrypt(...args);
    if (new TextDecoder().decode(plaintext).includes('"editSeq":1')) { keys.lockLocalCryptoState(); locked.resolve(); }
    return plaintext;
  });
  fixtures.post.mockResolvedValue({ edits: [edit] });
  try {
    await sync.ingestMessageFrame({ ...original, latestEditSeq: 1 });
    await locked.promise;
    await vi.waitFor(async () => expect((await editLookupRate())?.lease).toBeUndefined());
  }
  finally { intercept.mockRestore(); }
  expect(await database.getMessageById(original.id)).toMatchObject({ content: "original" });

  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [], mutationCursor: 11 });
  await reload();
  await sync.syncConversationMessages("conv");
  await waitForRevision(original.id, "revised 1");
}, 10_000);

it("reconciles cached group originals on rejoin without rewinding the edit cursor", async () => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey(), key = generateAESKey();
  await sync.ingestMessageFrame(await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution"));
  await sync.ingestMessageFrame(await groupEnvelope("original", group, editCompanion(key)));
  await sync.ingestMessageEdit(await revision(key, 1));
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [], mutationCursor: 12 });
  await sync.syncMessages({ force: true });
  await sync.reconcileConversationEdits("conv"); // No authorized revisions while removed.
  await vi.waitFor(() => expect(fixtures.post).toHaveBeenCalledTimes(1));
  expect(await database.getMessageById("original")).toMatchObject({ content: "revised 1" });
  fixtures.post.mockResolvedValueOnce({ edits: [await revision(key, 2)] });
  await sync.syncConversationMessages("conv");
  await waitForRevision("original", "revised 2");
  expect(fixtures.post).toHaveBeenLastCalledWith("/api/messages/edits/latest", { ids: ["original"], after: { original: 1 } });
  expect(await database.getMessageById("original")).toMatchObject({ content: "revised 2", editSequence: 2 });
  expect(await database.getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: 12 });
});

it("queues the newest page on rejoin even when a foreground scan advances the bookmark first", async () => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey(), key = generateAESKey();
  await sync.ingestMessageFrame(await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution"));
  const original = { ...await groupEnvelope("original", group, editCompanion(key)), serverTimestamp: 103 };
  await sync.ingestMessageFrame(original);
  const tx = (await database.getAppDB()).transaction("displayMessages", "readwrite");
  for (let timestamp = 1; timestamp <= 102; timestamp++) {
    await tx.store.put({ id: `cached-${timestamp}`, ownerId: "bob", conversationId: "conv", senderId: "alice", type: "text", content: "cached text",
      timestamp, expiresAt: original.expiresAt, expiryKind: "retention", status: "delivered" });
  }
  await tx.done;
  const bookmark = "edit-history:bob:bob-device:conv";
  await database.saveSyncState(bookmark, 50, "cached-50");
  const previous = await database.getSyncState(bookmark);
  const readPage = database.getCachedConversationMessagesPage;
  vi.spyOn(database, "getCachedConversationMessagesPage").mockImplementationOnce(async (...args) => {
    const page = await readPage(...args);
    await database.queueEditLookups("bob:bob-device", [], () => true, { id: bookmark, previous, next: { id: "cached-20", timestamp: 20 } });
    return page;
  });
  fixtures.post.mockResolvedValueOnce({ edits: [await revision(key, 1, "recovered after rejoin")] });

  await sync.reconcileConversationEdits("conv", true);

  expect(await database.getSyncState(bookmark)).toMatchObject({ cursorId: "cached-4", value: 4 });
  await waitForRevision(original.id, "recovered after rejoin");
  expect(fixtures.post).toHaveBeenCalledExactlyOnceWith("/api/messages/edits/latest", { ids: ["original"], after: { original: 0 } });
});

it("keeps cached history readable when the rollback Worker has no latest-edit endpoint", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false });
  fixtures.post.mockRejectedValueOnce(Object.assign(new Error("Not found"), { status: 404 }));
  await sync.syncConversationMessages("conv");
  await vi.waitFor(() => expect(fixtures.post).toHaveBeenCalledTimes(1));
  expect(await database.getMessageById("original", "bob", undefined, true)).toMatchObject({ content: "original", editKey: toBase64Url(key) });
});

async function rewriteOriginalFromLegacyTab(id: string) {
  const db = await database.getAppDB();
  const { conversationId, senderId, type, timestamp, expiresAt, expiryKind } = await db.get("displayMessages", ["bob", id]);
  // 6aec4f5's toLocalMessage rewrites the row from its in-memory original.
  await db.put("displayMessages", { id, ownerId: "bob", conversationId, senderId, type, content: "original", timestamp, expiresAt, expiryKind, status: "delivered" });
}

it("materializes a recovered committed revision when forgetting unlocked edit keys", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  await sync.ingestMessageEdit(await revision(key, 2, "committed revision"));
  await rewriteOriginalFromLegacyTab("original");
  const db = await database.getAppDB();
  const row = await db.get("displayMessages", ["bob", "original"]);
  expect(row.content).toBe("original");
  await db.put("displayMessages", { ...row, pendingEdit: { id: "draft", content: "pending text" } });
  await db.put("accountState", { id: "outgoing-edit:draft", outgoing: { id: "draft", editTargetId: "original" } });
  expect(await database.getMessageById("original")).toMatchObject({ content: "committed revision", editSequence: 2 });

  await keys.resetLocalCryptoState();
  const durable = await db.get("displayMessages", ["bob", "original"]);
  expect(durable).toMatchObject({ content: "committed revision", editSequence: 2, editedAt: expect.any(Number) });
  expect(durable.pendingEdit).toBeUndefined();
  expect(await db.get("accountState", 'message-edit-state:["bob","original"]')).toBeUndefined();
  expect(await db.get("accountState", "outgoing-edit:draft")).toBeUndefined();
  expect(await database.getMessageById("original", "bob", undefined, true)).toMatchObject({ content: "committed revision", editSequence: 2 });
  expect((await database.getMessageById("original", "bob", undefined, true))?.editKey).toBeUndefined();
});

it("rechecks a previously current revision after a legacy rewrite during forget recovery", async () => {
  const key = generateAESKey(), otherKey = generateAESKey();
  const otherScope = { ...editScope, messageId: "other" };
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  await sync.ingestMessageFrame(await direct("other", "other", false, "text", editCompanion(otherKey, otherScope)));
  await sync.ingestMessageEdit(await revision(key, 1, "first committed revision"));
  await sync.ingestMessageEdit(await revision(otherKey, 1, "other committed revision", otherScope));
  // Yield to the legacy writer while the reset decrypts another stale row.
  await rewriteOriginalFromLegacyTab("other");
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  const race = vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
    await rewriteOriginalFromLegacyTab("original");
    return decrypt(...args);
  });
  try {
    await keys.resetLocalCryptoState();
    expect(race).toHaveBeenCalled();
  } finally { race.mockRestore(); }
  const db = await database.getAppDB();
  expect(await db.get("displayMessages", ["bob", "original"])).toMatchObject({ content: "first committed revision", editSequence: 1 });
  expect(await db.get("displayMessages", ["bob", "other"])).toMatchObject({ content: "other committed revision", editSequence: 1 });
  expect(await db.get("accountState", 'message-edit-state:["bob","original"]')).toBeUndefined();
  expect(await db.get("accountState", 'message-edit-state:["bob","other"]')).toBeUndefined();
});

it("restores the committed revision and key after a legacy tab rewrites a row past the edit cursor", async () => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  const edit = await revision(key, 2);
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [{ edit, mutationSeq: 12 }], mutationCursor: 12 });
  await sync.syncMessages({ force: true });
  const db = await database.getAppDB();
  expect(await db.get("displayMessages", ["bob", "original"])).toMatchObject({ content: "revised 2", editSequence: 2 });
  expect(await db.get("displayMessages", ["bob", "original"])).not.toHaveProperty("editKey");
  expect(JSON.stringify(await db.getAll("accountState"))).not.toContain("revised 2");
  await rewriteOriginalFromLegacyTab("original");

  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [], mutationCursor: 12 });
  await reload();
  await sync.runUnlockSync();
  expect(fixtures.get).toHaveBeenLastCalledWith(expect.stringContaining("editSince=12"));
  await sync.loadPersistedConversationMessages("conv");
  expect(chat.useChatStore.getState().messages.get("conv")).toMatchObject([{ content: "revised 2", editSequence: 2, status: "delivered" }]);
  expect(await database.getMessageById("original", "bob", undefined, true)).toMatchObject({ content: "revised 2", editSequence: 2, editKey: toBase64Url(key) });
  await sync.ingestMessageEdit(await revision(key, 1));
  expect(await database.getMessageById("original")).toMatchObject({ content: "revised 2" });
  await sync.ingestMessageEdit(await revision(key, 3));
  expect(await database.getMessageById("original")).toMatchObject({ content: "revised 3", editSequence: 3 });
});

it.each(["expiry", "permanent hide", "tombstone"])("reconciles orphaned edit state after legacy %s", async (mode) => {
  const key = generateAESKey();
  await sync.ingestMessageFrame(await direct("original", "original", true, "text", editCompanion(key)));
  await sync.ingestMessageEdit(await revision(key, 1));
  const db = await database.getAppDB();
  if (mode === "tombstone") {
    const row = await db.get("displayMessages", ["bob", "original"]);
    await db.put("displayMessages", { ...row, content: "", deletedAt: Date.now(), deletedByUserId: "alice" });
  } else {
    await db.delete("displayMessages", ["bob", "original"]);
    if (mode === "permanent hide") await db.put("accountState", { id: "hidden-message:original" });
  }
  await sync.pruneExpiredPlaintext();
  expect(await db.get("accountState", 'message-edit-state:["bob","original"]')).toBeUndefined();
});

it("applies an accepted edit behind the hide barrier and reveals it on Undo without replay", async () => {
  const key = generateAESKey();
  const original = await direct("original:bob-device", "original", true, "text", editCompanion(key));
  await sync.ingestMessageFrame(original);
  await sync.ingestMessageEdit(await revision(key, 1));
  const undo = await sync.hideMessageWithUndo("conv", original.id);
  const edit = await revision(key, 2);
  fixtures.get.mockResolvedValue({ messages: [], hasMore: false, editStream: true, mutations: [{ edit, mutationSeq: 12 }], mutationCursor: 12 });
  await sync.syncMessages({ force: true });
  expect(await database.getSyncState("message-mutations-edits:bob:bob-device")).toMatchObject({ value: 12 });
  expect(await database.getMessages("conv")).toEqual([]);
  expect(chat.useChatStore.getState().messages.get("conv")).toEqual([]);
  expect(await undo!()).toBe(true);
  expect(chat.useChatStore.getState().messages.get("conv")).toMatchObject([{ content: "revised 2", editSequence: 2 }]);
  expect(await database.getMessageById(original.id, "bob", undefined, true)).toMatchObject({ editKey: toBase64Url(key), content: "revised 2" });
});

it.each(["hide", "delete", "expire"])("clears the edit key on permanent %s", async (mode) => {
  const key = generateAESKey();
  const original = await direct("original:bob-device", "original", true, "text", editCompanion(key));
  await sync.ingestMessageFrame(original);
  await sync.ingestMessageEdit(await revision(key, 1));
  if (mode === "hide") {
    const hide = await database.beginMessageHide(original.id);
    await database.finishMessageHide(original.id, hide!.token, false);
    await sync.ingestMessageEdit(await revision(key, 2));
    expect(await database.getMessageById(original.id)).toBeUndefined();
  } else if (mode === "delete") {
    await sync.handleMessageDeletion({ conversationId: "conv", deletion: { ids: [original.id], deletedAt: Date.now(), deletedByUserId: "alice" } });
    await sync.ingestMessageEdit(await revision(key, 2));
    expect(await database.getMessageById(original.id)).toMatchObject({ content: "", deletedByUserId: "alice" });
  } else {
    await database.cleanupExpiredMessages(original.expiresAt! + 1);
    expect(await database.getMessageById(original.id)).toBeUndefined();
  }
  expect(JSON.stringify(await (await database.getAppDB()).getAll("accountState"))).not.toContain(toBase64Url(key));
  expect((await database.getMessageById(original.id, "bob", undefined, true))?.editKey).toBeUndefined();
});

describe("receive review regressions", () => {
  it.each(["distribution-first", "message-first"])("decrypts concurrent distribution and group message (%s)", async (order) => {
    fixtures.conversationType = "group";
    const group = await generateSenderKey();
    const distribution = await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution");
    const message = await groupEnvelope("concurrent", group);
    const beforeCommit = deferred();
    const releaseCommit = deferred();
    const commit = database.commitReceivedMessage;
    vi.spyOn(database, "commitReceivedMessage").mockImplementation(async (...args) => {
      if (args[0] === "distribution") {
        beforeCommit.resolve();
        await releaseCommit.promise;
      }
      return commit(...args);
    });
    let receiveDistribution: Promise<void>;
    let receiveMessage: Promise<void>;
    if (order === "distribution-first") {
      receiveDistribution = sync.ingestMessageFrame(distribution);
      await beforeCommit.promise;
      receiveMessage = sync.ingestMessageFrame(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } else {
      receiveMessage = sync.ingestMessageFrame(message);
      await receiveMessage;
      receiveDistribution = sync.ingestMessageFrame(distribution);
      await beforeCommit.promise;
    }
    releaseCommit.resolve();
    await Promise.all([receiveDistribution, receiveMessage]);
    expect(await database.getMessageById("concurrent")).toMatchObject({ content: "group plaintext", status: "delivered" });
    expect(chat.useChatStore.getState().messages.get("conv")).toMatchObject([{ id: "concurrent", status: "delivered" }]);
  });

  it.each([
    "{", "null", JSON.stringify({ conversationId: "conv", distribution: {} }),
    JSON.stringify({ conversationId: "conv", distribution: { senderKeyId: 1, chainKey: "AA", signingPublicKey: "AA", chainIndex: -1 } }),
    JSON.stringify({ conversationId: "another-group", distribution: {} }),
  ])("does not block global sync on a malformed authenticated distribution (%s)", async (payload) => {
    fixtures.conversationType = "group";
    const malformed = await direct("malformed", payload, true, "sender_key_distribution");
    const later = { ...await direct("later", "later plaintext"), conversationId: "other" };
    fixtures.get.mockResolvedValue({ messages: [malformed, later], hasMore: false });
    await expect(sync.syncMessages({ force: true })).resolves.toBeUndefined();
    const db = await database.getAppDB();
    expect(await db.get("accountState", database.receiveKey("received:", "malformed", "bob", "bob-device"))).toMatchObject({ failure: "invalid_sender_key_distribution" });
    expect(await db.getAll("receiveSenderKeys")).toEqual([]);
    expect(await database.getMessageById("later")).toMatchObject({ content: "later plaintext", status: "delivered" });
    expect(await database.getSyncState("message-sync:bob:bob-device")).toMatchObject({ cursorId: "later" });
    const before = await db.getAll("receiveSessions");
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    await sync.ingestMessageFrame(malformed);
    expect(decrypt).not.toHaveBeenCalled();
    expect(await db.getAll("receiveSessions")).toEqual(before);
  });

  it.each(["initial", "normal", "group", "system", "commit"])("publishes another tab's committed %s output on the in-flight duplicate path without decrypting", async (kind) => {
    let envelope: WSMessageFrame;
    if (kind === "group") {
      fixtures.conversationType = "group";
      const group = await generateSenderKey();
      await sync.ingestMessageFrame(await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution"));
      envelope = await groupEnvelope("shared", group);
    } else {
      if (kind === "normal") await sync.ingestMessageFrame(await direct("first", "first", true));
      const content = kind === "system"
        ? JSON.stringify({ kind: "call_offer", callId: "shared-call", conversationId: "conv", initiatorId: "alice", callType: "audio", callKey: testCallKey, createdAt: Date.now(), expiresAt: Date.now() + 60_000 })
        : "shared plaintext";
      envelope = await direct("shared", content, kind !== "normal", kind === "system" ? "system" : "text");
    }
    const tab1 = { database, sync, keys, chat, processor: await import("./message-processor.js") };
    const started = deferred();
    const release = deferred();
    if (kind === "commit") {
      const commit = tab1.database.commitReceivedMessage;
      vi.spyOn(tab1.database, "commitReceivedMessage").mockImplementationOnce(async (...args) => {
        started.resolve(); await release.promise; return commit(...args);
      });
    } else if (kind === "group") {
      const decrypt = tab1.processor.decryptGroupText;
      vi.spyOn(tab1.processor, "decryptGroupText").mockImplementationOnce(async (...args) => {
        started.resolve(); await release.promise; return decrypt(...args);
      });
    } else {
      const decrypt = tab1.processor.decryptMessage;
      vi.spyOn(tab1.processor, "decryptMessage").mockImplementationOnce(async (...args) => {
        started.resolve(); await release.promise; return decrypt(...args);
      });
    }
    const pendingTab1 = tab1.sync.ingestMessageFrame(envelope);
    await started.promise;
    // A second JS realm/module graph sharing only the same IndexedDB database.
    vi.resetModules();
    database = await import("../db/index.js");
    keys = await import("./key-manager.js");
    await keys.loadKeys(password);
    sync = await import("./message-sync.js");
    chat = await import("../stores/chatStore.js");
    chat.useChatStore.setState({ messages: new Map(), activeConversationId: "conv" });
    await sync.ingestMessageFrame(envelope);
    const db = await database.getAppDB();
    const before = { sessions: await db.getAll("receiveSessions"), senderKeys: await db.getAll("receiveSenderKeys") };
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    release.resolve();
    try {
      await pendingTab1;
      if (kind === "system") {
        expect(fixtures.markKeyReady).toHaveBeenCalledTimes(2);
      } else {
        expect(tab1.chat.useChatStore.getState().messages.get("conv")).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "shared", content: kind === "group" ? "group plaintext" : "shared plaintext", status: "delivered" }),
        ]));
      }
      expect(decrypt).not.toHaveBeenCalled();
      expect({ sessions: await db.getAll("receiveSessions"), senderKeys: await db.getAll("receiveSenderKeys") }).toEqual(before);
    } finally {
      tab1.keys.lockLocalCryptoState();
      (await tab1.database.getAppDB()).close();
    }
  });
});

it("keeps only the encrypted missing-key envelope across reload and drains it when distribution arrives", async () => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey();
  const distribution = await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution");
  const message = await groupEnvelope("waiting", group);
  fixtures.get.mockResolvedValue({ messages: [message], hasMore: false });
  await sync.syncMessages({ force: true });
  const db = await database.getAppDB();
  expect(await database.getMessageById("waiting")).toBeUndefined();
  expect(await database.getSyncState("message-sync:bob:bob-device")).toMatchObject({ cursorId: "waiting" });
  const queued = await db.get("accountState", database.receiveKey("pending-receive:", "waiting", "bob", "bob-device"));
  expect(queued.frame).toEqual(message);
  expect(JSON.stringify(queued)).not.toContain("group plaintext");
  await reload();
  await sync.ingestMessageFrame(distribution);
  expect(await database.getMessageById("waiting")).toMatchObject({ content: "group plaintext", status: "delivered" });
  expect(await (await database.getAppDB()).get("accountState", database.receiveKey("pending-receive:", "waiting", "bob", "bob-device"))).toBeUndefined();
});

it("closes the race where another tab distributes a key between lookup and queuing", async () => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey();
  const distributed = createDistribution(group);
  const message = await groupEnvelope("racing", group);
  const queue = database.savePendingReceive;
  vi.spyOn(database, "savePendingReceive").mockImplementationOnce(async (...args) => {
    const { prepareRemoteSenderKey } = await import("./group-session.js");
    await database.saveSenderKey(await prepareRemoteSenderKey("conv", "alice", "alice-device", JSON.stringify(distributed)));
    return queue(...args);
  });
  await sync.ingestMessageFrame(message);
  expect(await database.getMessageById("racing")).toMatchObject({ content: "group plaintext", status: "delivered" });
});

it("drains deferred group envelopes in sender-chain order even if their IDs sort backwards", async () => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey();
  const distribution = await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution");
  const first = await groupEnvelope("z-first", group);
  const second = await groupEnvelope("a-second", group);
  await Promise.all([sync.ingestMessageFrame(first), sync.ingestMessageFrame(second)]);
  await sync.ingestMessageFrame(distribution);
  for (const id of [first.id, second.id]) expect(await database.getMessageById(id)).toMatchObject({ status: "delivered", content: "group plaintext" });
});

it("rolls back a malformed distribution's terminal receipt and ratchet together on storage abort, then replays it", async () => {
  fixtures.conversationType = "group";
  const malformed = await direct("malformed", "{", true, "sender_key_distribution");
  const db = await database.getAppDB();
  const crash = crashOnOutput("accountState");
  await expect(sync.ingestMessageFrame(malformed)).rejects.toThrow();
  crash.mockRestore();
  expect(await db.getAll("receiveSessions")).toEqual([]);
  expect(await db.get("accountState", database.receiveKey("received:", "malformed", "bob", "bob-device"))).toBeUndefined();
  expect(keys.peekOneTimePreKey(1)).toBeDefined();
  await reload();
  await sync.ingestMessageFrame(malformed);
  expect(await (await database.getAppDB()).get("accountState", database.receiveKey("received:", "malformed", "bob", "bob-device"))).toMatchObject({ failure: "invalid_sender_key_distribution" });
  const later = { ...await direct("after-malformed", "after malformed"), conversationId: "other" };
  await sync.ingestMessageFrame(later);
  expect(await database.getMessageById(later.id)).toMatchObject({ status: "delivered", content: "after malformed" });
});

it("does not classify output-preparation errors as malformed input or consume the direct ratchet", async () => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey();
  const distribution = await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution");
  const groupSession = await import("./group-session.js");
  vi.spyOn(groupSession, "prepareRemoteSenderKey").mockRejectedValueOnce(new DOMException("Storage unavailable", "AbortError"));
  await expect(sync.ingestMessageFrame(distribution)).rejects.toThrow("Storage unavailable");
  const db = await database.getAppDB();
  expect(await db.getAll("receiveSessions")).toEqual([]);
  expect(await db.get("accountState", database.receiveKey("received:", "distribution", "bob", "bob-device"))).toBeUndefined();
  await sync.ingestMessageFrame(distribution);
  expect(await db.getAll("receiveSenderKeys")).toHaveLength(1);
});

describe("structural receive classification", () => {
  it.each([
    "direct-null", "direct-array", "direct-missing-target", "direct-missing-dh",
    "group-null", "group-missing-id", "group-missing-index",
    "call-missing-id", "call-bad-key", "call-bad-time", "unknown-control", "unknown-message", "unknown-key-exchange",
    "conversation-403", "conversation-404", "bad-distribution", "authentication", "data-error", "bad-file",
  ])("retires %s and delivers other conversations and the peer's next message", async (kind) => {
    await sync.ingestMessageFrame(await direct("bootstrap", "bootstrap", true));
    let poison: WSMessageFrame;
    if (kind.startsWith("group-")) {
      fixtures.conversationType = "group";
      const group = await generateSenderKey();
      await sync.ingestMessageFrame(await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), false, "sender_key_distribution"));
      poison = await groupEnvelope("poison", group);
      const header = JSON.parse(poison.header);
      if (kind === "group-missing-id") delete header.senderKeyId;
      if (kind === "group-missing-index") delete header.chainIndex;
      poison.header = kind === "group-null" ? "null" : JSON.stringify(header);
    } else if (kind.startsWith("call-") || kind === "unknown-control") {
      const payload: Record<string, unknown> = {
        kind: "call_offer", callId: "call", conversationId: "conv", initiatorId: "alice", callType: "audio",
        callKey: toBase64Url(new Uint8Array(32)), createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      };
      if (kind === "call-missing-id") delete payload.callId;
      if (kind === "call-bad-key") payload.callKey = {};
      if (kind === "call-bad-time") payload.expiresAt = "tomorrow";
      if (kind === "unknown-control") payload.kind = "unrecognized";
      poison = await direct("poison", JSON.stringify(payload), false, "system");
    } else {
      const type = kind === "bad-distribution" || kind === "data-error" ? "sender_key_distribution"
        : kind === "bad-file" ? "file" : kind === "unknown-key-exchange" ? "key_exchange" : kind === "unknown-message" ? "alien" : "text";
      const payload = kind === "data-error" ? JSON.stringify({ conversationId: "conv", distribution: createDistribution(await generateSenderKey()) }) : "{";
      poison = await direct("poison", payload, false, type);
      if (kind === "data-error") {
        const groupSession = await import("./group-session.js");
        vi.spyOn(groupSession, "prepareRemoteSenderKey").mockRejectedValueOnce(new DOMException("Malformed record", "DataError"));
      }
      if (kind.startsWith("direct-")) {
        const header = JSON.parse(poison.header);
        if (kind === "direct-missing-target") delete header.recipientDeviceId;
        if (kind === "direct-missing-dh") delete header.dhPublicKey;
        poison.header = kind === "direct-null" ? "null" : kind === "direct-array" ? "[]" : JSON.stringify(header);
      }
      if (kind === "authentication") {
        const iv = new Uint8Array(12); iv[0] = 1; poison.iv = toBase64Url(iv);
      }
      if (kind.startsWith("conversation-")) {
        fixtures.metadataErrors.conv = Object.assign(new Error("No conversation"), { status: Number(kind.slice(-3)) });
        sync.resetMessageSyncState();
      }
    }
    const valid = { ...await direct("valid", "other conversation"), conversationId: "other" };
    fixtures.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/conversations/")) throw fixtures.metadataErrors.conv;
      return { messages: [poison, valid], hasMore: false };
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(sync.syncMessages({ force: true })).resolves.toBeUndefined();
    expect(await database.getMessageById(valid.id)).toMatchObject({ content: "other conversation", status: "delivered" });
    expect(await database.getSyncState("message-sync:bob:bob-device")).toMatchObject({ cursorId: valid.id });
    const receipt = await database.getReceiveReceipt(poison.id, "bob", "bob-device");
    const failed = await database.getMessageById(poison.id);
    expect(receipt?.failure || failed?.status === "failed").toBeTruthy();
    expect(await (await database.getAppDB()).getAll("receivePendingCalls")).toEqual([]);
    const next = { ...await direct("next-peer", "peer still decrypts"), conversationId: "other" };
    await sync.ingestMessageFrame(next);
    expect(await database.getMessageById(next.id)).toMatchObject({ content: "peer still decrypts", status: "delivered" });
    log.mockRestore();
  });

  it.each([403, 404, 503, 0])("isolates a deferred conversation error (%s) and still fetches new messages", async (status) => {
    fixtures.conversationType = "group";
    const group = await generateSenderKey();
    const waiting = await groupEnvelope("waiting", group);
    await sync.ingestMessageFrame(waiting);
    fixtures.metadataErrors.conv = status ? Object.assign(new Error("Metadata unavailable"), { status }) : new TypeError("Failed to fetch");
    sync.resetMessageSyncState();
    const valid = { ...await direct("valid", "fresh message", true), conversationId: "other" };
    fixtures.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/conversations/")) throw fixtures.metadataErrors.conv;
      return { messages: [valid], hasMore: false };
    });
    await expect(sync.syncMessages({ force: true })).resolves.toBeUndefined();
    expect(fixtures.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/messages\/sync/));
    expect(await database.getMessageById(valid.id)).toMatchObject({ content: "fresh message", status: "delivered" });
    const queued = await (await database.getAppDB()).get("accountState", database.receiveKey("pending-receive:", "waiting", "bob", "bob-device"));
    if (status === 403 || status === 404) expect(queued).toBeUndefined();
    else expect(queued.frame).toEqual(waiting);
  });

  it("drains deferred index 0 before a live index 1 while distribution replay is paused", async () => {
    fixtures.conversationType = "group";
    const group = await generateSenderKey();
    const distribution = await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution");
    const first = await groupEnvelope("index-0", group);
    const newer = await groupEnvelope("index-1", group);
    await sync.ingestMessageFrame(first);
    const started = deferred();
    const release = deferred();
    const getPending = database.getPendingReceives;
    vi.spyOn(database, "getPendingReceives").mockImplementationOnce(async (...args) => {
      const records = await getPending(...args); started.resolve(); await release.promise; return records;
    });
    const distributing = sync.ingestMessageFrame(distribution);
    await started.promise;
    const live = sync.ingestMessageFrame(newer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release.resolve();
    await Promise.all([distributing, live]);
    for (const id of [first.id, newer.id]) expect(await database.getMessageById(id)).toMatchObject({ content: "group plaintext", status: "delivered" });
  });
});

it("retries locked keys without recording a terminal frame or advancing the cursor", async () => {
  const message = await direct("locked", "unlock to receive", true);
  fixtures.get.mockResolvedValue({ messages: [message], hasMore: false });
  keys.lockLocalCryptoState();
  await expect(sync.syncMessages({ force: true })).rejects.toMatchObject({ name: "KeysLockedError" });
  expect(await database.getMessageById(message.id)).toBeUndefined();
  expect(await database.getReceiveReceipt(message.id, "bob", "bob-device")).toBeUndefined();
  expect(await database.getSyncState("message-sync:bob:bob-device")).toBeUndefined();
  await keys.loadKeys(password);
  await sync.syncMessages({ force: true });
  expect(await database.getMessageById(message.id)).toMatchObject({ content: "unlock to receive", status: "delivered" });
});

it("retries a pre-key IndexedDB read abort without retiring the authenticated initial envelope", async () => {
  const message = await direct("read-abort", "retry the read", true);
  vi.spyOn(keys, "findOneTimePreKey").mockRejectedValueOnce(new DOMException("Pre-key read aborted", "AbortError"));
  await expect(sync.ingestMessageFrame(message)).rejects.toMatchObject({ name: "AbortError" });
  expect(await database.getMessageById(message.id)).toBeUndefined();
  expect(await database.getReceiveReceipt(message.id, "bob", "bob-device")).toBeUndefined();
  expect(await database.getSession("alice:alice-device")).toBeUndefined();
  await sync.ingestMessageFrame(message);
  expect(await database.getMessageById(message.id)).toMatchObject({ content: "retry the read", status: "delivered" });
});

it("atomically retires an authenticated malformed initial call offer and consumes its pre-key", async () => {
  const poison = await direct("bad-call", JSON.stringify({ kind: "call_offer" }), true, "system");
  await sync.ingestMessageFrame(poison);
  expect(await database.getReceiveReceipt(poison.id, "bob", "bob-device")).toMatchObject({ failure: "terminal_receive_error" });
  expect(await (await database.getAppDB()).getAll("receivePendingCalls")).toEqual([]);
  expect(keys.peekOneTimePreKey(1)).toBeUndefined();
  await reload();
  const next = await direct("after-call", "after malformed call");
  await sync.ingestMessageFrame(next);
  expect(await database.getMessageById(next.id)).toMatchObject({ content: "after malformed call", status: "delivered" });
});

it("isolates a malformed header already in the deferred inbox", async () => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey();
  const poison = { ...await groupEnvelope("bad-pending", group), header: "null" };
  await database.savePendingReceive(poison, "bob", "bob-device");
  const valid = { ...await direct("fresh", "after bad pending", true), conversationId: "other" };
  fixtures.get.mockResolvedValue({ messages: [valid], hasMore: false });
  await sync.syncMessages({ force: true });
  expect(await database.getMessageById(poison.id)).toMatchObject({ status: "failed" });
  expect(await (await database.getAppDB()).get("accountState", database.receiveKey("pending-receive:", "bad-pending", "bob", "bob-device"))).toBeUndefined();
  expect(await database.getMessageById(valid.id)).toMatchObject({ content: "after bad pending", status: "delivered" });
});

async function storedRows() {
  const db = await database.getAppDB();
  return Object.fromEntries(await Promise.all(Array.from(db.objectStoreNames, async (store) => [store, await db.getAll(store)])));
}

async function signInAgain() {
  fixtures.auth = { sessionId: "new-login", user: { id: "bob" }, device: { id: "bob-device" } };
  await keys.loadKeys(password);
}

describe("receive expiry and HTTP retries", () => {
  it.each([429, 408, 401])("delivers after HTTP %s without retiring the first attempt", async (status) => {
    const message = await direct("retry-http", "received after retry", true);
    fixtures.metadataErrors.conv = Object.assign(new Error("Try again"), { status });
    let attempts = 0;
    fixtures.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/conversations/")) {
        if (attempts++ === 0) throw fixtures.metadataErrors.conv;
        return { id: "conv", type: "direct" };
      }
      return { messages: [message], hasMore: false };
    });
    const before = await storedRows();
    await expect(sync.syncMessages({ force: true })).rejects.toMatchObject({ cause: { status } });
    expect(await storedRows()).toEqual(before);
    if (status === 401) {
      keys.lockLocalCryptoState();
      await signInAgain();
    }
    await sync.syncMessages({ force: true });
    expect(await database.getMessageById(message.id)).toMatchObject({ content: "received after retry", status: "delivered" });
    expect(await database.getSyncState("message-sync:bob:bob-device")).toMatchObject({ cursorId: message.id });
  });

  it.each(["sign-out", "other-user", "other-device", "other-session"])("does not retire pre-decryption work after %s and decrypts after signing in again", async (change) => {
    const message = await direct("stale-receive", "still recoverable", true);
    fixtures.metadataErrors.conv = Object.assign(new Error("No conversation"), { status: 403 });
    const started = deferred(), release = deferred();
    fixtures.get.mockImplementation(async () => { started.resolve(); await release.promise; throw fixtures.metadataErrors.conv; });
    const before = await storedRows();
    const pending = sync.ingestMessageFrame(message);
    await started.promise;
    if (change === "sign-out") fixtures.auth = { ...fixtures.auth, user: null, sessionId: null };
    if (change === "other-user") fixtures.auth = { ...fixtures.auth, user: { id: "another-user" } };
    if (change === "other-device") fixtures.auth = { ...fixtures.auth, device: { id: "another-device" } };
    if (change === "other-session") fixtures.auth = { ...fixtures.auth, sessionId: "another-session" };
    keys.lockLocalCryptoState();
    release.resolve();
    await pending;
    expect(await storedRows()).toEqual(before);
    await signInAgain();
    fixtures.get.mockResolvedValue({ id: "conv", type: "direct" });
    await sync.ingestMessageFrame(message);
    expect(await database.getMessageById(message.id)).toMatchObject({ content: "still recoverable", status: "delivered" });
  });

  it.each(["system", "sender_key_distribution"] as const)("does not write a terminal %s receipt for an expired unauthenticated receive", async (kind) => {
    const payload = kind === "system"
      ? { kind: "call_offer", callId: "expiry-call", conversationId: "conv", initiatorId: "alice", callType: "audio", callKey: testCallKey, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }
      : { conversationId: "conv", distribution: createDistribution(await generateSenderKey()) };
    const message = await direct("stale-control", JSON.stringify(payload), true, kind);
    fixtures.metadataErrors.conv = Object.assign(new Error("No conversation"), { status: 404 });
    const started = deferred(), release = deferred();
    fixtures.get.mockImplementation(async () => { started.resolve(); await release.promise; throw fixtures.metadataErrors.conv; });
    const before = await storedRows();
    const pending = sync.ingestMessageFrame(message);
    await started.promise;
    fixtures.auth = { ...fixtures.auth, user: null, sessionId: null };
    keys.lockLocalCryptoState();
    release.resolve();
    await pending;
    expect(await storedRows()).toEqual(before);
    await signInAgain();
    fixtures.get.mockResolvedValue({ id: "conv", type: "direct" });
    await sync.ingestMessageFrame(message);
    expect(await database.getReceiveReceipt(message.id, "bob", "bob-device")).not.toHaveProperty("failure");
    expect(await database.getSession("alice:alice-device")).toBeDefined();
    const db = await database.getAppDB();
    if (kind === "system") expect(await db.getAll("receivePendingCalls")).toHaveLength(1);
    else expect(await db.getAll("receiveSenderKeys")).toHaveLength(1);
  });

  it.each(["direct", "group"])("finishes an authenticated malformed %s receive after sign-out", async (kind) => {
    let message: WSMessageFrame;
    if (kind === "direct") {
      message = await direct("authenticated-control", "{", true, "system");
    } else {
      fixtures.conversationType = "group";
      const group = await generateSenderKey();
      await sync.ingestMessageFrame(await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution"));
      const encrypted = await senderKeyEncrypt(group, encode("{"));
      message = frame("authenticated-control", "system", { ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv), header: JSON.stringify(encrypted.header) });
    }
    const receiving = await import("./receive.js");
    const finish = receiving.finishReceive;
    const started = deferred(), release = deferred();
    vi.spyOn(receiving, "finishReceive").mockImplementationOnce(async (...args) => {
      // Successful authentication/decryption has already produced plaintext and advanced state.
      started.resolve(); await release.promise; return finish(...args);
    });
    const pending = sync.ingestMessageFrame(message);
    await started.promise;
    fixtures.auth = { ...fixtures.auth, user: null, sessionId: null };
    keys.lockLocalCryptoState();
    release.resolve();
    await pending;
    expect(await database.getReceiveReceipt(message.id, "bob", "bob-device")).toMatchObject({ failure: "terminal_receive_error" });
    expect(chat.useChatStore.getState().messages.get("conv") ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: message.id })]));
    const db = await database.getAppDB();
    if (kind === "direct") expect(JSON.parse((await database.getSession("alice:alice-device"))!.state).recvMessageNumber).toBe(1);
    else expect((await db.getAll("receiveSenderKeys"))[0].chainIndex).toBe(1);
  });
});

it("queues 80 missing-key frames with linear writes and no backlog scans", async () => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey();
  const count = 80;
  const save = vi.spyOn(database, "savePendingReceive");
  const backlog = vi.spyOn(database, "getPendingReceives");
  for (let index = 0; index < count; index++) {
    await sync.ingestMessageFrame(await groupEnvelope(`queued-${index}`, group));
  }
  expect(save).toHaveBeenCalledTimes(count);
  expect(backlog).not.toHaveBeenCalled();
  const db = await database.getAppDB();
  const queued = (await db.getAll("accountState")).filter((row) => row.id.startsWith("pending-receive:"));
  expect(queued).toHaveLength(count);
  expect(await db.getAll("displayMessages")).toEqual([]);
  expect(await db.getAll("receiveSenderKeys")).toEqual([]);
}, 15_000);

it.each([false, true])("authenticates a live group receive despite a foreign cached row (imported=%s)", async (imported) => {
  fixtures.conversationType = "group";
  const group = await generateSenderKey();
  await sync.ingestMessageFrame(await direct("distribution", JSON.stringify({ conversationId: "conv", distribution: createDistribution(group) }), true, "sender_key_distribution"));
  const incoming = await groupEnvelope("shared-wire", group);
  await (await database.getAppDB()).put("displayMessages", {
    id: incoming.id, ownerId: "carol", conversationId: incoming.conversationId, senderId: incoming.senderId,
    type: "text", content: "Carol's copy", timestamp: incoming.timestamp, expiresAt: incoming.expiresAt, status: "delivered",
    ...(imported ? { importedAt: Date.now() } : {}),
  });
  expect(await database.hasReceivedMessage(incoming.id, "bob", "bob-device")).toBe(false);
  await sync.ingestMessageFrame(incoming);
  const bob = await database.getMessageById(incoming.id, "bob");
  expect(bob).toMatchObject({ ownerId: "bob", content: "group plaintext", wireId: incoming.id });
  expect(bob?.id).toBe(incoming.id);
  expect(await database.getMessageById(incoming.id, "carol")).toMatchObject({ ownerId: "carol", content: "Carol's copy" });
  expect(await database.hasReceivedMessage(incoming.id, "bob", "bob-device")).toBe(true);
  expect(chat.useChatStore.getState().messages.get("conv")).toContainEqual(expect.objectContaining({ id: bob?.id, ownerId: "bob" }));
});

it("keeps a control receipt for each receiving account with the same wire ID", async () => {
  const id = "shared-receipt";
  const expiresAt = Date.now() + 60_000;
  expect(await database.commitReceivedMessage(id, { ownerId: "carol", expiresAt, failure: "terminal_receive_error" })).toBe(true);
  expect(await database.hasReceivedMessage(id, "bob", "bob-device")).toBe(false);
  expect(await database.commitReceivedMessage(id, { ownerId: "bob", expiresAt })).toBe(true);
  expect(await database.commitReceivedMessage(id, { ownerId: "bob", expiresAt })).toBe(false);
  expect(await database.getReceiveReceipt(id, "carol")).toHaveProperty("failure", "terminal_receive_error");
  expect(await database.getReceiveReceipt(id, "bob")).not.toHaveProperty("failure");
});
