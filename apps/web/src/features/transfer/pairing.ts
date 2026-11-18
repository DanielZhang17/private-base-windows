import { fromBase64Url, randomBytes, toBase64Url } from "@e2ee-chat/crypto";
import { HISTORY_TRANSFER_VERSION, historyTransferQrSchema, type HistoryTransferQr } from "@e2ee-chat/shared";

export function transferVersionError(peerVersion?: number): "version" | "version-local" {
  return typeof peerVersion === "number" && peerVersion > HISTORY_TRANSFER_VERSION ? "version-local" : "version";
}

export class UnsupportedTransferVersion extends Error {
  constructor(readonly peerVersion?: number) { super("Unsupported transfer version"); }
}

// Each compound word represents 11 bits. The eight words encode an 88-bit
// random secret; only a domain-separated hash of it is used as a routing ID.
const prefixes = [
  "amber", "blue", "calm", "dawn", "east", "fair", "glad", "high",
  "ivory", "jade", "kind", "light", "mild", "north", "olive", "pale",
  "quick", "red", "soft", "tall", "urban", "vast", "warm", "young",
  "zesty", "bright", "clear", "deep", "fresh", "gold", "quiet", "silver",
];
const suffixes = [
  "acorn", "apple", "arch", "ash", "bay", "beach", "bear", "bee",
  "birch", "bird", "bloom", "brook", "cairn", "cedar", "cliff", "cloud",
  "coral", "creek", "deer", "dune", "elm", "fern", "field", "finch",
  "fir", "flame", "flock", "fox", "frost", "garden", "glade", "glen",
  "grove", "harbor", "hawk", "hill", "island", "lake", "lark", "leaf",
  "lime", "maple", "marsh", "mist", "moon", "moss", "oak", "ocean",
  "orchid", "otter", "owl", "pearl", "pine", "pond", "rain", "reed",
  "reef", "ridge", "river", "rose", "sand", "shore", "star", "stone",
];
const words = prefixes.flatMap((prefix) => suffixes.map((suffix) => prefix + suffix));
const wordIndex = new Map(words.map((word, index) => [word, index]));

function canonicalBytes(value: string, size: number): Uint8Array {
  const bytes = fromBase64Url(value);
  if (bytes.length !== size || toBase64Url(bytes) !== value) throw new Error("Invalid pairing code");
  return bytes;
}

export function encodeTransferWords(transferId: string): string {
  const bits = canonicalBytes(transferId, 11).reduce((value, byte) => value << 8n | BigInt(byte), 0n);
  return Array.from({ length: 8 }, (_, index) => words[Number(bits >> BigInt((7 - index) * 11) & 2047n)]).join(" ");
}

export function inspectTransferWords(input: string) {
  const phrase = input.toLowerCase().match(/[^\s,\d.\-–—]+/gu) ?? [];
  const unknownIndex = phrase.findIndex((word) => !wordIndex.has(word));
  const unknown = phrase[unknownIndex];
  const matches = unknown && /^[a-z]+$/.test(unknown) ? words.filter((word) => word.startsWith(unknown)) : [];
  return { phrase, count: phrase.filter((word) => wordIndex.has(word)).length, unknownIndex, unknown,
    suggestion: matches.length === 1 ? matches[0] : undefined };
}

export function decodeTransferWords(input: string): string {
  const { phrase } = inspectTransferWords(input);
  if (phrase.length !== 8) throw new Error("Enter all eight pairing words");
  const bits = phrase.reduce((value, word) => {
    const index = wordIndex.get(word);
    if (index === undefined) throw new Error("Invalid pairing word");
    return value << 11n | BigInt(index);
  }, 0n);
  return toBase64Url(Uint8Array.from({ length: 11 }, (_, index) => Number(bits >> BigInt((10 - index) * 8) & 255n)));
}

export async function transferRoomId(secret: string): Promise<string> {
  // Keep the routing namespace stable so typed words can reach version negotiation.
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`history-transfer-v2:room:${secret}`))));
}

export function createTransferPairing(receiverDeviceId: string): HistoryTransferQr {
  return { v: HISTORY_TRANSFER_VERSION, secret: toBase64Url(randomBytes(11)), receiverDeviceId };
}

export function parseTransferPairing(input: HistoryTransferQr | string): {
  secret: string;
  qr?: HistoryTransferQr;
} {
  if (typeof input === "string" && !input.trimStart().startsWith("{")) {
    return { secret: decodeTransferWords(input) };
  }
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (value && typeof value === "object" && "receiverDeviceId" in value && typeof value.receiverDeviceId === "string"
    && (("secret" in value && typeof value.secret === "string") || ("transferId" in value && typeof value.transferId === "string"))
    && (!("v" in value) || value.v !== HISTORY_TRANSFER_VERSION)) {
    throw new UnsupportedTransferVersion("v" in value && typeof value.v === "number" ? value.v : undefined);
  }
  const qr = historyTransferQrSchema.parse(value);
  canonicalBytes(qr.secret, 11);
  return { secret: qr.secret, qr };
}
