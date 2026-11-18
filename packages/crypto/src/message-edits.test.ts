import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aesDecrypt, aesEncrypt, createDistribution, decryptMessageEdit, encryptMessageEdit, fromDistribution, generateAESKey, generateIV,
  generateIdentityKeyPair, generateSenderKey, generateX25519KeyPair, initSessionAsInitiator, initSessionAsResponder,
  ratchetDecrypt, ratchetEncrypt, senderKeyDecrypt, senderKeyEncrypt,
} from "./index.js";
import { concat, fromBase64Url, toBase64Url } from "./utils.js";
import { messageEditAAD } from "./message-edits.js";
import { sign } from "./identity.js";
import { strictWebCrypto } from "./test/strict-webcrypto.js";

const scope = { conversationId: "room", messageId: "original", senderId: "alice", senderDeviceId: "alice-device" };
const originalText = "Original text 🐋";
const originalBytes = new TextEncoder().encode(originalText);

describe("per-message edits", () => {
  beforeEach(() => { vi.stubGlobal("crypto", strictWebCrypto(crypto)); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("copies shared-buffer byte ranges before importing or encrypting with them", async () => {
    function sharedSlice(bytes: Uint8Array) {
      const padded = new Uint8Array(new SharedArrayBuffer(bytes.length + 2)).fill(255);
      padded.set(bytes, 1);
      return padded.subarray(1, padded.length - 1);
    }
    const key = generateAESKey(), iv = generateIV(), aad = messageEditAAD(scope, 1);
    const ciphertext = await aesEncrypt(sharedSlice(key), sharedSlice(iv), sharedSlice(originalBytes), sharedSlice(aad));
    expect(await aesDecrypt(key, iv, ciphertext, aad)).toEqual(originalBytes);
    expect(await aesDecrypt(sharedSlice(key), sharedSlice(iv), sharedSlice(ciphertext), sharedSlice(aad))).toEqual(originalBytes);
  });

  it("encrypts each revision with a fresh nonce and verifies the original device signature", async () => {
    const key = generateAESKey();
    const author = await generateIdentityKeyPair();
    const otherDevice = await generateIdentityKeyPair();
    const edit = await encryptMessageEdit(key, author.privateEd25519, scope, 2, "Revised text");
    expect(fromBase64Url(edit.nonce)).toHaveLength(12);
    expect((await encryptMessageEdit(key, author.privateEd25519, scope, 2, "Revised text")).nonce).not.toBe(edit.nonce);
    await expect(decryptMessageEdit(key, author.publicEd25519, scope, 2, edit)).resolves.toBe("Revised text");
    await expect(decryptMessageEdit(generateAESKey(), author.publicEd25519, scope, 2, edit)).rejects.toThrow();
    const forgery = await encryptMessageEdit(key, otherDevice.privateEd25519, scope, 2, "Forged text");
    await expect(decryptMessageEdit(key, author.publicEd25519, scope, 2, forgery)).rejects.toThrow("Invalid edit signature");
  });

  it("binds all family fields and the sequence in both the signature and AES-GCM", async () => {
    const key = generateAESKey();
    const author = await generateIdentityKeyPair();
    const edit = await encryptMessageEdit(key, author.privateEd25519, scope, 2, "Revised text");
    for (const field of Object.keys(scope)) {
      await expect(decryptMessageEdit(key, author.publicEd25519, { ...scope, [field]: "swapped" }, 2, edit))
        .rejects.toThrow("Invalid edit signature");
    }
    await expect(decryptMessageEdit(key, author.publicEd25519, scope, 3, edit)).rejects.toThrow("Invalid edit signature");
    const signature = toBase64Url(await sign(author.privateEd25519, concat(
      messageEditAAD(scope, 3), fromBase64Url(edit.nonce), fromBase64Url(edit.ciphertext),
    )));
    await expect(decryptMessageEdit(key, author.publicEd25519, scope, 3, { ...edit, signature })).rejects.toThrow();
  });

  it("keeps the signed sequence field exactly 16 bytes across the safe integer range", () => {
    const prefix = "room|original|alice|alice-device|";
    for (const seq of [1, 12, Number.MAX_SAFE_INTEGER]) {
      const bytes = messageEditAAD(scope, seq);
      expect(bytes.byteLength).toBe(prefix.length + 16);
      expect(new TextDecoder().decode(bytes)).toBe(prefix + String(seq).padStart(16, "0"));
    }
  });

  it("preserves plaintext for a direct reader that ignores the extra header field", async () => {
    const secret = generateAESKey(), preKey = await generateX25519KeyPair();
    const sending = await initSessionAsInitiator(secret, preKey.publicKey);
    const receiving = await initSessionAsResponder(secret, preKey);
    const legacy = await initSessionAsResponder(secret, preKey);
    const author = await generateIdentityKeyPair();
    const companion = concat(generateAESKey(), author.publicEd25519);
    const original = await ratchetEncrypt(sending, originalBytes, { scope, bytes: companion });
    const header = JSON.parse(JSON.stringify({ ...original.header, editKey: original.sealedEditKey }));
    expect(await ratchetDecrypt(legacy, header, original.ciphertext, original.iv)).toEqual(originalBytes);
    const opened = new Uint8Array(64);
    expect(await ratchetDecrypt(receiving, header, original.ciphertext, original.iv, {
      scope, sealed: header.editKey, accept: (bytes) => opened.set(bytes),
    })).toEqual(originalBytes);
    expect(opened).toEqual(companion);
  });

  it("keeps group edits unreadable to a later device and authenticates the group companion", async () => {
    const sending = await generateSenderKey();
    const initial = createDistribution(sending);
    const author = await generateIdentityKeyPair();
    const key = generateAESKey();
    const original = await senderKeyEncrypt(sending, originalBytes, { scope, bytes: concat(key, author.publicEd25519) });
    const header = JSON.parse(JSON.stringify({ ...original.header, editKey: original.sealedEditKey }));
    expect(await senderKeyDecrypt(fromDistribution(initial), header, original.ciphertext, original.iv)).toEqual(originalBytes);
    const opened = new Uint8Array(64);
    await senderKeyDecrypt(fromDistribution(initial), header, original.ciphertext, original.iv, {
      scope, sealed: header.editKey, accept: (bytes) => opened.set(bytes),
    });
    const edit = await encryptMessageEdit(key, author.privateEd25519, scope, 1, "Group edit");
    await expect(decryptMessageEdit(opened.slice(0, 32), opened.slice(32), scope, 1, edit)).resolves.toBe("Group edit");
    const laterDevice = fromDistribution(createDistribution(sending));
    await expect(senderKeyDecrypt(laterDevice, header, original.ciphertext, original.iv)).rejects.toThrow("outdated");
    await expect(decryptMessageEdit(laterDevice.chainKey, author.publicEd25519, scope, 1, edit)).rejects.toThrow();
    const invalid = { ...header.editKey, signature: toBase64Url(new Uint8Array(64)) };
    expect(await senderKeyDecrypt(fromDistribution(initial), header, original.ciphertext, original.iv, {
      scope, sealed: invalid, accept: () => { throw new Error("Accepted a forged companion"); },
    })).toEqual(originalBytes);
  });
});
