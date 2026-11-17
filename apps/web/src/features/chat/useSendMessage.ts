import { renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { INTERRUPTED_FILE_ERROR, outgoingErrorKey, outgoingErrorLabel } from "./outgoing-errors.js";
import { toErrorMessage } from "../shared/errors.js";
import { useLocale } from "../../i18n/index.js";
import { useState } from "react";
import type { ConversationWithMembers, DecryptedMessage } from "@e2ee-chat/shared";
import { MESSAGE_RETENTION_MS } from "@e2ee-chat/shared";
import { encryptFile, generateFileKey } from "@e2ee-chat/crypto";
import { saveQueuedMessage, updateOutgoingIfPresent, guardMessageForPublish, type LocalOutgoing } from "../../db/index.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { retryOutgoing, refreshOutgoingQueue, setFilePreparing, isFilePreparationCancelled } from "./outgoingQueue.js";
import { useOutgoingQueue } from "./useOutgoingQueue.js";
import { uploadMimeType } from "./uploadMimeType.js";

export function useSendMessage(conversation: ConversationWithMembers | undefined) {
  useLocale();
  const { outgoing, retry, discard } = useOutgoingQueue();
  const [sendError, setSendError] = useState<LocalizedMessage | null>(null);
  const enqueue = async (content: string, type: "text" | "file", options: { ttlSeconds: number | null }, file?: File, fileKey?: ReturnType<typeof generateFileKey>) => {
    const { user, device, sessionId } = useAuthStore.getState();
    if (!conversation || !user || !device) return;
    const timestamp = Date.now();
    const message: DecryptedMessage = {
      id: crypto.randomUUID(), conversationId: conversation.id, senderId: user.id, content, type, timestamp,
      expiresAt: timestamp + (options.ttlSeconds ? options.ttlSeconds * 1000 : MESSAGE_RETENTION_MS),
      expiryKind: options.ttlSeconds ? "timed" : "retention", status: "sending",
    };
    const row: LocalOutgoing = {
      id: message.id, queuedAt: timestamp, userId: user.id, deviceId: device.id, conversationId: conversation.id, conversationType: conversation.type,
      ttlSeconds: options.ttlSeconds, steps: [], sendDispatched: false, attempts: 0, status: "sending", retryable: !file,
      nextAttemptAt: null, error: file ? INTERRUPTED_FILE_ERROR : null,
    };
    const canPublish = async () => {
      const visible = await guardMessageForPublish(message);
      if (!visible || visible.deletedAt) return false;
      const current = useAuthStore.getState();
      return !isFilePreparationCancelled(message.id) && current.user?.id === user.id
        && current.device?.id === device.id && current.sessionId === sessionId;
    };
    // A fresh UUID is published synchronously before any await or persisted snapshot
    // exists. Every continuation below checks the durable publication guard.
    useChatStore.getState().addMessage(conversation.id, message);
    setSendError(null);
    if (file) setFilePreparing(message.id, true);
    try {
      await saveQueuedMessage(message, row);
      if (!await canPublish()) return;
      if (file && fileKey) {
        const encrypted = await encryptFile(new Uint8Array(await file.arrayBuffer()), fileKey);
        if (!await canPublish()) return;
        row.upload = { bytes: new Uint8Array(encrypted), mimeType: uploadMimeType(file) };
        row.retryable = true;
        row.error = null;
        if (!await updateOutgoingIfPresent(row, message)) return;
        if (!await canPublish()) return;
        setFilePreparing(message.id, false);
      }
      await retryOutgoing(message.id);
    } catch (error) {
      if (!await canPublish()) return;
      useChatStore.getState().addMessage(conversation.id, { ...message, status: "failed" });
      setSendError(toErrorMessage(error, "messageNotSent"));
      row.status = "failed";
      row.error = file && !row.upload ? INTERRUPTED_FILE_ERROR : outgoingErrorKey(error);
      await updateOutgoingIfPresent(row, { ...message, status: "failed" }).catch(() => undefined);
    } finally {
      if (file) setFilePreparing(message.id, false);
    }
    await refreshOutgoingQueue().catch(console.error);
  };
  const handleSend = (text: string, options: { ttlSeconds: number | null }) => enqueue(text, "text", options);
  const handleSendFile = (file: File, options: { ttlSeconds: number | null }) => {
    const fileKey = generateFileKey();
    return enqueue(JSON.stringify({ fileId: "", fileName: file.name, mimeType: file.type || "application/octet-stream", size: file.size, fileKey: fileKey.key, iv: fileKey.iv }), "file", options, file, fileKey);
  };
  return { handleSend, handleSendFile, outgoing: outgoing.filter((row) => row.conversationId === conversation?.id).map((row) => ({ ...row, error: row.error ? outgoingErrorLabel(row.error) : null })), retry, discard, sendError: sendError ? renderMessage(sendError) : null };
}
