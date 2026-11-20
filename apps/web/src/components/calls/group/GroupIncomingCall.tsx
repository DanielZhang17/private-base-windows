import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useObscuringSurface } from "../../../features/calls/call-surface.js";
import { t, useLocale, type TranslationKey } from "../../../i18n/index.js";
import { useGroupCallInvitation } from "../../../features/calls/useGroupCall.js";
import { groupCallErrorTranslation } from "../../../features/calls/group-call-messages.js";
import { supportsE2EECalling } from "../../../platform/calls.js";
import { groupCallCapacity, groupConversationName, useGroupConversation, useMatchMedia } from "../../../features/calls/group-call-view.js";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, Notice, useToast } from "../../../ui/index.js";
import { OVERLAY_RANK, registerOverlay } from "../../../ui/overlay-stack.js";
import UserAvatar from "../../avatar/UserAvatar.js";

/** Incoming group call (spec §1.2): same placement as the 1:1 sheet, "Join" because the call exists without you. */
export default function GroupIncomingCall() {
  useLocale();
  const { invitation, room, keyReady, actions, notice } = useGroupCallInvitation();
  const conversation = useGroupConversation(invitation?.conversationId ?? notice?.conversationId);
  const [loading, setLoading] = useState<"join" | "camera-off" | "decline" | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const toast = useToast();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const visible = !!invitation;
  const declineRef = useRef<HTMLButtonElement>(null);
  // Phone-sized incoming calls are full-screen: make the app inert and start on Decline (spec §1.2).
  // The desktop card does not steal focus.
  const phone = useMatchMedia("(max-width: 639px)");
  useObscuringSurface(visible && phone);
  useEffect(() => { if (visible && phone) requestAnimationFrame(() => declineRef.current?.focus()); }, [visible, phone, invitation?.callId]);
  useLayoutEffect(() => visible ? registerOverlay({ kind: "modal", rank: OVERLAY_RANK.incomingCall }) : undefined, [visible]);
  useEffect(() => { setError(null); setLoading(null); }, [invitation?.callId, invitation?.ringUntil]);

  // A ring suppressed by an ongoing call, or a quiet start announcement, shows as a non-ringing toast (spec §1.2/§4.3).
  useEffect(() => {
    if (!notice) return;
    if (notice.kind !== "ring" && notice.kind !== "quiet") { actions.clearNotice(); return; }
    // Already looking at that chat: its "Call in progress · Join" banner says the same thing without covering it.
    if (pathname === `/chat/${notice.conversationId}`) { actions.clearNotice(); return; }
    const group = groupConversationName(notice.conversationId) ?? t("groupCall.bannerLabel");
    toast.show({
      message: notice.kind === "quiet" ? t("groupCall.quietNotice", { group }) : t("groupCall.busyToast", { group }),
      action: { label: t("groupCall.openChat"), onClick: () => navigate(`/chat/${notice.conversationId}`) },
    });
    actions.clearNotice();
  }, [notice]);

  if (!invitation) return null;
  const groupName = conversation?.name ?? t("groupCall.bannerLabel");
  const ringer = conversation?.members.find((member) => member.userId === invitation.ringFrom.userId)?.user;
  const ringerName = ringer?.displayName ?? t("groupCall.unknownMember");
  const video = invitation.callType === "video";
  const inCall = room?.participants ?? [];
  const full = !!room && inCall.length >= groupCallCapacity(room.type);
  const unsupported = !supportsE2EECalling();
  const busy = !!loading;

  async function run(kind: "join" | "camera-off" | "decline") {
    if (!invitation) return;
    setLoading(kind); setError(null);
    const result = kind === "decline" ? await actions.decline(invitation) : await actions.joinInvitation(invitation, kind === "camera-off");
    if (!result.ok) { setLoading(null); setError(groupCallErrorTranslation[result.code]); }
  }

  return <section role="dialog" aria-label={t("incomingCall")} data-obscuring-surface={phone ? "" : undefined}
    className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-6 bg-raised px-safe pt-safe pb-safe text-center text-ink shadow-overlay sm:inset-auto sm:top-[calc(var(--safe-top)+var(--titlebar-height)+1rem)] sm:end-4 sm:w-90 sm:rounded-card sm:border sm:border-line sm:p-6">
    <div className="flex flex-col items-center gap-3 p-4">
      <div className="relative rounded-full">
        <UserAvatar avatarUrl={conversation?.avatarUrl ?? null} displayName={groupName} group size="xl" />
        {ringer && <span className="absolute -bottom-1 -end-1 rounded-full ring-2 ring-raised">
          <UserAvatar avatarUrl={ringer.avatarUrl} displayName={ringerName} size="xs" />
        </span>}
      </div>
      <h2 className="text-[1.75rem] leading-tight font-semibold sm:text-xl">{groupName}</h2>
      <p className="text-ink-muted">{video ? t("groupCall.incomingVideo", { name: ringerName }) : t("groupCall.incomingVoice", { name: ringerName })}</p>
      {inCall.length > 1 && <div className="flex items-center gap-2 text-sm text-ink-muted">
        <span className="flex -space-x-2" aria-hidden="true">{inCall.slice(0, 4).map((peer) => {
          const user = conversation?.members.find((member) => member.userId === peer.userId)?.user;
          return user ? <span key={peer.userId} className="rounded-full ring-2 ring-raised"><UserAvatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="xs" /></span> : null;
        })}</span>
        {t("groupCall.inCallCount", { count: inCall.length })}
      </div>}
      {!keyReady && !full && <p role="status" className="text-sm text-ink-muted">{t("preparingSecureCallInvite")}</p>}
    </div>
    {unsupported && <Notice tone="warning">{t("encryptedCallsArenTSupportedOnThisDevice")}</Notice>}
    {full && <Notice tone="info">{t("groupCall.fullError", { max: groupCallCapacity(room!.type) })}</Notice>}
    {error && <Notice tone="danger">{t(error)}</Notice>}
    <div className="flex flex-col items-center gap-2 pb-4">
      <div className="flex gap-4">
        <Button ref={declineRef} variant="danger" leadingIcon="phone-off" size="lg" loading={loading === "decline"} disabled={busy} onClick={() => void run("decline")}>{t("decline")}</Button>
        {!full && <Button leadingIcon={video ? "video" : "phone"} size="lg" className="bg-ok text-on-ok hover:not-disabled:bg-ok disabled:bg-sunken disabled:text-ink-muted disabled:opacity-100"
          loading={loading === "join"} disabled={busy || !keyReady || unsupported} onClick={() => void run("join")}>{t("groupCall.join")}</Button>}
      </div>
      {video && !full && <Button variant="ghost" size="sm" className="disabled:text-ink-muted disabled:opacity-100" loading={loading === "camera-off"} disabled={busy || !keyReady || unsupported}
        onClick={() => void run("camera-off")}>{t("groupCall.joinCameraOff")}</Button>}
    </div>
  </section>;
}
