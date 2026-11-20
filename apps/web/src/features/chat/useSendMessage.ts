import { localized, renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { INTERRUPTED_FILE_ERROR, outgoingErrorKey, outgoingErrorLabel } from "./outgoing-errors.js";
import { toErrorMessage } from "../shared/errors.js";
import { useLocale } from "../../i18n/index.js";
import { useState } from "react";
import type { ConversationWithMembers, DecryptedMessage } from "@e2ee-chat/shared";
import { MESSAGE_RETENTION_MS } from "@e2ee-chat/shared";
import { encryptFile, encryptMessageEdit, generateFileKey, fromBase64Url, toBase64Url } from "@e2ee-chat/crypto";
import { getMessageById, saveQueuedMessage, saveQueuedEdit, updateOutgoingIfPresent, guardMessageForPublish, type LocalOutgoing } from "../../db/index.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { retryOutgoing, refreshOutgoingQueue, setFilePreparing, isFilePreparationCancelled } from "./outgoingQueue.js";
import { useOutgoingQueue } from "./useOutgoingQueue.js";
import { uploadMimeType } from "./uploadMimeType.js";
import { captureMessageActionSession, isMessageActionSessionCurrent } from "./message-action-session.js";
import { getIdentityKeyPair, getUnlockGeneration, keysLoaded } from "../../lib/key-manager.js";
import { messageEditScope } from "../../lib/message-edit.js";
import { isSticker } from "../../lib/stickers.js";
import { groupTimeoutRemaining } from "./group-timeout.js";

export function useSendMessage(conversation: ConversationWithMembers | undefined) {
  useLocale();
  const { outgoing, retry, discard } = useOutgoingQueue();
  const [sendError, setSendError] = useState<LocalizedMessage | null>(null);
  const isTimedOut = (userId: string) => conversation?.type === "group"
    && groupTimeoutRemaining(conversation, conversation.members.find((member) => member.userId === userId)?.timedOutUntil) > 0;
  const enqueue = async (content: string, type: "text" | "file", options: { ttlSeconds: number | null }, file?: File, fileKey?: ReturnType<typeof generateFileKey>) => {
    const { user, device, sessionId } = useAuthStore.getState();
    if (!conversation || !user || !device) return;
    if (isTimedOut(user.id)) { setSendError(localized("groupTimedOut")); return; }
    const timestamp = Date.now();
    const message: DecryptedMessage = {
      id: crypto.randomUUID(), ownerId: user.id, conversationId: conversation.id, senderId: user.id, content, type, timestamp,
      expiresAt: timestamp + (options.ttlSeconds ? options.ttlSeconds * 1000 : MESSAGE_RETENTION_MS),
      expiryKind: options.ttlSeconds ? "timed" : "retention", status: "sending",
    };
    const row: LocalOutgoing = {
      id: message.id, queuedAt: timestamp, userId: user.id, deviceId: device.id, conversationId: conversation.id, conversationType: conversation.type,
      ttlSeconds: options.ttlSeconds, steps: [], sendDispatched: false, attempts: 0, status: "sending", retryable: !file,
      nextAttemptAt: null, error: file ? INTERRUPTED_FILE_ERROR : null,
    };
    const canPublish = async () => {
      const visible = await guardMessageForPublish(message, user.id);
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
  const handleEdit = async (messageId: string, content: string, baseSequence: number) => {
    const session = captureMessageActionSession();
    const generation = getUnlockGeneration();
    const current = () => isMessageActionSessionCurrent(session) && keysLoaded() && getUnlockGeneration() === generation;
    if (!conversation || !session.userId || !session.deviceId
      || !conversation.members.some((member) => member.userId === session.userId && member.acceptedAt != null)) return false;
    if (isTimedOut(session.userId)) { setSendError(localized("groupTimedOut")); return false; }
    setSendError(null);
    if (isSticker({ type: "text", content })) {
      setSendError(localized("messageEditStickerReplacement"));
      return false;
    }
    try {
      const original = await getMessageById(messageId, session.userId, conversation.type === "direct", true);
      if (!current() || !original?.editKeyAccepted || !original.editKey || !original.editKeyVersion || original.editSenderDeviceId !== session.deviceId
        || original.senderId !== session.userId || original.conversationId !== conversation.id) return false;
      if ((original.editSequence ?? 0) !== baseSequence) {
        setSendError(localized("messageEditConflict"));
        return false;
      }
      const identity = getIdentityKeyPair();
      if (original.editSigningKey !== toBase64Url(identity.publicEd25519)) return false;
      const scope = messageEditScope(original, session.deviceId);
      const editSeq = baseSequence + 1;
      const sealed = await encryptMessageEdit(fromBase64Url(original.editKey), identity.privateEd25519, scope, editSeq, content);
      const row: LocalOutgoing & { editTargetId: string } = {
        id: crypto.randomUUID(), editTargetId: messageId, queuedAt: Date.now(),
        userId: session.userId, deviceId: session.deviceId, conversationId: conversation.id, conversationType: conversation.type,
        ttlSeconds: null, steps: [{ path: "/api/messages/edit", body: {
          messageId: scope.messageId, conversationId: scope.conversationId, editSeq, ...sealed,
        }, sendDispatched: false }], sendDispatched: false, attempts: 0, status: "sending",
        retryable: true, nextAttemptAt: null, error: null,
      };
      const updated = await saveQueuedEdit(row, original.editKeyVersion, content, current);
      if (!current()) return false;
      if (!updated) {
        const latest = await getMessageById(messageId, session.userId);
        if (current()) setSendError(localized(latest && (latest.editSequence ?? 0) !== baseSequence ? "messageEditConflict" : "messageEditFailed"));
        return false;
      }
      const visible = await guardMessageForPublish(updated, session.userId);
      if (!current()) return false;
      if (visible) useChatStore.getState().addMessage(conversation.id, visible as DecryptedMessage);
      void retryOutgoing(row.id).catch(console.error);
      return true;
    } catch (error) {
      if (current()) setSendError(toErrorMessage(error, "messageEditFailed"));
      return false;
    }
  };
  return { handleSend, handleSendFile, handleEdit, outgoing: outgoing.filter((row) => row.conversationId === conversation?.id).map((row) => ({ ...row, error: row.error ? outgoingErrorLabel(row.error) : null })), retry, discard, sendError: sendError ? renderMessage(sendError) : null };
}
