import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InitialMessageHeader, RatchetHeader } from "@e2ee-chat/shared";
import {
  deserializeSession,
  fromBase64Url,
  generateIdentityKeyPair,
  generateOneTimePreKeys,
  generateSignedPreKey,
  initSessionAsResponder,
  ratchetEncrypt,
  serializeSession,
  toBase64Url,
  x3dhRespond,
  type IdentityKeyPair,
  type OneTimePreKey,
  type SignedPreKey,
} from "@e2ee-chat/crypto";
import { getAppDB, getSession, saveMessage as writeOwnedMessage, saveSession } from "../db/index.js";
import { api } from "../services/api.js";
import { decryptMessage as decryptMessageAndCommit, type IncomingMessage } from "./message-processor.js";
import { decryptFromDevice as decryptFromDeviceAndCommit, decryptInitialMessage as decryptInitialMessageAndCommit, encryptForDevice, resetSession } from "./session-manager.js";
import { consumeOneTimePreKey, findOneTimePreKey } from "./key-manager.js";

const saveMessage = (row: Parameters<typeof writeOwnedMessage>[0], current?: () => boolean, ownerId = row.ownerId ?? "bob") =>
  writeOwnedMessage(row, current, ownerId);

let identity: IdentityKeyPair;
let signed: SignedPreKey;
let otps: OneTimePreKey[];

vi.mock("./key-manager.js", () => ({
  keysLoaded: () => true,
  getIdentityKeyPair: () => identity,
  getSignedPreKey: () => signed,
  findOneTimePreKey: vi.fn(async (id: number) => otps.find((key) => key.id === id)),
  consumeOneTimePreKey: vi.fn(async (id: number) => {
    // The session must already be durable before consuming the OTP.
    expect((await getSession("alice:alice-device"))?.x3dhEphemeralKey).toBeTruthy();
    otps = otps.filter((key) => key.id !== id);
  }),
  lockLocalCryptoState: vi.fn(),
}));
vi.mock("../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ user: null, device: null }) } }));
vi.mock("../services/api.js", () => ({ api: { get: vi.fn() } }));

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | null) => new TextDecoder().decode(bytes!);

function receive(messageId: string) {
  return { messageId, prepare: async (plaintext: Uint8Array) => ({ expiresAt: null, message: {
    id: messageId, conversationId: "conv", senderId: "alice", type: "text", content: decode(plaintext),
    timestamp: Date.now(), expiresAt: null, status: "delivered",
  } }) };
}
const decryptMessage = (type: "direct", msg: IncomingMessage) => decryptMessageAndCommit(type, msg, receive(msg.id));
function decryptFromDevice(userId: string, deviceId: string, header: RatchetHeader, ciphertext: Uint8Array, iv: Uint8Array) {
  return decryptFromDeviceAndCommit(userId, deviceId, header, ciphertext, iv, receive(crypto.randomUUID()));
}
function decryptInitialMessage(userId: string, deviceId: string, initial: InitialMessageHeader, header: RatchetHeader, ciphertext: Uint8Array, iv: Uint8Array, messageId: string) {
  return decryptInitialMessageAndCommit(userId, deviceId, initial, header, ciphertext, iv, receive(messageId));
}

async function send(userId: string, deviceId: string, text: string) {
  return encryptForDevice(userId, deviceId, encode(text));
}

function incoming(sent: Awaited<ReturnType<typeof send>>, id: string): IncomingMessage {
  return {
    id, senderId: "alice", senderDeviceId: "alice-device", type: "text",
    ciphertext: toBase64Url(sent.result.ciphertext), iv: toBase64Url(sent.result.iv),
    header: JSON.stringify({ ...sent.result.header, recipientDeviceId: "bob-device", initial: sent.initialHeader }),
  };
}

describe("initial-message session safety", () => {
  let alice: IdentityKeyPair;
  let bob: IdentityKeyPair;

  beforeEach(async () => {
    const db = await getAppDB();
    await Promise.all(Array.from(db.objectStoreNames, (name) => db.clear(name)));
    vi.clearAllMocks();
    alice = await generateIdentityKeyPair();
    bob = await generateIdentityKeyPair();
    signed = await generateSignedPreKey(1, bob.privateEd25519);
    otps = await generateOneTimePreKeys(100, 2);
    identity = alice;
    vi.mocked(api.get).mockImplementation(async () => ({
      deviceId: "bob-device",
      identityKey: toBase64Url(bob.publicEd25519),
      signedPreKey: toBase64Url(signed.keyPair.publicKey),
      signedPreKeyId: signed.id,
      signedPreKeySig: toBase64Url(signed.signature),
      oneTimePreKey: otps[0] && { id: otps[0].id, key: toBase64Url(otps[0].keyPair.publicKey) },
    }));
  });

  it("still delivers an initial message when removing its one-time pre-key fails", async () => {
    const first = await send("bob", "bob-device", "first");
    identity = bob;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(consumeOneTimePreKey).mockRejectedValueOnce(new Error("IndexedDB write failed"));
    expect(await decryptMessage("direct", incoming(first, "first"))).toBe("first");
    expect(consumeOneTimePreKey).toHaveBeenCalledExactlyOnceWith(100);
    expect((await getSession("alice:alice-device"))?.x3dhEphemeralKey).toBe(first.initialHeader?.ephemeralKey);
  });

  it("survives a replay after bidirectional ratcheting and accepts a new initial", async () => {
    const first = await send("bob", "bob-device", "first");
    expect((await getSession("bob:bob-device"))?.x3dhEphemeralKey).toBe(first.initialHeader?.ephemeralKey);
    identity = bob;
    expect(await decryptMessage("direct", incoming(first, "first"))).toBe("first");
    expect(consumeOneTimePreKey).toHaveBeenCalledExactlyOnceWith(100);
    const reply = await send("alice", "alice-device", "reply");
    expect(decode(await decryptFromDevice("bob", "bob-device", reply.result.header, reply.result.ciphertext, reply.result.iv))).toBe("reply");
    const next = await send("bob", "bob-device", "next");
    expect(await decryptMessage("direct", incoming(next, "next"))).toBe("next");

    const beforeReplay = await getSession("alice:alice-device");
    vi.mocked(findOneTimePreKey).mockClear();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await decryptMessage("direct", incoming(first, "first"))).toBeNull();
    } finally {
      log.mockRestore();
    }
    expect(await getSession("alice:alice-device")).toEqual(beforeReplay);
    expect(findOneTimePreKey).not.toHaveBeenCalled();
    expect(consumeOneTimePreKey).toHaveBeenCalledTimes(1);
    const afterReplay = await send("bob", "bob-device", "after replay");
    expect(await decryptMessage("direct", incoming(afterReplay, "after"))).toBe("after replay");
    const secondReply = await send("alice", "alice-device", "still works");
    expect(decode(await decryptFromDevice("bob", "bob-device", secondReply.result.header, secondReply.result.ciphertext, secondReply.result.iv))).toBe("still works");
    expect((await getSession("alice:alice-device"))?.x3dhEphemeralKey).toBe(first.initialHeader?.ephemeralKey);

    identity = alice;
    await resetSession("bob", "bob-device");
    const restarted = await send("bob", "bob-device", "restarted");
    expect(restarted.initialHeader?.ephemeralKey).not.toBe(first.initialHeader?.ephemeralKey);
    identity = bob;
    expect(await decryptMessage("direct", incoming(restarted, "restart"))).toBe("restarted");
    expect((await getSession("alice:alice-device"))?.x3dhEphemeralKey).toBe(restarted.initialHeader?.ephemeralKey);
    expect(consumeOneTimePreKey).toHaveBeenCalledTimes(2);
  });

  it("records a fresh ephemeral key when recovering a responder-only send session", async () => {
    const responder = await initSessionAsResponder(new Uint8Array(32), signed.keyPair);
    await saveSession({ id: "bob:bob-device", state: JSON.stringify(serializeSession(responder)), updatedAt: 1, x3dhEphemeralKey: "old" });
    const recovered = await send("bob", "bob-device", "recovered");
    expect(recovered.isInitial).toBe(true);
    expect((await getSession("bob:bob-device"))?.x3dhEphemeralKey).toBe(recovered.initialHeader?.ephemeralKey);
    expect(recovered.initialHeader?.ephemeralKey).not.toBe("old");
    identity = bob;
    expect(await decryptMessage("direct", incoming(recovered, "recovered"))).toBe("recovered");
  });

  it("does not consume an OTP or save a failed candidate, with or without an existing session", async () => {
    const first = await send("bob", "bob-device", "valid");
    identity = bob;
    const damaged = first.result.ciphertext.slice();
    damaged[0] ^= 1;
    await expect(decryptInitialMessage("alice", "alice-device", first.initialHeader!, first.result.header, damaged, first.result.iv, "bad")).rejects.toThrow();
    expect(await getSession("alice:alice-device")).toBeUndefined();
    expect(consumeOneTimePreKey).not.toHaveBeenCalled();
    expect(findOneTimePreKey).toHaveBeenCalledWith(100);
    expect(await decryptMessage("direct", incoming(first, "valid"))).toBe("valid");

    identity = alice;
    await resetSession("bob", "bob-device");
    const fresh = await send("bob", "bob-device", "fresh");
    identity = bob;
    const before = await getSession("alice:alice-device");
    vi.mocked(consumeOneTimePreKey).mockClear();
    const invalid = fresh.result.ciphertext.slice();
    invalid[0] ^= 1;
    await expect(decryptInitialMessage("alice", "alice-device", fresh.initialHeader!, fresh.result.header, invalid, fresh.result.iv, "bad-new")).rejects.toThrow();
    expect(await getSession("alice:alice-device")).toEqual(before);
    expect(consumeOneTimePreKey).not.toHaveBeenCalled();
    expect(await decryptMessage("direct", incoming(fresh, "fresh"))).toBe("fresh");
  });

  it("never rebuilds a legacy session for an already stored message", async () => {
    const first = await send("bob", "bob-device", "first");
    identity = bob;
    expect(await decryptMessage("direct", incoming(first, "stored"))).toBe("first");
    const stored = (await getSession("alice:alice-device"))!;
    delete stored.x3dhEphemeralKey;
    await saveSession(stored);
    await saveMessage({ id: "stored", conversationId: "conv", senderId: "alice", type: "text", content: "first", timestamp: Date.now(), expiresAt: null, status: "delivered" });
    vi.mocked(findOneTimePreKey).mockClear();
    await expect(decryptInitialMessage("alice", "alice-device", first.initialHeader!, first.result.header, first.result.ciphertext, first.result.iv, "stored")).resolves.toBeNull();
    expect(await getSession("alice:alice-device")).toEqual(stored);
    expect(findOneTimePreKey).not.toHaveBeenCalled();
  });

  it("backfills a legacy session's ephemeral key and strictly rejects later replays", async () => {
    const first = await send("bob", "bob-device", "first");
    identity = bob;
    const header = first.initialHeader!;
    const secret = await x3dhRespond(bob.privateX25519, signed.keyPair.privateKey, otps[0].keyPair.privateKey, alice.publicEd25519, fromBase64Url(header.ephemeralKey));
    const responder = await initSessionAsResponder(secret, signed.keyPair);
    await saveSession({ id: "alice:alice-device", state: JSON.stringify(serializeSession(responder)), updatedAt: 1 });

    expect(decode(await decryptInitialMessage("alice", "alice-device", header, first.result.header, first.result.ciphertext, first.result.iv, "legacy-first"))).toBe("first");
    const stored = (await getSession("alice:alice-device"))!;
    expect(stored.x3dhEphemeralKey).toBe(header.ephemeralKey);
    expect(consumeOneTimePreKey).not.toHaveBeenCalled();
    vi.mocked(findOneTimePreKey).mockClear();

    // The OTP is still present, so rebuilding would incorrectly decrypt this replay.
    await expect(decryptInitialMessage("alice", "alice-device", header, first.result.header, first.result.ciphertext, first.result.iv, "legacy-replay")).rejects.toThrow();
    expect(await getSession("alice:alice-device")).toEqual(stored);
    expect(findOneTimePreKey).not.toHaveBeenCalled();
    expect(consumeOneTimePreKey).not.toHaveBeenCalled();
    const next = await send("bob", "bob-device", "after legacy replay");
    expect(await decryptMessage("direct", incoming(next, "legacy-next"))).toBe("after legacy replay");
  });

  it("retires replaced ephemeral keys and rejects old no-OTP initials without changing the new session", async () => {
    otps = [];
    const first = await send("bob", "bob-device", "first without OTP");
    expect(first.initialHeader?.oneTimePreKeyId).toBeUndefined();
    identity = bob;
    expect(await decryptMessage("direct", incoming(first, "first-no-otp"))).toBe("first without OTP");
    const previousRetired = Array.from({ length: 20 }, (_, index) => `retired-${index}`);
    const stored = (await getSession("alice:alice-device"))!;
    await saveSession({ ...stored, retiredEphemeralKeys: [...previousRetired, previousRetired[19]] });

    identity = alice;
    await resetSession("bob", "bob-device");
    const fresh = await send("bob", "bob-device", "fresh without OTP");
    identity = bob;
    expect(await decryptMessage("direct", incoming(fresh, "fresh-no-otp"))).toBe("fresh without OTP");
    const replaced = (await getSession("alice:alice-device"))!;
    const expectedRetired = [...previousRetired.slice(1), first.initialHeader!.ephemeralKey];
    expect(replaced.x3dhEphemeralKey).toBe(fresh.initialHeader?.ephemeralKey);
    expect(replaced.retiredEphemeralKeys).toEqual(expectedRetired);
    vi.mocked(findOneTimePreKey).mockClear();
    vi.mocked(consumeOneTimePreKey).mockClear();

    for (const header of [first.initialHeader!, { ...first.initialHeader!, oneTimePreKeyId: 100 }]) {
      await expect(decryptInitialMessage("alice", "alice-device", header, first.result.header, first.result.ciphertext, first.result.iv, "retired-replay")).rejects.toThrow("Could not decrypt message");
    }
    expect(await getSession("alice:alice-device")).toEqual(replaced);
    expect(findOneTimePreKey).not.toHaveBeenCalled();
    expect(consumeOneTimePreKey).not.toHaveBeenCalled();

    const reply = await send("alice", "alice-device", "reply after retired replay");
    expect(decode(await decryptFromDevice("bob", "bob-device", reply.result.header, reply.result.ciphertext, reply.result.iv))).toBe("reply after retired replay");
    expect((await getSession("alice:alice-device"))?.retiredEphemeralKeys).toEqual(expectedRetired);
    const next = await send("bob", "bob-device", "next after retired replay");
    expect(await decryptMessage("direct", incoming(next, "next-no-otp"))).toBe("next after retired replay");
    expect((await getSession("alice:alice-device"))?.retiredEphemeralKeys).toEqual(expectedRetired);
  });

  it("decrypts a legacy ratchet in place and serializes duplicate initials", async () => {
    const first = await send("bob", "bob-device", "first");
    identity = bob;
    const header = first.initialHeader!;
    const secret = await x3dhRespond(bob.privateX25519, signed.keyPair.privateKey, otps[0].keyPair.privateKey, alice.publicEd25519, fromBase64Url(header.ephemeralKey));
    const responder = await initSessionAsResponder(secret, signed.keyPair);
    await saveSession({ id: "alice:alice-device", state: JSON.stringify(serializeSession(responder)), updatedAt: 1 });
    expect(decode(await decryptInitialMessage("alice", "alice-device", header, first.result.header, first.result.ciphertext, first.result.iv, "legacy"))).toBe("first");
    expect(consumeOneTimePreKey).not.toHaveBeenCalled();
    // A different initial can replace this legacy ratchet only after authentication.
    identity = alice;
    await resetSession("bob", "bob-device");
    const fresh = await send("bob", "bob-device", "fresh");
    identity = bob;
    const outcomes = await Promise.allSettled([1, 2].map(() => decryptInitialMessage("alice", "alice-device", fresh.initialHeader!, fresh.result.header, fresh.result.ciphertext, fresh.result.iv, "fresh")));
    expect(outcomes.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(outcomes[1]).toMatchObject({ value: null });
    expect(consumeOneTimePreKey).toHaveBeenCalledTimes(1);
    const latest = deserializeSession(JSON.parse((await getSession("alice:alice-device"))!.state));
    const reply = await ratchetEncrypt(latest, encode("reply"));
    expect(decode(await decryptFromDevice("bob", "bob-device", reply.header, reply.ciphertext, reply.iv))).toBe("reply");
  });
});
