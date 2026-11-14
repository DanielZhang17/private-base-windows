import { useMemo, useState } from "react";
import { useAuthStore } from "../../stores/authStore.js";
import { useUserSearch } from "../../hooks/useUserSearch.js";
import type { Contact } from "../../hooks/useContacts.js";
export type PickerUser = Contact;
export function useUserPicker(selectedUsers: PickerUser[], onSelectionChange: (users: PickerUser[]) => void, excludeUserIds?: Set<string>) {
  const [query, setQuery] = useState("");
  const currentUserId = useAuthStore((state) => state.user?.id);

  const allExcluded = useMemo(() => {
    const ids = new Set(excludeUserIds);
    if (currentUserId) ids.add(currentUserId);
    return ids;
  }, [excludeUserIds, currentUserId]);

  const { results, loading } = useUserSearch(query, allExcluded);

  const selectedIds = useMemo(
    () => new Set(selectedUsers.map((u) => u.id)),
    [selectedUsers],
  );

  const toggleUser = (user: PickerUser) => {
    if (selectedIds.has(user.id)) {
      onSelectionChange(selectedUsers.filter((u) => u.id !== user.id));
    } else {
      onSelectionChange([...selectedUsers, user]);
    }
  };

  const removeUser = (userId: string) => {
    onSelectionChange(selectedUsers.filter((u) => u.id !== userId));
  };

  return { query, setQuery, results, loading, selectedIds, toggleUser, removeUser };
}
