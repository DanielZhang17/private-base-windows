import sodium from "libsodium-wrappers-sumo";

let _ready = false;

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return binary;
}

function binaryToBytes(binary: string): Uint8Array {
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    return btoa(bytesToBinary(bytes));
  }
  throw new Error("No base64 encoder available");
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    return binaryToBytes(atob(value));
  }
  throw new Error("No base64 decoder available");
}

export async function ensureSodium(): Promise<typeof sodium> {
  if (!_ready) {
    await sodium.ready;
    _ready = true;
  }
  return sodium;
}

export function toBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function fromBase64Url(str: string): Uint8Array {
  const normalized = str
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = normalized.length % 4;
  return decodeBase64(
    padding === 0 ? normalized : normalized + "=".repeat(4 - padding),
  );
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}

export function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
