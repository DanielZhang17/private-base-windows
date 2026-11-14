import { describe, expect, it } from "vitest";
import { generateIdentityKeyPair } from "./identity.js";
import { generateSignedPreKey } from "./prekeys.js";
import { initSessionAsInitiator, initSessionAsResponder, ratchetDecrypt, ratchetEncrypt, serializeSession, type EncryptResult } from "./double-ratchet.js";
import { createDistribution, fromDistribution, generateSenderKey, senderKeyDecrypt, senderKeyEncrypt } from "./sender-keys.js";

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
