import { beforeEach, expect, it, vi } from "vitest";
import { generateIdentityKeyPair, generateOneTimePreKeys, generateSignedPreKey, toBase64Url, type IdentityKeyPair, type OneTimePreKey, type SignedPreKey } from "@e2ee-chat/crypto";
import { getAppDB, getSession, saveQueuedMessage } from "../../db/index.js";
import { api } from "../../services/api.js";
import { encryptMessage } from "../../lib/message-processor.js";
import { decryptInitialMessage, encryptForDevice, decryptFromDevice } from "../../lib/session-manager.js";
import { discardOutgoing } from "./outgoingQueue.js";

let identity: IdentityKeyPair;
let signed: SignedPreKey;
let otp: OneTimePreKey;
vi.mock("../../lib/key-manager.js", () => ({ keysLoaded: () => true, getIdentityKeyPair: () => identity, getSignedPreKey: () => signed, findOneTimePreKey: async () => otp, consumeOneTimePreKey: async () => {} }));
vi.mock("../../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ user: { id: "alice" }, device: { id: "alice-device" }, accessToken: "token" }) } }));
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn() } }));
vi.mock("../../lib/conversation-cache.js", () => ({ touchConversationInCache: vi.fn() }));
beforeEach(async () => {
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
});
function receive(messageId: string) {
  return { messageId, prepare: async (plaintext: Uint8Array) => ({ expiresAt: null, message: {
    id: messageId, conversationId: "chat", senderId: "alice", type: "text", content: new TextDecoder().decode(plaintext!),
    timestamp: Date.now(), expiresAt: null, status: "delivered",
  } }) };
}
it("F1: decrypts the next send after discarding the only unsent X3DH bootstrap envelope", async () => {
  const alice = await generateIdentityKeyPair();
  const bob = await generateIdentityKeyPair();
  identity = alice;
  signed = await generateSignedPreKey(1, bob.privateEd25519);
  [otp] = await generateOneTimePreKeys(10, 1);
  vi.mocked(api.get).mockResolvedValue({ deviceId: "bob-device", identityKey: toBase64Url(bob.publicEd25519), signedPreKey: toBase64Url(signed.keyPair.publicKey), signedPreKeyId: signed.id, signedPreKeySig: toBase64Url(signed.signature), oneTimePreKey: { id: otp.id, key: toBase64Url(otp.keyPair.publicKey) } } as never);
  const first = await encryptMessage("direct", "discarded", "bob", "bob-device");
  await saveQueuedMessage({ id: "first", conversationId: "chat", senderId: "alice", type: "text", content: "discarded", status: "failed", timestamp: 1, expiresAt: null }, {
    id: "first", queuedAt: 1, conversationId: "chat", conversationType: "direct", userId: "alice", deviceId: "alice-device", ttlSeconds: null, attempts: 1, status: "failed", retryable: false, nextAttemptAt: null, error: "offline",
    steps: [{ path: "/api/messages/send-direct-batch", body: { conversationId: "chat", type: "text", messages: [{ id: "first", ...first }] } }],
  });
  const before = await getSession("bob:bob-device");
  await discardOutgoing("first");
  // Discard must not roll back a session potentially shared with other prepared envelopes.
  expect(await getSession("bob:bob-device")).toEqual(before);
  const next = await encryptForDevice("bob", "bob-device", new TextEncoder().encode("next"));
  expect(next.initialHeader?.ephemeralKey).toBe(JSON.parse(first.header).initial.ephemeralKey);
  expect(next.result.header.n).toBe(1);
  identity = bob;
  const plaintext = await decryptInitialMessage("alice", "alice-device", next.initialHeader!, next.result.header, next.result.ciphertext, next.result.iv, receive("next"));
  expect(new TextDecoder().decode(plaintext!)).toBe("next");
  const reply = await encryptForDevice("alice", "alice-device", new TextEncoder().encode("reply"));
  identity = alice;
  await decryptFromDevice("bob", "bob-device", reply.result.header, reply.result.ciphertext, reply.result.iv, receive("reply"));
  expect((await encryptForDevice("bob", "bob-device", new TextEncoder().encode("confirmed"))).initialHeader).toBeUndefined();
});
