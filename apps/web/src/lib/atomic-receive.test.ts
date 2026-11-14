import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDistribution, generateIdentityKeyPair, generateSenderKey, initSessionAsInitiator,
  ratchetEncrypt, ratchetDecrypt, senderKeyEncrypt, toBase64Url, x3dhInitiate,
  type RatchetSession,
} from "@e2ee-chat/crypto";
import { WSFrameType, type InitialMessageHeader, type WSMessageFrame } from "@e2ee-chat/shared";

const fixtures = vi.hoisted(() => ({ auth: { sessionId: "login" as string | null, user: { id: "bob" } as { id: string } | null, device: { id: "bob-device" } as { id: string } | null }, conversationType: "direct", metadataErrors: {} as Record<string, unknown>, get: vi.fn(), markKeyReady: vi.fn() }));
vi.mock("../services/api.js", () => ({ api: { get: fixtures.get } }));
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
let initial: InitialMessageHeader;
const encode = (value: string) => new TextEncoder().encode(value);

async function reload() {
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
async function direct(id: string, text = id, bootstrap = false, msgType: WSMessageFrame["msgType"] = "text") {
  const encrypted = await ratchetEncrypt(sender, encode(text));
  return frame(id, msgType, {
    ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv),
    header: JSON.stringify({ ...encrypted.header, recipientDeviceId: "bob-device", ...(bootstrap ? { initial } : {}) }),
  });
}
function frame(id: string, msgType: WSMessageFrame["msgType"], encrypted: Pick<WSMessageFrame, "ciphertext" | "iv" | "header">): WSMessageFrame {
  return {
    type: WSFrameType.Message, id, conversationId: "conv", senderId: "alice", senderDeviceId: "alice-device",
    msgType, ...encrypted, timestamp: Date.now(), expiresAt: Date.now() + 60_000, expiryKind: "retention",
  };
}
/** Abort an actual IDB transaction after its output write was enqueued, after all crypto. */
function crashOnOutput(storeName = "messages") {
  const original = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = original.apply(this, args);
    if (this.name === storeName) this.transaction.abort();
    return request;
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
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
  const alice = await generateIdentityKeyPair();
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
afterEach(() => { vi.restoreAllMocks(); keys.lockLocalCryptoState(); });

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
    const before = { sessions: await db.getAll("sessions"), senderKeys: await db.getAll("senderKeys") };
    const crash = crashOnOutput();
    await expect(sync.ingestMessageFrame(envelope)).rejects.toThrow();
    crash.mockRestore();
    expect(await database.getMessageById("target")).toBeUndefined();
    expect({ sessions: await db.getAll("sessions"), senderKeys: await db.getAll("senderKeys") }).toEqual(before);
    if (kind === "initial") expect(keys.peekOneTimePreKey(1)).toBeDefined();
    await reload();
    await sync.ingestMessageFrame(envelope);
    expect(await database.getMessageById("target")).toMatchObject({ content: "recoverable", status: "delivered" });
    const reloaded = await database.getAppDB();
    for (const record of await reloaded.getAll("sessions")) {
      expect(JSON.parse(record.state).rootKey).toEqual(expect.any(String));
    }
    for (const record of await reloaded.getAll("senderKeys")) {
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
  const before = { sessions: await db.getAll("sessions"), senderKeys: await db.getAll("senderKeys") };
  const decrypt = vi.spyOn(crypto.subtle, "decrypt");
  await sync.ingestMessageFrame(envelope);
  expect(decrypt).not.toHaveBeenCalled();
  expect({ sessions: await db.getAll("sessions"), senderKeys: await db.getAll("senderKeys") }).toEqual(before);
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
  const crash = crashOnOutput(kind === "sender_key_distribution" ? "senderKeys" : kind === "system" ? "pendingCalls" : "syncState");
  await expect(sync.ingestMessageFrame(envelope)).rejects.toThrow();
  crash.mockRestore();
  expect(await db.getAll("sessions")).toEqual([]);
  expect(await db.getAll("senderKeys")).toEqual([]);
  expect(await db.getAll("pendingCalls")).toEqual([]);
  expect(await db.get("syncState", "received:control")).toBeUndefined();
  expect(fixtures.markKeyReady).not.toHaveBeenCalled();
  await reload();
  await sync.ingestMessageFrame(envelope);
  const reopened = await database.getAppDB();
  expect(await reopened.get("syncState", "received:control")).toEqual({ id: "received:control", expiresAt: envelope.expiresAt, ...(kind === "system" ? { pendingCallId: "call" } : kind === "key_exchange" ? { failure: "terminal_receive_error" } : {}) });
  expect(await database.getMessageById("control")).toBeUndefined();
  if (kind === "system") {
    expect(await database.getPendingCall("call")).toMatchObject({ callKey: testCallKey });
    expect(fixtures.markKeyReady).toHaveBeenCalledExactlyOnceWith("call", true);
  }
  if (kind === "sender_key_distribution") expect(await reopened.getAll("senderKeys")).toHaveLength(1);
  const before = await reopened.getAll("sessions");
  const decrypt = vi.spyOn(crypto.subtle, "decrypt");
  await sync.ingestMessageFrame(envelope);
  expect(decrypt).not.toHaveBeenCalled();
  expect(await reopened.getAll("sessions")).toEqual(before);
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
  await db.put("sessions", session);
  await db.delete("messages", "lost");
  await reload();
  const reopened = await database.getAppDB();
  const before = await reopened.getAll("sessions");
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await sync.ingestMessageFrame(envelope);
  expect(await database.getMessageById("lost")).toMatchObject({ status: "failed", content: "" });
  expect(chat.useChatStore.getState().messages.get("conv")).toMatchObject([{ id: "lost", status: "failed" }]);
  expect(await reopened.getAll("sessions")).toEqual(before);
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
  const before = await db.getAll("senderKeys");
  await sync.ingestMessageFrame(await direct("distribution-again", payload, false, "sender_key_distribution"));
  expect(await db.getAll("senderKeys")).toEqual(before);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function groupEnvelope(id: string, group: Awaited<ReturnType<typeof generateSenderKey>>) {
  const encrypted = await senderKeyEncrypt(group, encode("group plaintext"));
  return frame(id, "text", { ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv), header: JSON.stringify(encrypted.header) });
}

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
    expect(await db.get("syncState", "received:malformed")).toMatchObject({ failure: "invalid_sender_key_distribution" });
    expect(await db.getAll("senderKeys")).toEqual([]);
    expect(await database.getMessageById("later")).toMatchObject({ content: "later plaintext", status: "delivered" });
    expect(await database.getSyncState("message-sync:bob:bob-device")).toMatchObject({ cursorId: "later" });
    const before = await db.getAll("sessions");
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    await sync.ingestMessageFrame(malformed);
    expect(decrypt).not.toHaveBeenCalled();
    expect(await db.getAll("sessions")).toEqual(before);
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
    const before = { sessions: await db.getAll("sessions"), senderKeys: await db.getAll("senderKeys") };
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
      expect({ sessions: await db.getAll("sessions"), senderKeys: await db.getAll("senderKeys") }).toEqual(before);
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
  const queued = await db.get("syncState", "pending-receive:waiting");
  expect(queued.frame).toEqual(message);
  expect(JSON.stringify(queued)).not.toContain("group plaintext");
  await reload();
  await sync.ingestMessageFrame(distribution);
  expect(await database.getMessageById("waiting")).toMatchObject({ content: "group plaintext", status: "delivered" });
  expect(await (await database.getAppDB()).get("syncState", "pending-receive:waiting")).toBeUndefined();
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
  const crash = crashOnOutput("syncState");
  await expect(sync.ingestMessageFrame(malformed)).rejects.toThrow();
  crash.mockRestore();
  expect(await db.getAll("sessions")).toEqual([]);
  expect(await db.get("syncState", "received:malformed")).toBeUndefined();
  expect(keys.peekOneTimePreKey(1)).toBeDefined();
  await reload();
  await sync.ingestMessageFrame(malformed);
  expect(await (await database.getAppDB()).get("syncState", "received:malformed")).toMatchObject({ failure: "invalid_sender_key_distribution" });
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
  expect(await db.getAll("sessions")).toEqual([]);
  expect(await db.get("syncState", "received:distribution")).toBeUndefined();
  await sync.ingestMessageFrame(distribution);
  expect(await db.getAll("senderKeys")).toHaveLength(1);
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
    const receipt = await database.getReceiveReceipt(poison.id);
    const failed = await database.getMessageById(poison.id);
    expect(receipt?.failure || failed?.status === "failed").toBeTruthy();
    expect(await (await database.getAppDB()).getAll("pendingCalls")).toEqual([]);
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
    const queued = await (await database.getAppDB()).get("syncState", "pending-receive:waiting");
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
  expect(await database.getReceiveReceipt(message.id)).toBeUndefined();
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
  expect(await database.getReceiveReceipt(message.id)).toBeUndefined();
  expect(await database.getSession("alice:alice-device")).toBeUndefined();
  await sync.ingestMessageFrame(message);
  expect(await database.getMessageById(message.id)).toMatchObject({ content: "retry the read", status: "delivered" });
});

it("atomically retires an authenticated malformed initial call offer and consumes its pre-key", async () => {
  const poison = await direct("bad-call", JSON.stringify({ kind: "call_offer" }), true, "system");
  await sync.ingestMessageFrame(poison);
  expect(await database.getReceiveReceipt(poison.id)).toMatchObject({ failure: "terminal_receive_error" });
  expect(await (await database.getAppDB()).getAll("pendingCalls")).toEqual([]);
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
  expect(await (await database.getAppDB()).get("syncState", "pending-receive:bad-pending")).toBeUndefined();
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
    expect(await database.getReceiveReceipt(message.id)).not.toHaveProperty("failure");
    expect(await database.getSession("alice:alice-device")).toBeDefined();
    const db = await database.getAppDB();
    if (kind === "system") expect(await db.getAll("pendingCalls")).toHaveLength(1);
    else expect(await db.getAll("senderKeys")).toHaveLength(1);
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
    expect(await database.getReceiveReceipt(message.id)).toMatchObject({ failure: "terminal_receive_error" });
    expect(chat.useChatStore.getState().messages.get("conv") ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: message.id })]));
    const db = await database.getAppDB();
    if (kind === "direct") expect(JSON.parse((await database.getSession("alice:alice-device"))!.state).recvMessageNumber).toBe(1);
    else expect((await db.getAll("senderKeys"))[0].chainIndex).toBe(1);
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
  const queued = (await db.getAll("syncState")).filter((row) => row.id.startsWith("pending-receive:"));
  expect(queued).toHaveLength(count);
  expect(await db.getAll("messages")).toEqual([]);
  expect(await db.getAll("senderKeys")).toEqual([]);
}, 15_000);
