import { HISTORY_TRANSFER_SPACE_BATCH_ATTACHMENT_BYTES, HISTORY_TRANSFER_SPACE_BATCH_ITEMS, historyTransferCheckpointSchema, historyTransferSpaceItemsSchema, historyTransferSpaceResultSchema, type HistoryTransferCheckpoint, type HistoryTransferManifest, type HistoryTransferSpaceItem, type HistoryTransferSpaceResult } from "@e2ee-chat/shared";
import { concat } from "@e2ee-chat/crypto";
import type { HistoryTransferItem } from "../../db/history-transfer.js";
import { historyStorageItemBytes, TransferArchiveReader, type HistoryTransferArchive } from "./archive.js";
import { openTransferRecord, sealTransferRecord, TRANSFER_CHUNK_BYTES, TransferSendWindow } from "./records.js";

export type HistoryTransferRole = "receiver" | "sender";
export interface HistoryTransferProgress {
  records: number;
  totalRecords: number;
  bytes: number;
  totalBytes: number;
}

interface Link {
  channel: RTCDataChannel;
  inbound: Uint8Array;
  outbound: Uint8Array;
  code: string;
  proofSent: boolean;
  peerProven: boolean;
  authenticating: boolean;
  confirmSent: boolean;
  peerConfirmed: boolean;
  resumeAt: number;
  window?: TransferSendWindow;
  pumping: boolean;
  pendingReads: number;
  finishSent: boolean;
  receiptSent: boolean;
  receiptParts: Uint8Array[];
  receiptBytes: number;
  multipart?: { kind: "resume" | "receipt-part"; bytes: Uint8Array; finalIndex: number; window: TransferSendWindow; pumping: boolean };
  resumeSent: boolean;
  resumeReceived: boolean;
  resumeParts: Uint8Array[];
  resumeBytes: number;
  probeIndex: number;
  probeStarted?: number;
  probeWindow?: TransferSendWindow;
  probing?: boolean;
}

const BUFFER_LIMIT = 8 * TRANSFER_CHUNK_BYTES;
const PROBE_BYTES = 2 * 1024 * 1024;
const PROBE_RECORDS = Math.ceil(PROBE_BYTES / TRANSFER_CHUNK_BYTES);
const PROBE_CHUNK = new Uint8Array(TRANSFER_CHUNK_BYTES);
const CHECKPOINT_LIMIT = 4 * 1024 * 1024;

export class TransferStorageError extends Error {}
export class TransferArchiveChangedError extends Error {}
export interface TransferDeviceCapacity { free?: number; cellular: boolean; wifiHint?: boolean }
export function onCellularData(): boolean {
  return (navigator as Navigator & { connection?: { type?: string } }).connection?.type === "cellular";
}
export function wifiHintOnLargeTransfer(): boolean {
  const ios = /iPhone|iPod|iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && !(navigator as Navigator & { connection?: { type?: string } }).connection?.type;
}
export async function deviceTransferCapacity(): Promise<TransferDeviceCapacity> {
  const estimate = await navigator.storage?.estimate().catch(() => undefined);
  return { free: estimate?.quota !== undefined && estimate.usage !== undefined ? Math.max(0, Math.floor(estimate.quota - estimate.usage)) : undefined,
    cellular: onCellularData(), wifiHint: wifiHintOnLargeTransfer() };
}

interface StreamCheckpoint {
  load(): Promise<HistoryTransferCheckpoint | null>;
  received(value: HistoryTransferCheckpoint | null): Promise<void>;
  manifest(value: HistoryTransferManifest): Promise<void>;
  chatComplete(id: string, bytes: number): Promise<void>;
  receipt?(): Promise<HistoryTransferCheckpoint | void>;
  receivedReceipt?(checkpoint: HistoryTransferCheckpoint): void;
  estimateStorage?(items: readonly HistoryTransferSpaceItem[]): Promise<number>;
}

export class HistoryTransferStream {
  localConfirmed = false;
  complete = false;
  private link?: Link;
  private reads = Promise.resolve();
  private archive?: HistoryTransferArchive;
  private readonly reader: TransferArchiveReader;
  private requested = false;
  private nextRecord = 0;
  private receivedBytes = 0;
  private sentAtMost = 0;
  private acknowledged = 0;
  private receivedFinish = false;
  private receivedReceipt = false;
  private receivedBegin = false;
  private receiptEvents = 0;
  peerCapacity?: TransferDeviceCapacity;
  estimatedBytesPerSecond?: number;

  constructor(
    private readonly role: HistoryTransferRole,
    importItem: (item: HistoryTransferItem) => Promise<void>,
    private readonly onChange: () => void,
    private readonly onError: (error: unknown) => void,
    private readonly onClose: () => void,
    private readonly checkpoint?: StreamCheckpoint,
  ) {
    this.reader = new TransferArchiveReader(importItem,
      async (manifest) => { await this.checkpoint?.manifest(manifest); },
      async (id, bytes) => { await this.checkpoint?.chatComplete(id, bytes); });
  }

  get peerConfirmed(): boolean { return this.link?.peerConfirmed ?? false; }
  get checkCode(): string | undefined { return this.link?.peerProven && this.link.proofSent ? this.link.code : undefined; }
  get manifest(): HistoryTransferManifest | undefined { return this.archive?.manifest ?? this.reader.manifest; }
  get confirmed(): boolean { return !!this.link?.confirmSent && this.peerConfirmed; }
  get ready(): boolean { return this.confirmed && (this.role === "receiver" || !!this.link?.resumeReceived); }
  get started(): boolean { return this.requested || this.receivedBegin; }
  get receiptActivity(): number { return this.receiptEvents; }

  private noteReceiptActivity(): void {
    this.receiptEvents++;
    this.onChange();
  }

  peerDisconnected(): void {
    if (this.role === "receiver" && this.receivedReceipt && !this.complete) {
      this.complete = true;
      this.onChange();
    }
  }

  get progress(): HistoryTransferProgress {
    const totalBytes = this.manifest?.bytes ?? 0;
    const manifestBytes = this.archive?.manifestBytes ?? this.reader.manifestBytes;
    const records = this.role === "sender" ? this.acknowledged : this.nextRecord;
    return {
      records,
      totalRecords: this.manifest ? Math.ceil((totalBytes + manifestBytes) / TRANSFER_CHUNK_BYTES) : 0,
      bytes: Math.min(totalBytes, Math.max(0, records * TRANSFER_CHUNK_BYTES - manifestBytes)),
      totalBytes,
    };
  }

  prepare(archive?: HistoryTransferArchive): void {
    if (this.role !== "sender" || this.requested) throw new Error("History transfer selection is locked");
    this.archive?.releaseAttachment();
    this.archive = archive;
    this.onChange();
  }

  private checkArchive?: () => Promise<boolean>;
  private sendingPaused = false;
  private spaceIndex = 0;
  private spaceReply?: { index: number; resolve: (result: HistoryTransferSpaceResult) => void; reject: (error: Error) => void };

  async estimateRemaining(archive: HistoryTransferArchive, checkArchive: () => Promise<boolean>): Promise<number> {
    const link = this.link;
    if (!link || !this.ready || this.requested || this.spaceReply) throw new Error("Receiver storage check is unavailable");
    const measure = async (items: readonly HistoryTransferSpaceItem[]) => {
      const index = ++this.spaceIndex;
      const pending = new Promise<HistoryTransferSpaceResult>((resolve, reject) => { this.spaceReply = { index, resolve, reject }; });
      void pending.catch(() => undefined);
      const timer = setTimeout(() => this.spaceReply?.reject(new Error("Receiver storage check timed out")), 10_000);
      try {
        if (!await this.write(link, "space", index, new TextEncoder().encode(JSON.stringify(items)), checkArchive)) throw new Error("Receiver storage check disconnected");
        const result = await pending;
        if (result.required > items.reduce((total, item) => total + historyStorageItemBytes(item), 0)) throw new Error("Invalid storage estimate");
        this.peerCapacity = { ...this.peerCapacity ?? { cellular: false }, free: result.free };
        this.onChange();
        return result;
      } finally {
        clearTimeout(timer);
        this.spaceReply = undefined;
      }
    };
    let { free } = await measure([]);
    // Wire bytes for unmeasured records, including tombstones, are advisory sizing only.
    let required = 0;
    for (let offset = 0; offset < archive.spaceItems.length && free !== undefined && required <= free && archive.storageBytes > free;) {
      const start = offset;
      let attachmentBytes = 0;
      while (offset < archive.spaceItems.length && offset - start < HISTORY_TRANSFER_SPACE_BATCH_ITEMS) {
        const item = archive.spaceItems[offset];
        if (item.kind === "message") attachmentBytes += item.attachment?.bytes ?? 0;
        if (attachmentBytes > HISTORY_TRANSFER_SPACE_BATCH_ATTACHMENT_BYTES) break;
        offset++;
      }
      if (offset === start) throw new Error("Transfer attachment is too large to check");
      const next = await measure(archive.spaceItems.slice(start, offset));
      required += next.required;
      free = next.free;
    }
    if (!await checkArchive()) throw new TransferArchiveChangedError("History changed during storage check");
    if (free === undefined || archive.storageBytes <= free) return archive.storageBytes;
    return required;
  }

  setSendingPaused(paused: boolean): void {
    this.sendingPaused = paused;
    if (!paused && this.link) this.pump(this.link);
  }

  send(finalize = false, checkArchive?: () => Promise<boolean>): void {
    if (this.role !== "sender" || !this.archive || (!finalize && !this.archive.manifest.chats.length) || !this.ready || this.requested) {
      throw new Error("History transfer is not ready");
    }
    this.checkArchive = checkArchive;
    this.requested = true;
    this.onChange();
    if (this.link) this.pump(this.link);
  }

  confirm(): void {
    if (!this.checkCode) throw new Error("The other device has not proven its pairing key");
    this.localConfirmed = true;
    if (this.link) this.kick(this.link);
    this.onChange();
  }

  attach(channel: RTCDataChannel, inbound: Uint8Array, outbound: Uint8Array, code: string): void {
    this.detach();
    const link: Link = {
      channel, inbound, outbound, code, proofSent: false, peerProven: false, authenticating: false,
      confirmSent: false, peerConfirmed: false, resumeSent: false, resumeReceived: false, resumeParts: [], resumeBytes: 0,
      resumeAt: 0, pumping: false, pendingReads: 0, finishSent: false, receiptSent: false, receiptParts: [], receiptBytes: 0, probeIndex: 0,
    };
    this.link = link;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;
    channel.onopen = () => this.kick(link);
    channel.onbufferedamountlow = () => { this.pumpProbe(link); this.pump(link); this.pumpMultipart(link); };
    channel.onclose = () => { if (this.link === link) this.onClose(); };
    channel.onerror = channel.onclose;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (this.link !== link) return;
      if (!(event.data instanceof ArrayBuffer) || ++link.pendingReads > 32) {
        this.onError(new Error("Invalid data channel frame"));
        return;
      }
      const wire = event.data;
      this.reads = this.reads.then(async () => {
        if (this.link === link) await this.receive(link, wire);
      }).catch((error: unknown) => {
        if (this.link === link) this.onError(error);
      }).finally(() => { link.pendingReads--; });
    };
    this.kick(link);
  }

  detach(): void {
    this.spaceReply?.reject(new Error("Receiver storage check disconnected"));
    const link = this.link;
    if (!link) return;
    this.link = undefined;
    this.archive?.releaseAttachment();
    link.channel.onopen = link.channel.onmessage = link.channel.onclose = link.channel.onerror = link.channel.onbufferedamountlow = null;
    link.channel.close();
    link.inbound.fill(0);
    link.outbound.fill(0);
  }

  dispose(): void {
    this.detach();
    this.archive?.releaseAttachment();
    this.archive = undefined;
    this.checkArchive = undefined;
    this.reader.dispose();
  }

  private open(link: Link): boolean {
    return link === this.link && link.channel.readyState === "open";
  }

  private kick(link: Link): void {
    if (!this.open(link) || link.authenticating) return;
    link.authenticating = true;
    // Finish an already authenticated record from a dropped connection before
    // advertising a resume index. It may still be committing to IndexedDB.
    void this.reads.then(async () => {
      if (!this.open(link)) return;
      if (!link.proofSent) {
        if (!await this.write(link, "proof", 0)) return;
        link.proofSent = true;
        this.onChange();
      }
      if (this.localConfirmed && link.peerProven && !link.confirmSent) {
        const index = this.role === "receiver" ? this.nextRecord : 0;
        if (!await this.write(link, "confirm", index)) return;
        link.confirmSent = true;
        this.onChange();
      }
      if (this.confirmed && this.role === "receiver" && !link.resumeSent && !link.multipart) {
        const checkpoint = await this.checkpoint?.load() ?? null;
        const value = new TextEncoder().encode(JSON.stringify({ checkpoint, capacity: await deviceTransferCapacity() }));
        this.startMultipart(link, "resume", value, value.length);
      }
      this.pump(link);
    }).catch((error: unknown) => { if (this.open(link)) this.onError(error); }).finally(() => {
      link.authenticating = false;
      if (this.open(link) && ((this.localConfirmed && link.peerProven && !link.confirmSent)
        || (this.role === "receiver" && this.confirmed && !link.resumeSent && !link.multipart))) this.kick(link);
    });
  }

  private async write(link: Link, kind: Parameters<typeof sealTransferRecord>[1], index: number, payload?: Uint8Array,
    checkSpaceArchive?: () => Promise<boolean>): Promise<boolean> {
    if (!this.open(link) || (kind === "data" && this.sendingPaused)) return false;
    const record = await sealTransferRecord(link.outbound, kind, index, payload);
    // Reading or sealing a record can yield long enough for a removal or expiry.
    if (kind === "data" && this.checkArchive && !await this.checkArchive()) return false;
    if (checkSpaceArchive && !await checkSpaceArchive()) throw new TransferArchiveChangedError("History changed during storage check");
    if (!this.open(link) || (kind === "data" && this.sendingPaused)) return false;
    link.channel.send(record);
    return true;
  }

  private async receive(link: Link, wire: ArrayBuffer): Promise<void> {
    const { kind, index, payload } = await openTransferRecord(link.inbound, wire);
    if (!this.open(link)) return;
    if (kind === "proof" && !link.peerProven && index === 0) {
      link.peerProven = true;
      this.onChange();
      this.kick(link);
      return;
    }
    if (kind === "confirm") {
      if (!link.peerProven || link.peerConfirmed || (this.role === "receiver" ? index !== 0 : index > this.sentAtMost || index < this.acknowledged)) {
        throw new Error("Invalid transfer confirmation");
      }
      link.peerConfirmed = true;
      link.resumeAt = index;
      this.onChange();
      this.kick(link);
      return;
    }
    if (!this.confirmed) throw new Error("History transfer has not been confirmed");
    if (kind === "multipart-ack" && this.role === "receiver" && link.multipart) {
      const { window, kind } = link.multipart;
      if (index !== window.acknowledged + 1) throw new Error("Invalid multipart acknowledgment");
      window.acknowledge(index);
      if (kind === "receipt-part") this.noteReceiptActivity();
      this.pumpMultipart(link);
      return;
    }
    if (kind === "space" && this.role === "receiver" && !this.started && this.checkpoint?.estimateStorage) {
      const items = historyTransferSpaceItemsSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
      const required = items.length ? await this.checkpoint.estimateStorage(items) : 0;
      const { free } = await deviceTransferCapacity();
      await this.write(link, "space-result", index, new TextEncoder().encode(JSON.stringify({ required, free })));
      return;
    }
    if (kind === "space-result" && this.role === "sender") {
      if (index !== this.spaceReply?.index) return;
      this.spaceReply.resolve(historyTransferSpaceResultSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload))));
      return;
    }
    if (this.role === "sender" && !link.resumeReceived && index === link.resumeBytes) {
      if (kind === "resume" && index + payload.length <= CHECKPOINT_LIMIT) {
        link.resumeParts.push(payload);
        link.resumeBytes += payload.length;
        await this.write(link, "multipart-ack", Math.ceil(link.resumeBytes / TRANSFER_CHUNK_BYTES));
        return;
      }
      if (kind === "resume-end") {
        const value: unknown = JSON.parse(new TextDecoder().decode(concat(...link.resumeParts)));
        link.resumeParts = [];
        const envelope = value && typeof value === "object" && "checkpoint" in value ? value : { checkpoint: value };
        const checkpoint = historyTransferCheckpointSchema.nullable().parse(envelope.checkpoint);
        const capacity = "capacity" in envelope ? envelope.capacity as Partial<TransferDeviceCapacity> | undefined : undefined;
        if (capacity) this.peerCapacity = { cellular: capacity.cellular === true, wifiHint: capacity.wifiHint === true,
          free: typeof capacity.free === "number" && Number.isSafeInteger(capacity.free) && capacity.free >= 0 ? capacity.free : undefined };
        if (!this.requested) await this.checkpoint?.received(checkpoint);
        if (!this.open(link)) return;
        link.resumeReceived = true;
        this.onChange();
        if (this.checkpoint && !this.requested && this.estimatedBytesPerSecond === undefined) {
          link.probeStarted = performance.now();
          link.probeWindow = new TransferSendWindow(PROBE_RECORDS, 0);
          this.pumpProbe(link);
        }
        this.pump(link);
        return;
      }
    }
    if (this.role === "receiver" && kind === "probe" && this.checkpoint
      && index === link.probeIndex && index < PROBE_RECORDS) {
      link.probeIndex++;
      await this.write(link, "probe-ack", index);
      return;
    }
    if (this.role === "sender" && kind === "probe-ack" && link.probeStarted !== undefined && link.probeWindow
      && index === link.probeWindow.acknowledged) {
      link.probeWindow.acknowledge(index + 1);
      if (link.probeWindow.acknowledged === PROBE_RECORDS) {
        this.estimatedBytesPerSecond = PROBE_BYTES * 1000 / Math.max(1, performance.now() - link.probeStarted);
        this.onChange();
      } else this.pumpProbe(link);
      return;
    }
    if (kind === "storage" && this.role === "sender" && this.started) throw new TransferStorageError("Receiver ran out of storage");
    if (this.role === "receiver") {
      if (kind === "data" && !this.receivedFinish && index === this.nextRecord && this.receivedBytes === index * TRANSFER_CHUNK_BYTES) {
        if (!this.receivedBegin) {
          this.receivedBegin = true;
          this.onChange();
        }
        try {
          await this.reader.write(payload);
        } catch (error) {
          // A record already accepted for import can fail after the transport drops.
          if ((error as { name?: string })?.name === "QuotaExceededError") {
            try { if (await this.write(link, "storage", this.nextRecord)) await this.drain(link); }
            finally { this.onError(new TransferStorageError("Receiver ran out of storage")); }
          } else this.onError(error);
          return;
        }
        this.receivedBytes += payload.length;
        this.nextRecord++;
        if (this.manifest && this.receivedBytes > this.manifest.bytes + this.reader.manifestBytes) throw new Error("Transfer exceeds manifest size");
        this.onChange();
        await this.write(link, "ack", this.nextRecord);
        return;
      }
      if (kind === "finish" && index === this.nextRecord) {
        this.reader.finish();
        this.receivedFinish = true;
        await this.write(link, "finish", index);
        return;
      }
      if (kind === "receipt" && this.receivedFinish && index === this.nextRecord && !link.multipart) {
        // Keep the link open until the sender processes this acknowledgment.
        const receipt = await this.checkpoint?.receipt?.();
        const bytes = receipt ? new TextEncoder().encode(JSON.stringify(receipt)) : new Uint8Array();
        this.startMultipart(link, "receipt-part", bytes, index);
        return;
      }
    } else if (link.window) {
      if (kind === "ack") {
        link.window.acknowledge(index);
        this.acknowledged = index;
        this.onChange();
        this.pump(link);
        return;
      }
      if (kind === "finish" && link.finishSent && index === link.window.total) {
        link.receiptSent = await this.write(link, "receipt", index);
        return;
      }
      if (kind === "receipt-part" && link.receiptSent && index === link.receiptBytes && index + payload.length <= CHECKPOINT_LIMIT) {
        link.receiptParts.push(payload);
        link.receiptBytes += payload.length;
        this.noteReceiptActivity();
        if (await this.write(link, "multipart-ack", Math.ceil(link.receiptBytes / TRANSFER_CHUNK_BYTES))) this.noteReceiptActivity();
        return;
      }
      if (kind === "receipt" && link.receiptSent && index === link.window.total) {
        if (this.checkpoint?.receivedReceipt && !link.receiptBytes) throw new Error("Missing history transfer receipt");
        if (link.receiptBytes) {
          const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(concat(...link.receiptParts)));
          this.checkpoint?.receivedReceipt?.(historyTransferCheckpointSchema.parse(value));
        }
        this.complete = true;
        this.onChange();
        return;
      }
    }
    throw new Error("Unexpected transfer record");
  }

  private startMultipart(link: Link, kind: "resume" | "receipt-part", bytes: Uint8Array, finalIndex: number): void {
    if (bytes.length > CHECKPOINT_LIMIT) throw new Error("Transfer checkpoint or receipt is too large");
    link.multipart = { kind, bytes, finalIndex, pumping: false, window: new TransferSendWindow(Math.ceil(bytes.length / TRANSFER_CHUNK_BYTES), 0, 8) };
    this.pumpMultipart(link);
  }

  private pumpMultipart(link: Link): void {
    const send = link.multipart;
    if (!send || send.pumping || !this.open(link)) return;
    send.pumping = true;
    const { window, bytes, kind, finalIndex } = send;
    void (async () => {
      try {
        while (this.open(link) && window.canSend && link.channel.bufferedAmount < BUFFER_LIMIT) {
          const offset = window.sent * TRANSFER_CHUNK_BYTES;
          if (!await this.write(link, kind, offset, bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES))) return;
          window.sent++;
          if (kind === "receipt-part") this.noteReceiptActivity();
        }
        if (window.acknowledged === window.total) {
          const sent = await this.write(link, kind === "resume" ? "resume-end" : "receipt", finalIndex);
          if (kind === "resume") link.resumeSent = sent;
          else if (sent) this.receivedReceipt = true;
          link.multipart = undefined;
        }
      } catch (error) {
        if (this.open(link)) this.onError(error);
      } finally { send.pumping = false; }
    })();
  }

  private async drain(link: Link): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (this.open(link) && link.channel.bufferedAmount && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private pumpProbe(link: Link): void {
    const window = link.probeWindow;
    if (!window || link.probing || this.requested || !this.open(link)) return;
    link.probing = true;
    void (async () => {
      try {
        while (!this.requested && this.open(link) && window.canSend && link.channel.bufferedAmount < BUFFER_LIMIT) {
          const length = Math.min(TRANSFER_CHUNK_BYTES, PROBE_BYTES - window.sent * TRANSFER_CHUNK_BYTES);
          if (!await this.write(link, "probe", window.sent, PROBE_CHUNK.subarray(0, length))) return;
          window.sent++;
        }
      } catch (error) {
        if (this.open(link)) this.onError(error);
      } finally { link.probing = false; }
    })();
  }

  private pump(link: Link): void {
    const archive = this.archive;
    if (!this.open(link) || !this.ready || !archive || !this.requested || this.sendingPaused || link.pumping) return;
    link.pumping = true;
    void (async () => {
      try {
        if (this.checkArchive && (!await this.checkArchive() || !this.open(link))) return;
        const window = link.window ??= new TransferSendWindow(Math.ceil(archive.size / TRANSFER_CHUNK_BYTES), link.resumeAt);
        this.acknowledged = window.acknowledged;
        this.onChange();
        while (this.open(link) && window.canSend && link.channel.bufferedAmount < BUFFER_LIMIT) {
          const offset = window.sent * TRANSFER_CHUNK_BYTES;
          const bytes = await archive.read(offset, TRANSFER_CHUNK_BYTES);
          if (!await this.write(link, "data", window.sent, bytes)) return;
          window.sent++;
          this.sentAtMost = Math.max(this.sentAtMost, window.sent);
        }
        if (!link.finishSent && window.acknowledged === window.total && this.open(link)) {
          link.finishSent = await this.write(link, "finish", window.total);
        }
      } catch (error) {
        if (this.open(link)) this.onError(error);
      } finally {
        link.pumping = false;
      }
    })();
  }
}
