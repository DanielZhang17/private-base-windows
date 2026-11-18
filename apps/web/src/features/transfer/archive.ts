import {
  MAX_FILE_SIZE,
  HISTORY_TRANSFER_VERSION,
  historyTransferEntrySchema,
  historyTransferManifestSchema,
  type HistoryTransferManifest,
  type HistoryTransferStickerPreferences,
  type HistoryTransferSpaceItem,
} from "@e2ee-chat/shared";
import type { HistoryTransferAttachmentSource, HistoryTransferItem } from "../../db/history-transfer.js";
import { estimateHistoryTransferCheckpointBytes } from "../../db/history-transfer-progress.js";
import { historyConversationKey } from "../../db/index.js";
import { TRANSFER_CHUNK_BYTES } from "./records.js";

const HEADER_BYTES = 8;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

function encodeItem(value: unknown, fileSize = 0): Blob {
  const json = new TextEncoder().encode(JSON.stringify(value));
  if (json.length > MAX_JSON_BYTES || fileSize > MAX_FILE_SIZE) throw new Error("Transfer item is too large");
  const header = new DataView(new ArrayBuffer(HEADER_BYTES));
  header.setUint32(0, json.length);
  header.setUint32(4, fileSize);
  return new Blob([header.buffer, json]);
}

export interface HistoryTransferArchive {
  manifest: HistoryTransferManifest;
  manifestBytes: number;
  size: number;
  storageBytes: number;
  spaceItems: HistoryTransferSpaceItem[];
  read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>;
  releaseAttachment(): void;
}

type ArchivePart = Blob | HistoryTransferAttachmentSource;

/** Open only the attachment at the current byte offset. Serialize old and new link readers on reconnect. */
function archiveBytes(parts: ArchivePart[]): Pick<HistoryTransferArchive, "size" | "read" | "releaseAttachment"> {
  let size = 0;
  const ends = parts.map((part) => size += part.size);
  let opened: { index: number; blob: Blob } | undefined;
  let generation = 0;
  let tail = Promise.resolve();
  return {
    size,
    releaseAttachment() { generation++; opened = undefined; },
    read(offset, length) {
      const current = generation;
      const operation = tail.then(async () => {
        const limit = Math.min(offset + length, size);
        const slices: Blob[] = [];
        let lower = 0, upper = ends.length;
        while (lower < upper) {
          const index = Math.floor((lower + upper) / 2);
          if (ends[index] <= offset) lower = index + 1;
          else upper = index;
        }
        for (let index = lower; offset < limit; index++) {
          if (current !== generation) throw new Error("Archive reader was superseded");
          const part = parts[index];
          if (part.size === 0) continue;
          const start = ends[index] - part.size;
          const end = Math.min(ends[index], limit);
          let blob: Blob;
          if ("open" in part) {
            if (opened?.index !== index) {
              opened = undefined;
              const next = await part.open();
              if (current !== generation) throw new Error("Archive reader was superseded");
              if (next.size !== part.size) throw new Error("Cached attachment size changed");
              opened = { index, blob: next };
            }
            blob = opened.blob;
          } else {
            opened = undefined;
            blob = part;
          }
          // Materialize only the record slice, so crossing a boundary releases the prior large blob.
          slices.push(new Blob([await blob.slice(offset - start, end - start).arrayBuffer()]));
          if (end === ends[index]) opened = undefined;
          offset = end;
        }
        return new Uint8Array(await new Blob(slices).arrayBuffer());
      });
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}

function itemChatId({ entry }: HistoryTransferItem): string {
  return entry.kind === "conversation" ? entry.conversation.id : entry.kind === "message" ? entry.message.conversationId : entry.conversationId;
}

export function buildTransferArchive(items: HistoryTransferItem[], userId: string, copyDownloadedFiles = false,
  skippedLegacy: ReadonlyMap<string, number> = new Map(), missingFiles: ReadonlyMap<string, string[]> = new Map(), resumeId?: string,
  stickers?: HistoryTransferStickerPreferences, devices?: { receiver: string; sender: string }): HistoryTransferArchive {
  const chats = new Map<string, HistoryTransferManifest["chats"][number]>();
  const parts = new Map<string, ArchivePart[]>();
  const spaceItems: HistoryTransferSpaceItem[] = [];
  const direct = new Set<string>();
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const item of items) {
    const { entry } = item;
    const attachment = item.attachmentSource ?? item.blob;
    if (entry.kind === "conversation") {
      const { id, name, members } = entry.conversation;
      const label = name ?? members.filter((member) => member.userId !== userId)
        .map((member) => member.user.displayName).join(", ");
      const skippedLegacyMessages = skippedLegacy.get(id);
      chats.set(id, { id, name: label || null, messages: 0, bytes: 0, attachmentBytes: 0,
        ...(skippedLegacyMessages ? { skippedLegacyMessages } : {}),
        ...(missingFiles.has(id) ? { missingFiles: missingFiles.get(id) } : {}) });
      parts.set(id, []);
      if (entry.conversation.type === "direct") direct.add(id);
      const snapshot = { id: historyConversationKey(userId, id), userId, conversation: entry.conversation, importedAt: Date.now() };
      spaceItems.push({ kind: "conversation", conversationId: id, updatedAt: entry.conversation.updatedAt,
        bytes: encoder.encode(JSON.stringify(snapshot)).byteLength, checkpointBytes: 0 });
    }
    const chatId = itemChatId(item);
    const chat = chats.get(chatId);
    if (!chat) throw new Error("Transfer chat is missing");
    const attachmentBytes = attachment?.size ?? 0;
    const part = encodeItem(entry, attachmentBytes);
    bytes += part.size + attachmentBytes;
    chat.bytes += part.size + attachmentBytes;
    chat.attachmentBytes += attachmentBytes;
    if (attachment) chat.attachmentFiles = (chat.attachmentFiles ?? 0) + 1;
    if (entry.kind === "message") {
      chat.messages++;
      if (entry.message.deletedAt == null) spaceItems.push({ kind: "message", conversationId: chatId, id: entry.message.id, senderId: entry.message.senderId,
        direct: direct.has(chatId), bytes: part.size, editedAt: entry.message.editedAt,
        ...(entry.attachment ? { attachment: { id: entry.attachment.id, bytes: attachmentBytes } } : {}) });
    }
    parts.get(chatId)!.push(part);
    if (attachment) parts.get(chatId)!.push(attachment);
  }
  const manifest: HistoryTransferManifest = { v: HISTORY_TRANSFER_VERSION, bytes, copyDownloadedFiles, chats: [...chats.values()],
    ...(resumeId ? { resumeId } : {}), ...(stickers ? { stickers } : {}) };
  const checkpointBytes = estimateHistoryTransferCheckpointBytes({ userId, deviceId: devices?.receiver ?? "receiver", role: "receiver" }, devices?.sender ?? "sender", manifest);
  let storageBytes = 0;
  for (const item of spaceItems) {
    if (item.kind === "conversation") item.checkpointBytes = checkpointBytes.get(item.conversationId)!;
    storageBytes += historyStorageItemBytes(item);
  }
  const manifestBlob = encodeItem(manifest);
  const source = archiveBytes([manifestBlob, ...[...parts.values()].flat()]);
  if (Math.ceil(source.size / TRANSFER_CHUNK_BYTES) > 0xffffffff) throw new Error("History transfer is too large");
  return { manifest, manifestBytes: manifestBlob.size, spaceItems, storageBytes, ...source };
}

export function historyStorageItemBytes(item: HistoryTransferSpaceItem): number {
  return item.bytes + (item.kind === "conversation" ? item.checkpointBytes : item.attachment?.bytes ?? 0);
}

/** Retains only the current item, even when the archive contains multiple large files. */
export class TransferArchiveReader {
  manifest?: HistoryTransferManifest;
  manifestBytes = 0;
  bytes = 0;
  private header = new Uint8Array(HEADER_BYTES);
  private headerUsed = 0;
  private json = new Uint8Array(0);
  private jsonUsed = 0;
  private fileSize = 0;
  private fileUsed = 0;
  private fileParts: Uint8Array<ArrayBuffer>[] = [];
  private chats = new Map<string, HistoryTransferManifest["chats"][number]>();
  private seenChats = new Set<string>();

  constructor(
    private readonly onItem: (item: HistoryTransferItem) => Promise<void>,
    private readonly onManifest: (manifest: HistoryTransferManifest) => Promise<void>,
    private readonly onChatComplete: (id: string, bytes: number) => Promise<void>,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.headerUsed < HEADER_BYTES) {
        const size = Math.min(HEADER_BYTES - this.headerUsed, chunk.length - offset);
        this.header.set(chunk.subarray(offset, offset + size), this.headerUsed);
        offset += size;
        this.headerUsed += size;
        if (this.headerUsed < HEADER_BYTES) break;
        const header = new DataView(this.header.buffer);
        const jsonSize = header.getUint32(0);
        this.fileSize = header.getUint32(4);
        if (jsonSize === 0 || jsonSize > MAX_JSON_BYTES || this.fileSize > (this.manifest ? MAX_FILE_SIZE : 0)
          || (this.manifest && HEADER_BYTES + jsonSize + this.fileSize > this.manifest.bytes - this.bytes)) {
          throw new Error("Invalid transfer item size");
        }
        this.json = new Uint8Array(jsonSize);
      }
      const jsonSize = Math.min(this.json.length - this.jsonUsed, chunk.length - offset);
      this.json.set(chunk.subarray(offset, offset + jsonSize), this.jsonUsed);
      offset += jsonSize;
      this.jsonUsed += jsonSize;
      if (this.jsonUsed < this.json.length) break;
      const fileSize = Math.min(this.fileSize - this.fileUsed, chunk.length - offset);
      if (fileSize) this.fileParts.push(new Uint8Array(chunk.subarray(offset, offset + fileSize)));
      offset += fileSize;
      this.fileUsed += fileSize;
      if (this.fileUsed < this.fileSize) break;
      await this.finishItem();
      this.headerUsed = this.jsonUsed = this.fileUsed = 0;
      this.fileParts = [];
    }
  }

  private async finishItem(): Promise<void> {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.json));
    const bytes = HEADER_BYTES + this.json.length + this.fileSize;
    if (!this.manifest) {
      const manifest = historyTransferManifestSchema.parse(value);
      this.chats = new Map(manifest.chats.map((chat) => [chat.id, { ...chat }]));
      if (this.chats.size !== manifest.chats.length || manifest.chats.reduce((sum, chat) => sum + chat.bytes, 0) !== manifest.bytes
        || Math.ceil((bytes + manifest.bytes) / TRANSFER_CHUNK_BYTES) > 0xffffffff) throw new Error("Invalid transfer manifest");
      this.manifestBytes = bytes;
      this.manifest = manifest;
      await this.onManifest(manifest);
      return;
    }
    const entry = historyTransferEntrySchema.parse(value);
    const chatId = itemChatId({ entry });
    const chat = this.chats.get(chatId);
    const attachments = entry.kind === "message" ? entry.attachment : undefined;
    if (!chat || chat.bytes < bytes || chat.attachmentBytes < this.fileSize
      || (attachments?.size ?? 0) !== this.fileSize || (entry.kind === "message" && chat.messages === 0)
      || (entry.kind === "conversation") === this.seenChats.has(chatId)) throw new Error("Item does not match transfer manifest");
    const blob = attachments ? new Blob(this.fileParts, { type: attachments.mimeType }) : undefined;
    await this.onItem({ entry, blob });
    if (entry.kind === "conversation") this.seenChats.add(chatId);
    chat.bytes -= bytes;
    chat.attachmentBytes -= this.fileSize;
    if (entry.kind === "message") chat.messages--;
    this.bytes += bytes;
    if (!chat.bytes && !chat.messages && !chat.attachmentBytes) await this.onChatComplete(chatId, this.bytes);
  }

  finish(): void {
    if (!this.manifest || this.headerUsed || this.manifest.bytes !== this.bytes
      || this.seenChats.size !== this.chats.size
      || [...this.chats.values()].some((chat) => chat.bytes || chat.messages || chat.attachmentBytes)) {
      throw new Error("Incomplete transfer archive");
    }
  }

  dispose(): void {
    this.manifest = undefined;
    this.chats.clear();
    this.json.fill(0);
    this.json = new Uint8Array(0);
    this.fileParts = [];
  }
}
