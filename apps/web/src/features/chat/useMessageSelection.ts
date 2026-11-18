import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_DELETE_BATCH_SIZE, type DecryptedMessage, type MessageDeletionEvent, type MessageEventPayload } from "@e2ee-chat/shared";
import { localized } from "../../i18n/messages.js";
import type { TranslationKey } from "../../i18n/index.js";
import { normalizeExpiryMetadata } from "../../lib/message-retention.js";
import { handleBatchMessageDeletion } from "../../lib/message-sync.js";
import { api, ApiError } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { getTopOverlay } from "../../ui/overlay-stack.js";
import { useToast } from "../../ui/index.js";
import { copyMessageText } from "./message-actions.js";
import { captureMessageActionSession, isMessageActionSessionCurrent } from "./message-action-session.js";
import { copySelectedMessagesText, deleteSelectionUnavailable, isUnsentSelectionMessage, pruneMessageSelection, toggleMessageSelection, type MessageSelection } from "./message-selection.js";
import { discardAndHideMessages } from "./outgoingQueue.js";
import { parseFilePayload } from "./presentation.js";

type DeleteAction = "local" | "everyone";
const empty: MessageSelection = new Map();

export function useMessageSelection({ conversationId, userId, accepted, messages, outgoingIds, senderName }: {
  conversationId?: string;
  userId?: string;
  accepted: boolean;
  messages: DecryptedMessage[];
  outgoingIds: ReadonlySet<string>;
  senderName: (id: string) => string;
}) {
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const scope = JSON.stringify([conversationId, userId, authEpoch]);
  const [state, setState] = useState({ scope, ids: empty });
  const ids = state.scope !== scope ? empty : state.ids.size ? pruneMessageSelection(state.ids, messages) : empty;
  if (state.scope !== scope || ids !== state.ids) setState({ scope, ids });
  const [confirm, setConfirm] = useState<{ action: DeleteAction; ids: MessageSelection; queued: ReadonlySet<string>; chooseScope: boolean }>();
  const [failure, setFailure] = useState<{ scope: string; ids: MessageSelection; key: TranslationKey }>();
  const [partial, setPartial] = useState<{ scope: string; skipped: number }>();
  const [copied, setCopied] = useState<{ scope: string; count: number; id: number }>();
  const copyId = useRef(0);
  const [operation, setOperation] = useState<{ scope: string }>();
  const inFlight = useRef<typeof operation>(undefined);
  const view = useRef<string>(undefined);
  const busy = operation?.scope === scope;
  const toast = useToast();
  const selected = ids.size ? messages.filter((message) => ids.has(message.id)) : [];
  const active = ids.size > 0;
  const queued = new Set(selected.filter((message) => message.senderId === userId && isUnsentSelectionMessage(message, outgoingIds))
    .map((message) => message.id));
  const unavailable = deleteSelectionUnavailable(selected, userId, accepted, outgoingIds);
  const confirmation = confirm && ((busy && confirm.action === "local" && state.scope === scope)
    || (active && confirm.ids === ids && (confirm.chooseScope || !unavailable || confirm.action === "local"))) ? confirm.action : undefined;
  const queuedCount = (confirmation === "local" ? confirm?.queued ?? queued : queued).size;
  const deleteError = confirmation && failure?.scope === scope && confirm?.ids === failure.ids ? failure.key : undefined;
  if (confirm && !confirmation) setConfirm(undefined);
  if (partial && partial.scope !== scope) setPartial(undefined);
  useLayoutEffect(() => {
    view.current = scope;
    return () => { view.current = undefined; };
  }, [scope]);
  useEffect(() => {
    if (!failure || deleteError) return;
    if (failure.scope === scope) toast.show({ tone: "danger", message: localized(failure.key) });
    setFailure(undefined);
  }, [failure, deleteError, scope, toast]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), 5_000);
    return () => clearTimeout(timer);
  }, [copied]);
  const expiry = active && !unavailable ? Math.min(...selected.map((message) => normalizeExpiryMetadata(message).expiresAt)) : undefined;
  const [expiryTick, refreshExpiry] = useState(0);
  useEffect(() => {
    if (expiry === undefined || !Number.isFinite(expiry)) return;
    const delay = Math.min(2_147_483_647, Math.max(0, expiry - Date.now()));
    const timer = setTimeout(() => refreshExpiry((value) => value + 1), delay);
    return () => clearTimeout(timer);
  }, [expiry, expiryTick]);

  useEffect(() => {
    if (!active || busy) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || getTopOverlay()) return;
      event.preventDefault();
      setState({ scope, ids: empty });
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [active, busy, scope]);

  function toggle(message: DecryptedMessage) {
    if (busy || !conversationId) return;
    if (ids.size >= MAX_DELETE_BATCH_SIZE && !ids.has(message.id)) {
      toast.show({ message: localized("messageSelectionLimit", { limit: MAX_DELETE_BATCH_SIZE }) });
      return;
    }
    setState((previous) => ({ scope, ids: toggleMessageSelection(previous.ids, message) }));
  }

  async function run(action: DeleteAction | "copy") {
    if (!conversationId || !active || inFlight.current?.scope === scope) return;
    const session = captureMessageActionSession();
    const current = () => isMessageActionSessionCurrent(session);
    if (session.userId !== userId || !current() || (action === "everyone" && deleteSelectionUnavailable(selected, userId, accepted, outgoingIds))) return;
    const task = { scope };
    inFlight.current = task;
    const showFeedback = () => current() && inFlight.current === task && view.current === scope;
    setOperation(task);
    if (action !== "copy") setFailure(undefined);
    try {
      if (action === "copy") {
        await copyMessageText(copySelectedMessagesText(selected, senderName));
        if (current() && inFlight.current === task) setCopied({ scope, count: selected.length, id: ++copyId.current });
      } else if (action === "local") {
        const result = await discardAndHideMessages(conversationId, [...ids.keys()], confirm?.queued);
        if (result.alreadySending.length) {
          if (showFeedback()) {
            const skipped = new Set(result.alreadySending);
            setState((previous) => previous.scope === scope ? { scope, ids: new Map([...previous.ids].filter(([id]) => skipped.has(id))) } : previous);
            setConfirm(undefined);
            setPartial({ scope, skipped: skipped.size });
          }
          return;
        }
      } else {
        const fileIds = Object.fromEntries(selected.flatMap((message) => {
          const fileId = message.type === "file" ? parseFilePayload(message.content)?.fileId : undefined;
          return fileId ? [[message.transferSourceId ?? message.id, fileId]] : [];
        }));
        const result = await api.post<{ deletions: MessageDeletionEvent[]; conversationType?: MessageEventPayload["conversationType"]; cleanupPending?: true }>("/api/messages/delete-batch", {
          conversationId, ids: selected.map((message) => message.transferSourceId ?? message.id), fileIds,
        });
        if (!current() || !session.userId) return;
        await handleBatchMessageDeletion(conversationId, result.deletions, session.userId, result.conversationType);
        if (result.cleanupPending && current() && inFlight.current === task) {
          toast.show({ message: localized("messageAttachmentCleanupPending") });
        }
      }
      if (current()) setState((previous) => previous.ids === ids ? { scope, ids: empty } : previous);
    } catch (error) {
      if (showFeedback()) {
        const code = action === "everyone" && error instanceof ApiError ? error.code : undefined;
        const key = action === "copy" ? "couldNotCopyMessage"
          : code === "DELETE_BATCH_SMALLER_SELECTION" ? "messageSelectionSmallerBatch"
            : code === "LEGACY_FILE_REFERENCE_REQUIRED" ? "messageSelectionLegacyAttachment" : "messageDeleteFailed";
        if (action === "copy") toast.show({ tone: "danger", message: localized(key) });
        else setFailure({ scope, ids, key });
      }
    } finally {
      if (inFlight.current === task) {
        inFlight.current = undefined;
        setOperation(undefined);
      }
    }
  }

  return {
    active, ids, busy, unavailable, confirmation, queuedCount, toggle, chooseScope: !!confirm?.chooseScope,
    confirmationCount: confirmation ? confirm?.ids.size ?? 0 : 0,
    skippedCount: partial?.scope === scope ? partial.skipped : undefined,
    deleteError, copied: copied?.scope === scope ? copied : undefined,
    cancel: () => setState({ scope, ids: empty }),
    copy: () => run("copy"),
    requestDelete: (action?: DeleteAction) => {
      setFailure(undefined);
      setConfirm({ action: action ?? "local", ids, queued, chooseScope: action === undefined });
    },
    chooseDeleteScope: (action: DeleteAction) => {
      if (busy || (action === "everyone" && unavailable)) return;
      setFailure(undefined);
      setConfirm((previous) => previous && { ...previous, action });
    },
    cancelDelete: () => { setConfirm(undefined); setPartial(undefined); setFailure(undefined); },
    confirmDelete: () => confirmation && run(confirmation),
  };
}
