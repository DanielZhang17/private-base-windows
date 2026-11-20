import { renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { useLocale } from "../../i18n/index.js";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../services/api.js";
import { refreshConversationList } from "../../lib/conversation-cache.js";
import { useChatStore } from "../../stores/chatStore.js";

export type ConversationExit = "leave" | "deleteGroup";

/** Same conversation endpoints; confirmations retain failures until retried. */
export function useConversationMutations(conversationId: string | undefined, onDeleted: () => void) {
  useLocale();
  const client = useQueryClient();
  const [removeTarget, setRemoveTarget] = useState<{ userId: string; displayName: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<LocalizedMessage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<LocalizedMessage | null>(null);
  const removeMember = async () => {
    if (!conversationId || !removeTarget || removing) return;
    setRemoving(true); setRemoveError(null);
    try {
      await api.delete(`/api/conversations/${conversationId}/members/${removeTarget.userId}`);
      await client.invalidateQueries({ queryKey: ["conversation", conversationId] });
      await refreshConversationList();
      setRemoveTarget(null);
    } catch (error) { setRemoveError(toErrorMessage(error, "couldNotRemoveMember")); }
    finally { setRemoving(false); }
  };
  const deleteConversation = async (exit: ConversationExit) => {
    if (!conversationId || deleting) return;
    setDeleting(true); setDeleteError(null);
    try {
      const path = `/api/conversations/${encodeURIComponent(conversationId)}`;
      await api.delete(exit === "leave" ? `${path}/membership` : `${path}?action=delete`);
      await refreshConversationList();
      useChatStore.getState().removeConversationMessages(conversationId);
      onDeleted();
    } catch (error) { setDeleteError(toErrorMessage(error, "couldNotLeaveConversation")); }
    finally { setDeleting(false); }
  };
  return {
    removeTarget, removing, removeError: removeError ? renderMessage(removeError) : removeError, removeMember,
    requestRemoval: (target: { userId: string; displayName: string }) => { setRemoveError(null); setRemoveTarget(target); },
    cancelRemoval: () => { if (!removing) { setRemoveTarget(null); setRemoveError(null); } },
    deleting, deleteError: deleteError ? renderMessage(deleteError) : deleteError, deleteConversation, clearDeleteError: () => setDeleteError(null),
  };
}
