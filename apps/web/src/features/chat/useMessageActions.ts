import { useEffect, useState, type MouseEvent } from "react";
import type { DecryptedMessage } from "@e2ee-chat/shared";
import { captureMessageActionSession, isMessageActionSessionCurrent } from "./message-action-session.js";
import { api } from "../../services/api.js";
import { getOutgoing, saveMessage } from "../../db/index.js";
import { deleteMessageForLocalUserOnly, handleMessageDeletion, hideMessageWithUndo } from "../../lib/message-sync.js";
import { discardOutgoing } from "./outgoingQueue.js";
import { capabilities } from "../../platform/capabilities.js";
import { parseFilePayload } from "./presentation.js";
import { t } from "../../i18n/index.js";
import { useLongPress } from "./useLongPress.js";

export function useMessageActions(message: DecryptedMessage, isOwn: boolean) {
  const [position, setPosition] = useState<{ x: number; y: number; top?: number; source: "button" | "pointer"; align: "start" | "end"; keyboard: boolean } | null>(null);
  const [confirmLocalDelete, setConfirmLocalDelete] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const press = useLongPress(position !== null);
  useEffect(() => {
    if (!position) return;
    const scroll = (event: Event) => {
      if (event.target instanceof Element && event.target.matches('[role="log"], [data-message-list]')) setPosition(null);
    };
    window.addEventListener("scroll", scroll, true);
    return () => window.removeEventListener("scroll", scroll, true);
  }, [position]);
  const close = () => setPosition(null);
  const openFromButton = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition({ x: isOwn ? rect.right : rect.left, y: rect.bottom, top: rect.top, source: "button", align: isOwn ? "end" : "start", keyboard: event.detail === 0 });
  };
  const openAtPointer = (x: number, y: number) => setPosition({ x, y, source: "pointer", align: isOwn ? "end" : "start", keyboard: false });
  const triggers = {
    onContextMenu(event: MouseEvent) {
      if (!event.currentTarget.contains(event.target as Node)) return;
      const target = event.target instanceof Element ? event.target : null;
      const selection = window.getSelection();
      if (target?.closest("a") || (selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(event.currentTarget))) { press.cancel(); return; }
      event.preventDefault(); event.stopPropagation();
      if (press.contextMenu()) openAtPointer(event.clientX, event.clientY);
    },
    onPointerDown(event: React.PointerEvent) {
      if (!event.currentTarget.contains(event.target as Node) || event.pointerType !== "touch" || !event.isPrimary) return;
      const { clientX, clientY } = event;
      press.begin(event, () => openAtPointer(clientX, clientY));
    },
    onPointerMove: press.move,
    onPointerUp: press.release,
    onPointerCancel: press.cancel,
    onClickCapture(event: MouseEvent) {
      if (event.currentTarget.contains(event.target as Node)) press.captureClick(event);
    },
    onKeyDown(event: React.KeyboardEvent) {
      if (!event.currentTarget.contains(event.target as Node)) return;
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setPosition({ x: isOwn ? rect.right : rect.left, y: rect.bottom, top: rect.top, source: "button", align: isOwn ? "end" : "start", keyboard: true });
    },
  };
  async function requestDeleteForMe() {
    const session = captureMessageActionSession();
    const current = () => isMessageActionSessionCurrent(session);
    setError(null);
    try {
      const outgoing = await getOutgoing(message.id, session.userId);
      if (!current()) return null;
      if (message.status === "sending" || message.status === "failed" || outgoing) { setConfirmLocalDelete(true); return null; }
      await saveMessage(message, current, session.userId);
      if (!current()) return null;
      const undo = await hideMessageWithUndo(message.conversationId, message.id, current);
      if (!current()) return null;
      if (!undo) setError(t("messageDeleteFailed"));
      return undo;
    } catch { if (current()) setError(t("messageDeleteFailed")); return null; }
  }
  async function deleteForMe(session = captureMessageActionSession()) {
    const current = () => isMessageActionSessionCurrent(session);
    setError(null);
    try {
      const outgoing = await getOutgoing(message.id, session.userId);
      if (!current()) return;
      if (outgoing || message.status === "sending" || message.status === "failed") await discardOutgoing(message.id);
      if (!current()) return;
      await deleteMessageForLocalUserOnly(message.conversationId, message.id, current);
      if (current()) setConfirmLocalDelete(false);
    } catch { if (current()) setError(t("messageDeleteFailed")); }
  }
  async function deleteForEveryone() {
    const session = captureMessageActionSession();
    const current = () => isMessageActionSessionCurrent(session);
    if (busy || !current()) return;
    setBusy(true); setError(null);
    try {
      const outgoing = await getOutgoing(message.id, session.userId);
      if (!current()) return;
      if (outgoing) {
        await deleteForMe(session);
        if (current()) setConfirmDelete(false);
        return;
      }
      const fileId = message.type === "file" ? parseFilePayload(message.content)?.fileId : undefined;
      const path = `/api/messages/${encodeURIComponent(message.transferSourceId ?? message.id)}${fileId ? `?fileId=${encodeURIComponent(fileId)}` : ""}`;
      const result = await api.delete<{ deletedAt: number; deletedIds: string[] }>(path);
      if (!current()) return;
      await handleMessageDeletion({ conversationId: message.conversationId, deletion: { ids: result.deletedIds, deletedAt: result.deletedAt, deletedByUserId: message.senderId } });
      if (current()) setConfirmDelete(false);
    } catch { if (current()) setError(t("messageDeleteFailed")); }
    finally { if (current()) setBusy(false); }
  }
  return { fileSaveSupported: capabilities.saveFile, confirmLocalDelete, setConfirmLocalDelete, requestDeleteForMe, fileSaveMode: capabilities.fileSave, position, close, openFromButton, triggers, confirmDelete, setConfirmDelete, busy, error, clearError: () => setError(null), deleteForMe, deleteForEveryone };
}
