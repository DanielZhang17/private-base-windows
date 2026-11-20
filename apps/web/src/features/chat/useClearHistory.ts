import { useLayoutEffect, useRef, useState } from "react";
import type { ClearHistoryPage, DecryptedMessage } from "@e2ee-chat/shared";
import { getConversationOutboxIds, getMessageById, getMessageDeletion, getOutgoing } from "../../db/index.js";
import { localized } from "../../i18n/messages.js";
import { applyClearHistoryPage } from "../../lib/message-sync.js";
import { api, ApiError } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { useToast } from "../../ui/index.js";
import { captureMessageActionSession, isMessageActionSessionCurrent } from "./message-action-session.js";
import { discardAndHideMessages, discardConversationHistory } from "./outgoingQueue.js";

type ClearAction = "everyone" | "local";
type Confirmation = { scope: string; action: ClearAction };
type Progress = { cursor?: string | null; queuedIds?: string[]; skipped?: string[]; cleanupPending?: true };

async function postClearPage(path: string, current: () => boolean, cursor?: string) {
  while (current()) {
    try {
      return await api.post<ClearHistoryPage>(path, cursor === undefined ? {} : { cursor });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 429) throw error;
      const retry = (error.body as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      const seconds = typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? Math.min(60, retry) : 60;
      if (!current()) return;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
  }
}

export function useClearHistory(conversationId: string | undefined, direct: boolean, messages: DecryptedMessage[], onStart: () => void) {
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const scope = JSON.stringify([authEpoch, conversationId]);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [failed, setFailed] = useState(false);
  const progress = useRef<Progress>({});
  const view = useRef<string>(undefined);
  const suppressed = useChatStore((state) => conversationId ? state.clearingHistory.get(conversationId) : undefined);
  const toast = useToast();
  const dialog = confirmation?.scope === scope ? confirmation : undefined;
  if (confirmation && !dialog) setConfirmation(undefined);
  useLayoutEffect(() => {
    view.current = scope;
    return () => { view.current = undefined; };
  }, [scope]);

  async function confirm() {
    if (!conversationId || !dialog) return;
    const session = captureMessageActionSession();
    const attempt = progress.current;
    const current = () => isMessageActionSessionCurrent(session);
    if (!session.userId || !session.deviceId || !current()) return;
    const chat = useChatStore.getState();
    if (chat.clearingHistory.has(conversationId)) return;
    const optimistic = new Set([...messages, ...(chat.messages.get(conversationId) ?? [])].map(({ id }) => id));
    const visible = () => current() && view.current === scope;
    chat.setClearingHistory(conversationId, optimistic);
    setFailed(false);
    try {
      onStart();
      if (dialog.action === "local") {
        const { alreadySending } = await discardConversationHistory(conversationId, optimistic, direct);
        if (visible() && alreadySending.length) toast.show({ tone: "warning", message: localized("messageAlreadySending") });
      } else {
        const path = `/api/conversations/${encodeURIComponent(conversationId)}/clear-messages`;
        attempt.queuedIds ??= await getConversationOutboxIds(conversationId, session.userId, session.deviceId);
        if (attempt.cursor === undefined) {
          const start = await postClearPage(path, current);
          if (!start || !current()) return;
          attempt.cursor = start.nextCursor;
        }
        if (!attempt.skipped) {
          const { alreadySending } = await discardAndHideMessages(conversationId, attempt.queuedIds, new Set(attempt.queuedIds));
          attempt.skipped = alreadySending;
        }
        while (current() && attempt.cursor) {
          const page = await postClearPage(path, current, attempt.cursor);
          if (!page || !current()) return;
          await applyClearHistoryPage(conversationId, page.deletions, direct);
          attempt.cursor = page.nextCursor;
          attempt.cleanupPending ||= page.cleanupPending;
        }
        if (current() && attempt.skipped.length) {
          const identity = { conversationId, senderId: session.userId };
          const survivors = await Promise.all(attempt.skipped.map(async (id) => {
            if (await getMessageDeletion(id, session.userId, identity, direct)) return false;
            if (await getOutgoing(id, session.userId)) return true;
            const message = await getMessageById(id, session.userId, direct);
            return message?.conversationId === conversationId && message.senderId === session.userId && message.deletedAt == null;
          }));
          if (visible() && survivors.some(Boolean)) toast.show({ tone: "warning", message: localized("messageAlreadySending") });
        }
        if (visible() && attempt.cleanupPending) toast.show({ message: localized("messageAttachmentCleanupPending") });
      }
      if (visible()) setConfirmation(undefined);
    } catch {
      if (visible()) setFailed(true);
    } finally {
      if (useChatStore.getState().clearingHistory.get(conversationId) === optimistic) chat.setClearingHistory(conversationId);
    }
  }

  return {
    action: dialog?.action, busy: !!suppressed, suppressed, failed: !!dialog && failed,
    request: (action: ClearAction) => { progress.current = {}; setFailed(false); setConfirmation({ scope, action }); },
    cancel: () => setConfirmation(undefined),
    confirm,
  };
}
