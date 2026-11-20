import { useState } from "react";
import { t, useLocale, type TranslationKey } from "../../../i18n/index.js";
import { useMatchMedia, useSignedInUser, type ConversationWithMembers } from "../../../features/calls/group-call-view.js";
import { useGroupCall, useRingMembersPicker } from "../../../features/calls/useGroupCall.js";
import { groupCallErrorTranslation } from "../../../features/calls/group-call-messages.js";
import { Badge, Button, ConfirmDialog, ListItem, Notice, Sheet } from "../../../ui/index.js";
import UserAvatar from "../../avatar/UserAvatar.js";
import { participantName } from "./GroupCallTile.js";

type GroupCall = ReturnType<typeof useGroupCall>;

const notInCallState: Record<string, TranslationKey> = {
  ringing: "groupCall.state.ringing",
  declined: "groupCall.state.declined",
  no_answer: "groupCall.state.noAnswer",
  left: "groupCall.state.left",
  needs_update: "groupCall.state.needsUpdate",
  timed_out: "groupCall.state.timedOut",
  available: "groupCall.state.available",
};

interface Props {
  open: boolean;
  onClose: () => void;
  call: GroupCall;
  conversation: ConversationWithMembers;
}

/** The one place for roster, re-ring and end-for-everyone (spec §3.3). */
export default function GroupParticipantsSheet({ open, onClose, call, conversation }: Props) {
  useLocale();
  const self = useSignedInUser();
  const session = call.session!;
  const picker = useRingMembersPicker(conversation, session.room.type);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // Side sheet (360 px) on tablets/desktop, bottom sheet capped at 80% height on phones (spec §3.3).
  const phone = useMatchMedia("(max-width: 639px)");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const inCall = call.participants.length + 1;
  const isVideo = session.room.type === "video";
  const notInCall = picker.members.filter((member) => member.stage !== "in_call");
  const roleOf = (userId: string) => conversation.members.find((member) => member.userId === userId)?.role;

  async function ring(userId: string) {
    setBusy(userId); setError(null);
    const result = await call.actions.ring([userId]);
    setBusy(null);
    if (!result.ok) setError(groupCallErrorTranslation[result.code]);
  }

  async function endForEveryone() {
    setBusy("end"); setError(null);
    const result = await call.actions.endForEveryone();
    setBusy(null);
    if (!result.ok) setError(groupCallErrorTranslation[result.code]);
    else setConfirmEnd(false);
  }

  return <>
    <Sheet open={open && !confirmEnd} side={phone ? "bottom" : "end"} className={phone ? "max-h-[80dvh]" : "sm:max-w-90"} onClose={onClose} title={t("groupCall.participantsTitle")} surface="dark"
      footer={call.canEndForEveryone ? <Button variant="danger-ghost" onClick={() => setConfirmEnd(true)}>{t("groupCall.endForEveryone")}</Button> : undefined}>
      {error && <Notice tone="danger" className="mb-3">{t(error)}</Notice>}
      <h3 className="mt-1 mb-1 text-sm font-semibold text-ink-muted">{t("groupCall.inCall", { count: inCall })}</h3>
      <ul role="list" className="-mx-2">
        {self && <li><ListItem leading={<UserAvatar avatarUrl={self.avatarUrl} displayName={self.displayName} size="sm" />}
          title={t("groupCall.selfName", { name: self.displayName })}
          subtitle={[session.media.muted && t("groupCall.state.muted"), isVideo && session.media.cameraOff && t("groupCall.state.cameraOff"),
            session.media.sharing && t("groupCall.state.sharing")].filter(Boolean).join(" · ") || undefined}
          trailing={roleOf(self.id) === "admin" ? <Badge>{t("groupCall.admin")}</Badge> : undefined} /></li>}
        {call.participants.map((participant) => {
          const state = [
            participant.speaking && t("groupCall.state.speaking"),
            participant.media?.muted && t("groupCall.state.muted"),
            isVideo && participant.media?.cameraOff && t("groupCall.state.cameraOff"),
            participant.media?.sharing && t("groupCall.state.sharing"),
            (participant.stage === "reconnecting" || participant.keyWaiting) && t("groupCall.state.reconnecting"),
            participant.quality === "poor" && t("groupCall.poorConnection"),
          ].filter(Boolean).join(" · ");
          return <li key={participant.userId}><ListItem
            leading={<UserAvatar avatarUrl={participant.avatarUrl} displayName={participantName(participant)} size="sm" />}
            title={participantName(participant)} subtitle={state || undefined}
            trailing={participant.role === "admin" ? <Badge>{t("groupCall.admin")}</Badge> : undefined} /></li>;
        })}
      </ul>
      {notInCall.length > 0 && <>
        <h3 className="mt-4 mb-1 text-sm font-semibold text-ink-muted">{t("groupCall.notInCall", { count: notInCall.length })}</h3>
        <ul role="list" className="-mx-2">
          {notInCall.map((member) => {
            const name = member.displayName ?? t("groupCall.unknownMember");
            return <li key={member.userId}><ListItem
              leading={<UserAvatar avatarUrl={member.avatarUrl} displayName={name} size="sm" />}
              title={name} subtitle={t(notInCallState[member.stage] ?? "groupCall.state.available")}
              trailing={member.canRing ? <Button size="sm" variant="secondary" loading={busy === member.userId} disabled={!!busy}
                aria-label={t("groupCall.ringAgain", { name })} onClick={() => void ring(member.userId)}>{t("groupCall.ring")}</Button> : undefined} /></li>;
          })}
        </ul>
      </>}
    </Sheet>
    <ConfirmDialog open={confirmEnd} tone="danger" surface="dark" title={t("groupCall.endConfirmTitle")}
      description={t("groupCall.endConfirmBody", { count: inCall })} confirmLabel={t("groupCall.endConfirm")}
      busy={busy === "end"} error={error ? t(error) : undefined}
      onCancel={() => { setConfirmEnd(false); setError(null); }} onConfirm={() => void endForEveryone()} />
  </>;
}
