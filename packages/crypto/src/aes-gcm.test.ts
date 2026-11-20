import { expect, it, vi } from "vitest";
import { decrypt, encrypt, verifyTag } from "./aes-gcm.js";
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

const hex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16));

// NIST GCM examples with a 96-bit IV and full tag, including a partial
// final block in both the AAD and ciphertext.
it.each([
  {
    key: "00".repeat(16), iv: "00".repeat(12), aad: "", ciphertext: "",
    tag: "58e2fccefa7e3061367f1d57a4e7455a",
  },
  {
    key: "00".repeat(16), iv: "00".repeat(12), aad: "", ciphertext: "0388dace60b6a392f328c2b971b2fe78",
    tag: "ab6e47d42cec13bdf53a67b21257bddf",
  },
  {
    key: "feffe9928665731c6d6a8f9467308308", iv: "cafebabefacedbaddecaf888", aad: "feedfacedeadbeeffeedfacedeadbeefabaddad2",
    ciphertext: "42831ec2217774244b7221b784d0d49c" + "e3aa212f2c02a4e035c17e2329aca12e"
      + "21d514b25466931c7d8f6a5aac84aa05" + "1ba30b396a0aac973d58e091",
    tag: "5bc94fbc3221a5db94fae95ae7121a47",
  },
  {
    key: "00".repeat(32), iv: "00".repeat(12), aad: "", ciphertext: "",
    tag: "530f8afbc74536b9a963b4f1c4cb738b",
  },
])("verifies a NIST GCM vector without applying CTR to the ciphertext ($tag)", async ({ key, iv, aad, ciphertext, tag }) => {
  const open = vi.spyOn(crypto.subtle, "decrypt");
  const block = vi.spyOn(crypto.subtle, "encrypt");
  try {
    const envelope = hex(ciphertext + tag);
    await expect(verifyTag(sharedSubview(hex(key)), sharedSubview(hex(iv)), sharedSubview(envelope), sharedSubview(hex(aad)))).resolves.toBe(true);
    expect(block).toHaveBeenCalledTimes(2);
    for (const [algorithm, , input] of block.mock.calls) {
      expect(algorithm).toMatchObject({ name: "AES-CTR", length: 32 });
      expect(input).toEqual(new Uint8Array(16));
    }
    expect(block.mock.calls.map(([algorithm]) => (algorithm as AesCtrParams).counter)).toEqual([
      new Uint8Array(16), hex(iv + "00000001"),
    ]);

    const badTag = envelope.slice();
    badTag[badTag.length - 1] ^= 1;
    await expect(verifyTag(hex(key), hex(iv), badTag, hex(aad))).resolves.toBe(false);
    await expect(verifyTag(hex(key), hex(iv), envelope, hex(aad + "ff"))).resolves.toBe(false);
    const badIv = hex(iv);
    badIv[0] ^= 1;
    await expect(verifyTag(hex(key), badIv, envelope, hex(aad))).resolves.toBe(false);
    if (ciphertext.length) {
      const badBody = envelope.slice();
      badBody[0] ^= 1;
      await expect(verifyTag(hex(key), hex(iv), badBody, hex(aad))).resolves.toBe(false);
    }
    await expect(verifyTag(hex(key), hex(iv), new Uint8Array(15))).resolves.toBe(false);
    await expect(verifyTag(hex(key), new Uint8Array(11), envelope)).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
    block.mockRestore();
  }
});
