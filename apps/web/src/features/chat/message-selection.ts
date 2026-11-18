import { MAX_DELETE_BATCH_SIZE, type DecryptedMessage } from "@e2ee-chat/shared";
import { formatDateTime } from "../../i18n/format.js";
import { t } from "../../i18n/index.js";
import { normalizeExpiryMetadata } from "../../lib/message-retention.js";
import { copyableMessageText, isSticker } from "./presentation.js";

export type MessageSelection = ReadonlyMap<string, string>;

function revision(message: DecryptedMessage): string {
  return JSON.stringify([message.deletedAt ?? null, message.editSequence ?? 0, message.editedAt ?? null, message.latestEditSeq ?? 0, message.pendingEdit?.id ?? null]);
}

export function toggleMessageSelection(selection: MessageSelection, message: DecryptedMessage): MessageSelection {
  if (!selection.has(message.id) && selection.size >= MAX_DELETE_BATCH_SIZE) return selection;
  const next = new Map(selection);
  if (next.has(message.id)) next.delete(message.id);
  else next.set(message.id, revision(message));
  return next;
}

export function pruneMessageSelection(selection: MessageSelection, messages: DecryptedMessage[]): MessageSelection {
  const next = new Map<string, string>();
  for (const message of messages) {
    const selectedRevision = selection.get(message.id);
    if (selectedRevision !== undefined && selectedRevision === revision(message)) next.set(message.id, selectedRevision);
  }
  return next.size === selection.size ? selection : next;
}

export function isUnsentSelectionMessage(message: DecryptedMessage, outgoingIds: ReadonlySet<string>): boolean {
  // Terminal receive failures are stored with empty content and no outgoing entry,
  // including when the original sender is another device on this account.
  return message.deletedAt == null && (outgoingIds.has(message.id) || message.status === "sending"
    || (message.status === "failed" && message.content !== ""));
}

export function deleteSelectionUnavailable(messages: DecryptedMessage[], userId: string | undefined, accepted: boolean,
  outgoingIds: ReadonlySet<string>, now = Date.now()) {
  if (!accepted) return "messageSelectionMembership" as const;
  if (messages.some((message) => message.deletedAt != null)) return "messageSelectionDeleted" as const;
  if (messages.some((message) => message.senderId !== userId)) return "messageSelectionOwnOnly" as const;
  if (messages.some((message) => message.type !== "text" && message.type !== "file")) return "messageSelectionUnsupported" as const;
  if (messages.some((message) => isUnsentSelectionMessage(message, outgoingIds))) return "messageSelectionUnsent" as const;
  if (messages.some((message) => normalizeExpiryMetadata(message).expiresAt <= now)) return "messageSelectionExpired" as const;
  return undefined;
}

export function messageSelectionText(message: DecryptedMessage): string {
  if (message.deletedAt != null) return `[${t("messageDeleted")}]`;
  if (message.type === "file") return `[${t("fileTypeLabel")}]`;
  if (isSticker(message)) return `[${t("stickerPreview")}]`;
  if (message.type !== "text") return `[${t("messages")}]`;
  return copyableMessageText(message);
}

export function copySelectedMessagesText(messages: DecryptedMessage[], senderName: (id: string) => string): string {
  return [...messages].sort((a, b) => a.timestamp - b.timestamp)
    .map((message) => `${senderName(message.senderId)} · ${formatDateTime(message.timestamp)}\n${messageSelectionText(message)}`)
    .join("\n\n");
}
