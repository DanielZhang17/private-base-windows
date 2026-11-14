import { t, useLocale } from "../../i18n/index.js";
import { useAddMembers } from "../../features/chat/useAddMembers.js";
import { Button, Dialog, Notice } from "../../ui/index.js";
import UserPicker from "./UserPicker.js";
interface Props { conversationId: string; existingMemberIds: Set<string>; onClose: () => void; onMembersAdded: () => void }
export default function AddMembersModal({ conversationId, existingMemberIds, onClose, onMembersAdded }: Props) {
  useLocale();
  const { selectedUsers, setSelectedUsers, adding, error, handleAdd } = useAddMembers(conversationId, onMembersAdded, onClose);
  return <Dialog open onClose={onClose} dismissible={!adding} title={t("addConversationMembers")} footer={<><Button variant="secondary" onClick={onClose} disabled={adding}>{t("cancel")}</Button><Button onClick={() => void handleAdd()} loading={adding} disabled={!selectedUsers.length}>{selectedUsers.length ? t("addSelectedMembers", { count: selectedUsers.length }) : t("addMembersAction")}</Button></>}>
    {error && <Notice tone="danger" className="mb-3">{error}</Notice>}
    <UserPicker selectedUsers={selectedUsers} onSelectionChange={setSelectedUsers} excludeUserIds={existingMemberIds} placeholder={t("searchUsersToAdd")} />
  </Dialog>;
}
