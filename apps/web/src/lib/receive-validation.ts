import { fromBase64Url, toBase64Url } from "@e2ee-chat/crypto";
import type { InitialMessageHeader, RatchetHeader, SenderKeyHeader, SystemCallPayload } from "@e2ee-chat/shared";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function bytes(value: unknown, length: number): value is string {
  if (!text(value) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = fromBase64Url(value);
    return decoded.length === length && toBase64Url(decoded) === value;
  } catch { return false; }
}

export function parseDirectHeader(json: string): RatchetHeader & { recipientDeviceId: string; initial?: InitialMessageHeader } {
  const header: unknown = JSON.parse(json);
  if (!record(header) || !bytes(header.dhPublicKey, 32) || !count(header.n) || !count(header.pn) || !text(header.recipientDeviceId)) {
    throw new TypeError("Invalid direct header");
  }
  if (header.initial !== undefined) {
    const initial = header.initial;
    if (!record(initial) || !bytes(initial.identityKey, 32) || !bytes(initial.ephemeralKey, 32)
      || !count(initial.signedPreKeyId) || (initial.oneTimePreKeyId !== undefined && !count(initial.oneTimePreKeyId))) {
      throw new TypeError("Invalid initial header");
    }
  }
  return header as unknown as ReturnType<typeof parseDirectHeader>;
}

export function parseGroupHeader(json: string): SenderKeyHeader {
  const header: unknown = JSON.parse(json);
  if (!record(header) || !count(header.senderKeyId) || header.senderKeyId > 0xffffffff
    || !count(header.chainIndex) || !bytes(header.signature, 64)) throw new TypeError("Invalid group header");
  return header as unknown as SenderKeyHeader;
}

export function parseCallOffer(content: string, conversationId: string): SystemCallPayload {
  const payload: unknown = JSON.parse(content);
  if (!record(payload) || payload.kind !== "call_offer" || !text(payload.callId)
    || payload.conversationId !== conversationId || !text(payload.initiatorId)
    || (payload.callType !== "audio" && payload.callType !== "video") || !bytes(payload.callKey, 32)
    || !count(payload.createdAt) || !count(payload.expiresAt) || payload.expiresAt <= payload.createdAt) {
    throw new TypeError("Invalid system payload");
  }
  return payload as unknown as SystemCallPayload;
}

export function validateFilePayload(content: string): void {
  const payload: unknown = JSON.parse(content);
  if (!record(payload) || !text(payload.fileId) || !text(payload.fileName) || !text(payload.mimeType)
    || !bytes(payload.fileKey, 32) || !bytes(payload.iv ?? payload.fileIv, 12)
    || (payload.size !== undefined && !count(payload.size)) || (payload.sizeBytes !== undefined && !count(payload.sizeBytes))) {
    throw new TypeError("Invalid file payload");
  }
}
