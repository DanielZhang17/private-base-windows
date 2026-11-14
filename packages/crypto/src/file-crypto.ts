import { randomBytes, toBase64Url, fromBase64Url } from "./utils.js";
import * as aesGcm from "./aes-gcm.js";
import { CHUNK_SIZE } from "@e2ee-chat/shared";

export interface FileEncryptionKey {
  key: string; // Base64url AES-256 key
  iv: string; // Base64url base IV
}

export function generateFileKey(): FileEncryptionKey {
  return {
    key: toBase64Url(randomBytes(32)),
    iv: toBase64Url(randomBytes(12)),
  };
}

function deriveChunkIV(baseIV: Uint8Array, chunkIndex: number): Uint8Array {
  const iv = new Uint8Array(baseIV);
  // XOR the last 4 bytes with the chunk index
  const view = new DataView(iv.buffer, iv.byteOffset, iv.byteLength);
  view.setUint32(8, view.getUint32(8) ^ chunkIndex);
  return iv;
}

export async function encryptFile(
  data: Uint8Array,
  fileKey: FileEncryptionKey,
): Promise<Uint8Array> {
  const key = fromBase64Url(fileKey.key);
  const baseIV = fromBase64Url(fileKey.iv);

  const chunks: Uint8Array[] = [];
  const numChunks = Math.ceil(data.length / CHUNK_SIZE);

  // Write number of chunks as first 4 bytes
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, numChunks);
  chunks.push(header);

  for (let i = 0; i < numChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, data.length);
    const chunk = data.slice(start, end);
    const iv = deriveChunkIV(baseIV, i);
    const encrypted = await aesGcm.encrypt(key, iv, chunk);

    // Write chunk length (4 bytes) + encrypted chunk
    const lengthHeader = new Uint8Array(4);
    new DataView(lengthHeader.buffer).setUint32(0, encrypted.length);
    chunks.push(lengthHeader);
    chunks.push(encrypted);
  }

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function decryptFile(
  data: Uint8Array,
  fileKey: FileEncryptionKey,
): Promise<Uint8Array> {
  const key = fromBase64Url(fileKey.key);
  const baseIV = fromBase64Url(fileKey.iv);

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numChunks = view.getUint32(0);
  let offset = 4;

  const decryptedChunks: Uint8Array[] = [];

  for (let i = 0; i < numChunks; i++) {
    const chunkLength = view.getUint32(offset);
    offset += 4;
    const encryptedChunk = data.slice(offset, offset + chunkLength);
    offset += chunkLength;

    const iv = deriveChunkIV(baseIV, i);
    const decrypted = await aesGcm.decrypt(key, iv, encryptedChunk);
    decryptedChunks.push(decrypted);
  }

  const totalLength = decryptedChunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let resultOffset = 0;
  for (const chunk of decryptedChunks) {
    result.set(chunk, resultOffset);
    resultOffset += chunk.length;
  }
  return result;
}
