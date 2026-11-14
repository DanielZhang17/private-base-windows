import { renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { useLocale } from "../../i18n/index.js";
import { useState } from "react";
import { api } from "../../services/api.js";
import type { PickerUser } from "./useUserPicker.js";
export function useAddMembers(conversationId: string, onMembersAdded: () => void, onClose: () => void) {
  useLocale();
  const [selectedUsers, setSelectedUsers] = useState<PickerUser[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<LocalizedMessage | null>(null);

  const handleAdd = async () => {
    if (selectedUsers.length === 0) return;

    setAdding(true);
    setError(null);
    try {
      await api.post(`/api/conversations/${conversationId}/members`, {
        userIds: selectedUsers.map((u) => u.id),
      });
      onMembersAdded();
      onClose();
    } catch (err: any) {
      setError(toErrorMessage(err, "failedToAddMembers"));
    } finally {
      setAdding(false);
    }
  };

  return { selectedUsers, setSelectedUsers, adding, error: error ? renderMessage(error) : error, handleAdd };
}
