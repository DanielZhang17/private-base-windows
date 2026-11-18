import { formatDate, formatDuration } from "../../i18n/format.js";
import { t, getLocale } from "../../i18n/index.js";
import { isSticker } from "../../lib/stickers.js";
export { isSticker, parseStickerToken } from "../../lib/stickers.js";
import { isToday, isYesterday } from "date-fns";
import { useSecondTicker } from "../../lib/second-ticker.js";
export type { DecryptedMessage, CustomEmoji } from "@e2ee-chat/shared";
export { resolveApiUrl as emojiImageUrl } from "../../services/api.js";
export function dateLabel(date: Date) {
  return isToday(date) ? t("today") : isYesterday(date) ? t("yesterday") : formatDate(date, { year: "numeric", month: "long", day: "numeric" });
}
export function useExpiryLabel(expiresAt: number) {
  const remaining = Math.ceil((expiresAt - useSecondTicker()) / 1000);
  if (remaining <= 0) return null;
  const [unit, divisor] = remaining >= 86400 ? ["day", 86400] as const : remaining >= 3600 ? ["hour", 3600] as const : remaining >= 60 ? ["minute", 60] as const : ["second", 1] as const;
  return new Intl.NumberFormat(getLocale(), { style: "unit", unit, unitDisplay: "narrow" }).format(Math.floor(remaining / divisor));
}
export interface FilePayload { fileId: string; fileName: string; mimeType: string; size?: number; sizeBytes?: number; fileKey: string; iv?: string; fileIv?: string }
export function parseFilePayload(content: string): FilePayload | null {
  try {
    const parsed = JSON.parse(content) as FilePayload;
    return parsed.fileId && parsed.fileName && parsed.mimeType && parsed.fileKey && (parsed.iv || parsed.fileIv) ? parsed : null;
  } catch { return null; }
}

import type { ConversationWithMembers, DecryptedMessage, Device } from "@e2ee-chat/shared";

export function linkedDeviceTime(device: Pick<Device, "linkMethod" | "activatedAt" | "createdAt"> | null) {
  return device?.linkMethod && device.linkMethod !== "register" ? device.activatedAt ?? device.createdAt : undefined;
}

// SQLite conversation and membership timestamps can be in seconds.
function conversationTimeMs(timestamp: number): number {
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

export function predatesDeviceLink(conversation: ConversationWithMembers, linkedAt: number, joinedAt?: number): boolean {
  return conversationTimeMs(conversation.createdAt) < linkedAt &&
    (conversation.type !== "group" || (joinedAt !== undefined && conversationTimeMs(joinedAt) < linkedAt));
}

export function chatPreview(message: DecryptedMessage, conversation: ConversationWithMembers, userId?: string) {
  if (message.deletedAt) return t("messageDeleted");
  let preview = copyableMessageText(message);
  if (message.type === "file") {
    const file = parseFilePayload(message.content);
    preview = file?.mimeType.startsWith("image/") ? t("photoMessagePreview") : file ? t("chatPreviewFileName", { fileName: file.fileName }) : t("fileTypeLabel");
  }
  if (["system", "key_exchange", "sender_key_distribution"].includes(message.type)) return "";
  if (message.status === "failed") return t("notSent2", { preview: preview });
  const sender = conversation.members.find((member) => member.userId === message.senderId);
  if (message.senderId === userId) return t("chatPreviewFromYou", { preview });
  return conversation.type === "group" && sender ? t("chatPreviewFromMember", { name: sender.user.displayName, preview }) : preview;
}

export function canEditMessage(message: DecryptedMessage, userId?: string, deviceId?: string): boolean {
  return message.senderId === userId && message.type === "text" && !message.deletedAt && !message.pendingEdit && !isSticker(message)
    && message.editKeyAccepted === true && !!deviceId && message.editSenderDeviceId === deviceId
    && ["sent", "delivered", "read"].includes(message.status)
    && (message.expiresAt === null || message.expiresAt > Date.now());
}

export function copyableMessageText(message: DecryptedMessage) {
  return isSticker(message) ? t("stickerPreview") : (message.pendingEdit?.content ?? message.content);
}

export function timedDuration(messages: DecryptedMessage[]) {
  const lastTimed = [...messages].reverse().find((message) => message.expiryKind === "timed" && message.expiresAt != null);
  if (!lastTimed?.expiresAt) return null;
  const seconds = Math.round((lastTimed.expiresAt - lastTimed.timestamp) / 1000);
  return formatDuration(seconds);
}

export function attachmentName(content: string) {
  try { const file = JSON.parse(content); return typeof file.fileName === "string" ? file.fileName : t("fileTypeLabel"); }
  catch { return t("fileTypeLabel"); }
}

export function fileTypeLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return /^[a-z0-9]+$/i.test(extension) ? extension.slice(0, 5).toUpperCase() : t("fileTypeLabel");
}
function sameMessageRun(left: DecryptedMessage | undefined, right: DecryptedMessage | undefined): boolean {
  return !!left && !!right && left.senderId === right.senderId && Math.abs(right.timestamp - left.timestamp) < 60_000
    && new Date(left.timestamp).toDateString() === new Date(right.timestamp).toDateString();
}
export function messageRun(messages: DecryptedMessage[], index: number) {
  return { first: !sameMessageRun(messages[index - 1], messages[index]), last: !sameMessageRun(messages[index], messages[index + 1]) };
}
