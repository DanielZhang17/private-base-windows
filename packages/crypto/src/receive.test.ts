import { describe, expect, it, vi } from "vitest";
import { generateIdentityKeyPair } from "./identity.js";
import { generateSignedPreKey } from "./prekeys.js";
import { initSessionAsInitiator, initSessionAsResponder, ratchetAdvanceOnly, ratchetDecrypt, ratchetEncrypt, serializeSession, type EncryptResult } from "./double-ratchet.js";
import { createDistribution, fromDistribution, generateSenderKey, senderKeyAdvanceOnly, senderKeyDecrypt, senderKeyEncrypt } from "./sender-keys.js";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("receive key retirement", () => {
  it("removes each skipped message key as soon as that message is decrypted", async () => {
    const identity = await generateIdentityKeyPair();
    const signed = await generateSignedPreKey(1, identity.privateEd25519);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const alice = await initSessionAsInitiator(secret, signed.keyPair.publicKey);
    const bob = await initSessionAsResponder(secret, signed.keyPair);
    const sent: EncryptResult[] = [];
    for (const text of ["first", "second", "third"]) sent.push(await ratchetEncrypt(alice, encode(text)));
    const receive = (index: number) => {
      const message = sent[index];
      return ratchetDecrypt(bob, message.header, message.ciphertext, message.iv);
    };
    expect(decode(await receive(2))).toBe("third");
    expect(bob.skippedKeys.size).toBe(2);
    const firstKeyId = `${sent[0].header.dhPublicKey}:0`;
    expect(bob.skippedKeys.has(firstKeyId)).toBe(true);
    expect(decode(await receive(0))).toBe("first");
    expect(bob.skippedKeys.has(firstKeyId)).toBe(false);
    expect(bob.skippedKeys.size).toBe(1);
    expect(decode(await receive(1))).toBe("second");
    expect(serializeSession(bob).skippedKeys).toEqual([]);
  });

  it("advances group keys without retaining a key that can decrypt an already consumed message", async () => {
    const sender = await generateSenderKey();
    const receiver = fromDistribution(createDistribution(sender));
    const previousChain = receiver.chainKey.slice();
    const message = await senderKeyEncrypt(sender, encode("group message"));
    expect(decode(await senderKeyDecrypt(receiver, message.header, message.ciphertext, message.iv))).toBe("group message");
    expect(receiver.chainKey).not.toEqual(previousChain);
    expect(receiver.chainIndex).toBe(1);
    expect(receiver.signingPrivateKey).toHaveLength(0);
    await expect(senderKeyDecrypt(receiver, message.header, message.ciphertext, message.iv)).rejects.toThrow("outdated");
  });
});

it("advances direct ratchets and removes skipped keys without decrypting, and leaves forged state untouched", async () => {
  const identity = await generateIdentityKeyPair();
  const signed = await generateSignedPreKey(1, identity.privateEd25519);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const alice = await initSessionAsInitiator(secret, signed.keyPair.publicKey);
  const bob = await initSessionAsResponder(secret, signed.keyPair);
  const first = await ratchetEncrypt(alice, encode("deleted one"));
  const second = await ratchetEncrypt(alice, encode("deleted two"));
  const third = await ratchetEncrypt(alice, encode("live"));
  const invalidTag = (envelope: EncryptResult) => {
    const copy = envelope.ciphertext.slice();
    copy[copy.length - 1] ^= 1;
    return copy;
  };
  const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockRejectedValue(new Error("advance-only attempted to decrypt"));
  try {
    const initial = serializeSession(bob);
    await expect(ratchetAdvanceOnly(bob, second.header, invalidTag(second), second.iv)).rejects.toThrow("authentication tag");
    await expect(ratchetAdvanceOnly(bob, { ...second.header, n: 0 }, second.ciphertext, second.iv)).rejects.toThrow("authentication tag");
    expect(serializeSession(bob)).toEqual(initial);
    await expect(ratchetAdvanceOnly(bob, second.header, second.ciphertext, second.iv)).resolves.toBeUndefined();
    expect(bob.recvMessageNumber).toBe(2);
    const skipped = bob.skippedKeys.get(`${first.header.dhPublicKey}:0`)!;
    const advanced = serializeSession(bob);
    await expect(ratchetAdvanceOnly(bob, first.header, invalidTag(first), first.iv)).rejects.toThrow("authentication tag");
    expect(serializeSession(bob)).toEqual(advanced);
    await expect(ratchetAdvanceOnly(bob, first.header, first.ciphertext, first.iv)).resolves.toBeUndefined();
    expect(bob.skippedKeys.size).toBe(0);
    expect(skipped).toEqual(new Uint8Array(32));
    expect(decrypt).not.toHaveBeenCalled();
  } finally {
    decrypt.mockRestore();
  }
  expect(decode(await ratchetDecrypt(bob, third.header, third.ciphertext, third.iv))).toBe("live");
});

it("authenticates the group signature, IV and iteration before advancing and produces no plaintext", async () => {
  const sender = await generateSenderKey();
  const receiver = fromDistribution(createDistribution(sender));
  const before = createDistribution(receiver);
  const deleted = await senderKeyEncrypt(sender, encode("deleted group content"));
  const live = await senderKeyEncrypt(sender, encode("live"));
  const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockRejectedValue(new Error("advance-only attempted to decrypt"));
  try {
    const garbled = deleted.ciphertext.slice();
    garbled[0] ^= 1;
    await expect(senderKeyAdvanceOnly(receiver, deleted.header, garbled, deleted.iv)).rejects.toThrow("signature");
    await expect(senderKeyAdvanceOnly(receiver, { ...deleted.header, chainIndex: 1 }, deleted.ciphertext, deleted.iv)).rejects.toThrow("authentication tag");
    const iv = deleted.iv.slice();
    iv[0] ^= 1;
    await expect(senderKeyAdvanceOnly(receiver, deleted.header, deleted.ciphertext, iv)).rejects.toThrow("authentication tag");
    expect(createDistribution(receiver)).toEqual(before);
    await expect(senderKeyAdvanceOnly(receiver, deleted.header, deleted.ciphertext, deleted.iv)).resolves.toBeUndefined();
    expect(receiver.chainIndex).toBe(1);
    expect(decrypt).not.toHaveBeenCalled();
  } finally {
    decrypt.mockRestore();
  }
  expect(decode(await senderKeyDecrypt(receiver, live.header, live.ciphertext, live.iv))).toBe("live");
});
