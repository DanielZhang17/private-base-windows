import { t, useLocale } from "../../i18n/index.js";
import { useUserPicker, type PickerUser } from "../../features/chat/useUserPicker.js";
import { Icon, IconButton, Input, ListItem, Spinner } from "../../ui/index.js";
import UserAvatar from "../avatar/UserAvatar.js";
export type { PickerUser } from "../../features/chat/useUserPicker.js";

interface UserPickerProps {
  selectedUsers: PickerUser[];
  onSelectionChange: (users: PickerUser[]) => void;
  excludeUserIds?: Set<string>;
  placeholder?: string;
}
export default function UserPicker({ selectedUsers, onSelectionChange, excludeUserIds, placeholder = t("searchContacts") }: UserPickerProps) {
  useLocale();
  const { query, setQuery, results, loading, selectedIds, toggleUser, removeUser } = useUserPicker(selectedUsers, onSelectionChange, excludeUserIds);
  return <div className="space-y-3">
    {selectedUsers.length > 0 && <div className="flex flex-wrap gap-2">{selectedUsers.map((user) => <span key={user.id} className="inline-flex items-center rounded-control bg-brand-soft ps-3 text-sm text-on-brand-soft">{user.displayName}<IconButton icon="close" label={t("removeMemberNamed", { displayName: user.displayName })} onClick={() => removeUser(user.id)} /></span>)}</div>}
    <Input aria-label={t("searchContacts2")} leading={<Icon name="search" size={18} />} trailing={loading ? <Spinner label={t("searchingContacts")} /> : undefined} placeholder={placeholder} value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
    <div className="max-h-60 overflow-y-auto rounded-control border border-line">
      {results.length === 0 ? <p className="p-4 text-center text-sm text-ink-muted">{query.trim().length >= 2 ? t("noUsersFound") : t("typeToSearchOrBrowseContacts")}</p>
        : <ul className="p-1">{results.map((user) => <li key={user.id}><ListItem leading={<UserAvatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="sm" />} title={user.displayName} subtitle={`@${user.username}`} selected={selectedIds.has(user.id)} onClick={() => toggleUser(user)} trailing={selectedIds.has(user.id) && <Icon name="check" label={t("selectedItemStatus")} className="text-brand" />} /></li>)}</ul>}
    </div>
  </div>;
}
