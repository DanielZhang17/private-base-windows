import { expect, it } from "vitest";
import { decrypt, encrypt, generateIV } from "./aes-gcm.js";
import { deriveHistoryTransferKeys } from "./history-transfer.js";
import { generateX25519KeyPair } from "./prekeys.js";
import { toBase64Url } from "./utils.js";

it("binds the pre-shared secret, both public keys, both device IDs, room and attempt to the derived keys", async () => {
  const [sender, receiver] = await Promise.all([generateX25519KeyPair(), generateX25519KeyPair()]);
  const context = {
    psk: toBase64Url(new Uint8Array(11).fill(7)), roomId: "routing-id",
    receiverDeviceId: "new-device", senderDeviceId: "old-device",
    receiverPublicKey: toBase64Url(receiver.publicKey), senderPublicKey: toBase64Url(sender.publicKey),
    pairingId: "pair-1", linkId: "first-channel",
  };
  const send = await deriveHistoryTransferKeys(sender.privateKey, receiver.publicKey, context);
  const receive = await deriveHistoryTransferKeys(receiver.privateKey, sender.publicKey, context);
  expect(receive).toEqual(send);
  expect(send.checkCode).toMatch(/^\d{6}$/);
  expect(send.toSender).not.toEqual(send.toReceiver);

  const plaintext = new TextEncoder().encode("encrypted history");
  const iv = generateIV();
  const record = await encrypt(send.toReceiver, iv, plaintext);
  expect(await decrypt(receive.toReceiver, iv, record)).toEqual(plaintext);
  for (const property of Object.keys(context) as (keyof typeof context)[]) {
    const wrong = await deriveHistoryTransferKeys(receiver.privateKey, sender.publicKey, {
      ...context, [property]: property === "psk" ? toBase64Url(new Uint8Array(11).fill(8)) : "changed",
    });
    await expect(decrypt(wrong.toReceiver, iv, record)).rejects.toThrow();
    if (property === "linkId") expect(wrong.checkCode).toBe(send.checkCode);
  }
  await expect(deriveHistoryTransferKeys(sender.privateKey, new Uint8Array(32), context)).rejects.toThrow();
});

it("requires genuine BufferSources at the AES-GCM boundary and preserves sliced bytes", async () => {
  const { encrypt, decrypt } = await import("./aes-gcm.js");
  const { hkdf } = await import("./hkdf.js");
  const key = new Uint8Array(new SharedArrayBuffer(34)).subarray(1, 33);
  const iv = new Uint8Array(new SharedArrayBuffer(14)).subarray(1, 13);
  const aad = Uint8Array.of(99, 4, 5, 6, 99).subarray(1, 4);
  const sharedAAD = new Uint8Array(new SharedArrayBuffer(5)).subarray(1, 4);
  sharedAAD.set(aad);
  const message = Uint8Array.of(90, 1, 2, 3, 80).subarray(1, 4);

  const rawKey = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["encrypt"]);
  await expect(crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(iv),
    additionalData: { buffer: aad.buffer, byteLength: aad.byteLength } as unknown as BufferSource }, rawKey, message))
    .rejects.toThrow(TypeError);
  await expect(crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(iv),
    additionalData: sharedAAD as unknown as BufferSource }, rawKey, message))
    .rejects.toThrow(TypeError);

  const ciphertext = await encrypt(key, iv, message, sharedAAD);
  expect(await decrypt(key, iv, ciphertext, aad)).toEqual(message);
  expect(await hkdf(key, sharedAAD, aad, 16)).toEqual(await hkdf(new Uint8Array(key), aad, aad, 16));
});
