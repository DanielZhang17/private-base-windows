import { expect, it } from "vitest";
import { decrypt, encrypt } from "./aes-gcm.js";
import { hkdf } from "./hkdf.js";

function sharedSubview(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(new SharedArrayBuffer(bytes.length + 4));
  padded.set(bytes, 2);
  return padded.subarray(2, bytes.length + 2);
}

it("uses Chromium-compatible BufferSources with or without additional authenticated data", async () => {
  const key = sharedSubview(new Uint8Array(32).fill(7));
  const iv = sharedSubview(new Uint8Array(12).fill(8));
  const plaintext = sharedSubview(Uint8Array.of(1, 2, 3));
  const aad = sharedSubview(Uint8Array.of(4, 5, 6));
  const unbound = await encrypt(key, iv, plaintext);
  expect(await decrypt(key, iv, sharedSubview(unbound))).toEqual(Uint8Array.of(1, 2, 3));
  const bound = await encrypt(key, iv, plaintext, aad);
  expect(await decrypt(key, iv, bound, aad)).toEqual(Uint8Array.of(1, 2, 3));
  await expect(decrypt(key, iv, bound)).rejects.toMatchObject({ name: "OperationError" });
});

it("retains HKDF byte ranges when the input, salt, and info use shared storage", async () => {
  const input = Uint8Array.of(1, 2, 3);
  const salt = Uint8Array.of(4, 5);
  const info = Uint8Array.of(6, 7);
  expect(await hkdf(sharedSubview(input), sharedSubview(salt), sharedSubview(info), 32))
    .toEqual(await hkdf(input, salt, info, 32));
});

it("makes Vitest reject explicit undefined optional parameters and shared buffers", async () => {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12);
  await expect(crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: undefined }, key, new Uint8Array(0)))
    .rejects.toThrow("additionalData: Not a BufferSource");
  const shared = sharedSubview(Uint8Array.of(1)) as unknown as BufferSource;
  await expect(crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, shared)).rejects.toThrow("Not a BufferSource");
});
