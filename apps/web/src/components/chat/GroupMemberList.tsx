import { useState } from "react";
import type { GroupMember, useGroupModeration } from "../../features/chat/useGroupModeration.js";
import { t } from "../../i18n/index.js";
import { renderMessage } from "../../i18n/messages.js";
import { Button, IconButton, ListItem, Notice } from "../../ui/index.js";
import UserAvatar from "../avatar/UserAvatar.js";

export function GroupMemberList({ members, viewerId, isAdmin, moderation, onRemove }: {
  members: GroupMember[];
  viewerId: string | undefined;
  isAdmin: boolean;
  moderation: ReturnType<typeof useGroupModeration>;
  onRemove: (member: GroupMember) => void;
}) {
  const [expanded, setExpanded] = useState<string>();
  return <>
    {moderation.error && <Notice tone="danger">{renderMessage(moderation.error)}</Notice>}
    <ul>{members.map((member) => {
      const { userId, role, acceptedAt, timedOutUntil, user } = member;
      const self = userId === viewerId;
      const admin = role === "admin";
      const timedOut = moderation.isTimedOut(timedOutUntil);
      const actions = isAdmin && (!self || acceptedAt != null);
      const open = actions && expanded === userId;
      const lastAdmin = admin && moderation.acceptedAdmins <= 1;
      return <li key={userId}>
        <ListItem
          leading={<UserAvatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="sm" />}
          title={user.displayName} subtitle={`@${user.username}`}
          meta={admin ? t("admin") : timedOut ? t("groupMemberTimedOut") : undefined}
          trailing={actions && <IconButton icon="more" label={t("groupMemberActions", { name: user.displayName })}
            aria-expanded={open} onClick={() => setExpanded(open ? undefined : userId)} />}
        />
        {open && <div className="mb-2 flex flex-wrap gap-1 px-3">
          {acceptedAt != null && <Button variant="secondary" size="sm" disabled={moderation.updating || lastAdmin}
            onClick={() => moderation.updateMember(userId, { role: admin ? "member" : "admin" })}>
            {t(admin ? "groupRemoveAdmin" : "groupMakeAdmin")}
          </Button>}
          {lastAdmin && acceptedAt != null && <p className="w-full text-xs text-ink-muted">{t("groupLastAdmin")}</p>}
          {!self && !admin && acceptedAt != null && (timedOut
            ? <Button variant="secondary" size="sm" disabled={moderation.updating} onClick={() => moderation.updateMember(userId, { timeoutSeconds: null })}>{t("groupClearTimeout")}</Button>
            : <>
              <Button variant="secondary" size="sm" disabled={moderation.updating} onClick={() => moderation.updateMember(userId, { timeoutSeconds: 600 })}>{t("groupTimeoutTenMinutes")}</Button>
              <Button variant="secondary" size="sm" disabled={moderation.updating} onClick={() => moderation.updateMember(userId, { timeoutSeconds: 3600 })}>{t("groupTimeoutOneHour")}</Button>
            </>)}
          {!self && <Button variant="danger-ghost" size="sm" disabled={moderation.updating}
            aria-label={t("removeMemberNamed", { displayName: user.displayName })} onClick={() => onRemove(member)}>{t("removeMemberAction")}</Button>}
        </div>}
      </li>;
    })}</ul>
  </>;
}
