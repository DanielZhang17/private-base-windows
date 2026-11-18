import { aesDecrypt, aesEncrypt, concat, generateIV } from "@e2ee-chat/crypto";

// Leave room for framing and the GCM tag within a 64 KiB SCTP message.
export const TRANSFER_CHUNK_BYTES = 60 * 1024;
const HEADER_BYTES = 5;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const kinds = ["confirm", "data", "ack", "finish", "receipt", "proof", "resume", "resume-end", "probe", "probe-ack", "storage", "receipt-part", "space", "space-result", "multipart-ack"] as const;
type RecordKind = typeof kinds[number];
const empty = new Uint8Array();
const hasPayload = (kind: RecordKind) => ["data", "resume", "probe", "receipt-part", "space", "space-result"].includes(kind);

export async function sealTransferRecord(key: Uint8Array, kind: RecordKind, index: number, payload: Uint8Array = empty): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff
    || (hasPayload(kind) ? payload.length === 0 || payload.length > TRANSFER_CHUNK_BYTES : payload.length !== 0)) {
    throw new Error("Invalid transfer record");
  }
  const header = Uint8Array.of(kinds.indexOf(kind), 0, 0, 0, 0);
  new DataView(header.buffer).setUint32(1, index);
  const iv = generateIV();
  return new Uint8Array(concat(header, iv, await aesEncrypt(key, iv, payload, header)));
}

export async function openTransferRecord(key: Uint8Array, wire: ArrayBuffer): Promise<{ kind: RecordKind; index: number; payload: Uint8Array }> {
  const bytes = new Uint8Array(wire);
  const kind = kinds[bytes[0]];
  const overhead = HEADER_BYTES + IV_BYTES + TAG_BYTES;
  if (!kind || bytes.length < overhead
    || (hasPayload(kind) ? bytes.length === overhead || bytes.length > overhead + TRANSFER_CHUNK_BYTES : bytes.length !== overhead)) {
    throw new Error("Invalid transfer record");
  }
  const payload = await aesDecrypt(key, bytes.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES),
    bytes.subarray(HEADER_BYTES + IV_BYTES), bytes.subarray(0, HEADER_BYTES));
  return { kind, index: new DataView(wire).getUint32(1), payload };
}

/** The receiver is authoritative about the next record after a reconnect. */
export class TransferSendWindow {
  sent: number;
  acknowledged: number;

  constructor(readonly total: number, resumeAt: number, readonly capacity = 16) {
    if (!Number.isInteger(resumeAt) || resumeAt < 0 || resumeAt > total) throw new Error("Invalid resume position");
    this.sent = this.acknowledged = resumeAt;
  }

  get canSend(): boolean { return this.sent < Math.min(this.total, this.acknowledged + this.capacity); }

  acknowledge(next: number): void {
    if (next < this.acknowledged || next > this.sent) throw new Error("Invalid transfer acknowledgement");
    this.acknowledged = next;
  }
}
