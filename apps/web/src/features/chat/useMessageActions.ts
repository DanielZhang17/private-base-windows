import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { DecryptedMessage } from "@e2ee-chat/shared";
import { captureMessageActionSession, isMessageActionSessionCurrent } from "./message-action-session.js";
import { api } from "../../services/api.js";
import { getOutgoing, saveMessage } from "../../db/index.js";
import { deleteMessageForLocalUserOnly, handleMessageDeletion, hideMessageWithUndo } from "../../lib/message-sync.js";
import { discardOutgoing } from "./outgoingQueue.js";
import { capabilities } from "../../platform/capabilities.js";
import { parseFilePayload } from "./presentation.js";
import { t } from "../../i18n/index.js";

export function useMessageActions(message: DecryptedMessage, isOwn: boolean) {
  const [position, setPosition] = useState<{ x: number; y: number; top?: number; source: "button" | "pointer"; align: "start" | "end"; keyboard: boolean } | null>(null);
  const [confirmLocalDelete, setConfirmLocalDelete] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touch = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const openingTouch = useRef(false);
  const suppressMouseUntil = useRef(0);
  const cancelPress = () => { if (touch.current) clearTimeout(touch.current.timer); touch.current = null; };
  useEffect(() => {
    const scroll = (event: Event) => {
      cancelPress();
      if (event.target instanceof Element && event.target.matches('[role="log"], [data-message-list]')) setPosition(null);
    };
    window.addEventListener("scroll", scroll, true);
    return () => { cancelPress(); window.removeEventListener("scroll", scroll, true); };
  }, []);
  const menuOpen = position !== null;
  useLayoutEffect(() => {
    if (!menuOpen) return;
    // The Sheet may replace the touch target before release. Capture the original
    // release and its compatibility mouse events even when they land on the scrim.
    const guarded = () => openingTouch.current || Date.now() < suppressMouseUntil.current;
    const stop = (event: Event) => {
      if (!guarded()) return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    const release = (event: Event) => {
      if (!guarded()) return;
      stop(event);
      openingTouch.current = false;
      suppressMouseUntil.current = Date.now() + 400;
      cancelPress();
    };
    const nextInteraction = () => {
      openingTouch.current = false;
      suppressMouseUntil.current = 0;
    };
    document.addEventListener("pointerup", release, true);
    document.addEventListener("touchend", release, { capture: true, passive: false });
    for (const type of ["mousedown", "mouseup", "click", "contextmenu"]) document.addEventListener(type, stop, true);
    for (const type of ["pointerdown", "touchstart", "keydown"]) document.addEventListener(type, nextInteraction, true);
    return () => {
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("touchend", release, true);
      for (const type of ["mousedown", "mouseup", "click", "contextmenu"]) document.removeEventListener(type, stop, true);
      for (const type of ["pointerdown", "touchstart", "keydown"]) document.removeEventListener(type, nextInteraction, true);
    };
  }, [menuOpen]);
  const close = () => setPosition(null);
  const openFromButton = (event: MouseEvent<HTMLButtonElement>) => {
    openingTouch.current = false; suppressMouseUntil.current = 0;
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition({ x: isOwn ? rect.right : rect.left, y: rect.bottom, top: rect.top, source: "button", align: isOwn ? "end" : "start", keyboard: event.detail === 0 });
  };
  const triggers = {
    onContextMenu(event: MouseEvent) {
      if (!event.currentTarget.contains(event.target as Node)) return;
      const target = event.target instanceof Element ? event.target : null;
      const selection = window.getSelection();
      if (target?.closest("a") || (selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(event.currentTarget))) { cancelPress(); return; }
      event.preventDefault(); event.stopPropagation();
      if (openingTouch.current || Date.now() < suppressMouseUntil.current) return;
      openingTouch.current = touch.current !== null;
      cancelPress();
      setPosition({ x: event.clientX, y: event.clientY, source: "pointer", align: isOwn ? "end" : "start", keyboard: false });
    },
    onPointerDown(event: PointerEvent) {
      if (!event.currentTarget.contains(event.target as Node)) return;
      cancelPress(); openingTouch.current = false; suppressMouseUntil.current = 0;
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      const { clientX: x, clientY: y } = event;
      touch.current = { x, y, timer: setTimeout(() => {
        openingTouch.current = true;
        setPosition({ x, y, source: "pointer", align: isOwn ? "end" : "start", keyboard: false });
        try { navigator.vibrate?.(10); } catch { /* Haptics are optional. */ }
        touch.current = null;
      }, 500) };
    },
    onPointerMove(event: PointerEvent) {
      if (touch.current && Math.hypot(event.clientX - touch.current.x, event.clientY - touch.current.y) > 8) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onClickCapture(event: MouseEvent) {
      if (!event.currentTarget.contains(event.target as Node)) return;
      // Also cover a release in the timer's task, before React mounts the menu.
      if (openingTouch.current || Date.now() < suppressMouseUntil.current) {
        event.preventDefault(); event.stopPropagation();
      }
    },
  };
  async function requestDeleteForMe() {
    const session = captureMessageActionSession();
    const current = () => isMessageActionSessionCurrent(session);
    setError(null);
    try {
      const outgoing = await getOutgoing(message.id);
      if (!current()) return null;
      if (message.status === "sending" || message.status === "failed" || outgoing) { setConfirmLocalDelete(true); return null; }
      await saveMessage(message, current);
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
      const outgoing = await getOutgoing(message.id);
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
      const outgoing = await getOutgoing(message.id);
      if (!current()) return;
      if (outgoing) {
        await deleteForMe(session);
        if (current()) setConfirmDelete(false);
        return;
      }
      const fileId = message.type === "file" ? parseFilePayload(message.content)?.fileId : undefined;
      const path = `/api/messages/${encodeURIComponent(message.id)}${fileId ? `?fileId=${encodeURIComponent(fileId)}` : ""}`;
      const result = await api.delete<{ deletedAt: number; deletedIds: string[] }>(path);
      if (!current()) return;
      await handleMessageDeletion({ conversationId: message.conversationId, deletion: { ids: result.deletedIds, deletedAt: result.deletedAt, deletedByUserId: message.senderId } });
      if (current()) setConfirmDelete(false);
    } catch { if (current()) setError(t("messageDeleteFailed")); }
    finally { if (current()) setBusy(false); }
  }
  return { fileSaveSupported: capabilities.saveFile, confirmLocalDelete, setConfirmLocalDelete, requestDeleteForMe, fileSaveMode: capabilities.fileSave, position, close, openFromButton, triggers, confirmDelete, setConfirmDelete, busy, error, clearError: () => setError(null), deleteForMe, deleteForEveryone };
}
