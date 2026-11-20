import { useEffect, useId, useState } from "react";
import { formatCallClock, type CallType, type ConversationWithMembers } from "../../../features/calls/group-call-view.js";
import { t, useLocale, type TranslationKey } from "../../../i18n/index.js";
import { useGroupCallBanner, useRingMembersPicker } from "../../../features/calls/useGroupCall.js";
import { Button, Dialog, Icon, IconButton, Notice, Spinner, cx } from "../../../ui/index.js";
import UserAvatar from "../../avatar/UserAvatar.js";

type Banner = ReturnType<typeof useGroupCallBanner>;

/** TopBar voice/video buttons for group conversations (spec §1.1). Hidden when the rollout switch is off. */
export function GroupCallTopBarActions({ conversation, banner, onStart }: {
  conversation: ConversationWithMembers; banner: Banner; onStart: (type: CallType) => void;
}) {
  useLocale();
  const reasonId = useId();
  const { state } = banner;
  if (state === "hidden" || state === "loading") return null;
  // An active call replaces the start buttons with the banner's Join (no second call per group).
  if (state !== "start" && state !== "needs_members" && state !== "timed_out" && state !== "unsupported") return null;
  const reason = state === "needs_members" ? t("groupCall.needsMembers")
    : state === "timed_out" ? t("groupCall.timedOut", { time: banner.timedOutUntil ? new Date(banner.timedOutUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "" })
    : state === "unsupported" ? t("encryptedCallsArenTSupportedOnThisDevice") : null;
  const disabled = !!reason;
  return <>
    {reason && <span id={reasonId} className="sr-only">{reason}</span>}
    {(["audio", "video"] as const).map((type) => <IconButton key={type} icon={type === "audio" ? "phone" : "video"}
      label={type === "audio" ? t("startAudioCall") : t("startVideoCall")} title={reason ?? undefined}
      aria-disabled={disabled || undefined} aria-describedby={reason ? reasonId : undefined}
      className={cx(disabled && "opacity-50")} data-conversation={conversation.id}
      onClick={() => { if (!disabled) onStart(type); }} />)}
  </>;
}

/** "Call in progress · N people · Join" below the TopBar (spec §1.4). */
export function GroupCallBanner({ conversation, banner, onJoin, onReturn }: {
  conversation: ConversationWithMembers; banner: Banner; onJoin: () => void; onReturn: () => void;
}) {
  useLocale();
  const metaId = useId();
  const { state, room } = banner;
  if (!room || state === "hidden" || state === "loading" || state === "start" || state === "needs_members") return null;
  const video = room.type === "video";
  const count = room.participants.length;
  const duration = formatCallClock(banner.elapsedSeconds);
  const starter = conversation.members.find((member) => member.userId === room.initiatorId)?.user.displayName ?? t("groupCall.unknownMember");
  const muted = state === "full" || state === "timed_out" || state === "unsupported";
  const title = state === "return" ? t("groupCall.bannerYou")
    : state === "join_here" ? t("groupCall.bannerOtherDevice")
    : state === "full" ? t("groupCall.full")
    : state === "waiting" ? t("groupCall.bannerWaiting", { name: starter })
    : video ? t("groupCall.bannerActiveVideo") : t("groupCall.bannerActive");
  const meta = state === "full" ? t("groupCall.fullMeta", { count, max: banner.maxParticipants ?? count })
    : state === "timed_out" ? t("groupCall.bannerTimedOut", { time: formatCallClock(Math.max(0, Math.ceil(((banner.timedOutUntil ?? 0) - Date.now()) / 1000))) })
    : state === "unsupported" ? t("groupCall.bannerUnsupported")
    : state === "return" || state === "waiting" ? duration
    : t("groupCall.bannerMeta", { count, duration });
  const avatars = room.participants.slice(0, 4).map((participant) => conversation.members.find((member) => member.userId === participant.userId)?.user)
    .filter((user): user is NonNullable<typeof user> => !!user);

  return <section role="region" aria-label={t("groupCall.bannerLabel")}
    className={cx("flex min-h-13 shrink-0 items-center gap-3 border-b border-line px-4 py-3",
      muted ? "bg-sunken text-ink-muted" : "bg-brand-soft text-on-brand-soft")}>
    <Icon name={video ? "video" : "phone"} size={20} className="shrink-0" />
    <div className="min-w-0 grow">
      <p className="text-sm font-semibold text-balance sm:truncate">{title}</p>
      <p id={metaId} className="text-sm tabular-nums opacity-90 sm:truncate" aria-live="off">{meta}</p>
    </div>
    {avatars.length > 0 && <div className="hidden shrink-0 -space-x-2 sm:flex" aria-hidden="true">
      {avatars.map((user, index) => <span key={index} className="rounded-full ring-2 ring-brand-soft">
        <UserAvatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="xs" /></span>)}
    </div>}
    {state === "return" ? <Button size="sm" variant="secondary" onClick={onReturn}>{t("groupCall.return")}</Button>
      : state === "join_here" ? <Button size="sm" variant="secondary" onClick={onJoin}>{t("groupCall.joinHere")}</Button>
      : state === "unsupported" ? null
      : <Button size="sm" className={cx("shrink-0", muted ? "bg-sunken text-ink-muted" : "bg-ok text-on-ok hover:not-disabled:bg-ok")}
          aria-disabled={muted || undefined} aria-describedby={muted ? metaId : undefined}
          onClick={() => { if (!muted) onJoin(); }}>{t("groupCall.join")}</Button>}
  </section>;
}

/** "Who should we ring?" (PM decision: the caller picks who to ring). */
export function RingMembersDialog({ open, conversation, type, onClose, onStart }: {
  open: boolean; conversation: ConversationWithMembers; type: CallType; onClose: () => void;
  onStart: (ringUserIds: string[]) => Promise<TranslationKey | null>;
}) {
  useLocale();
  const picker = useRingMembersPicker(conversation, type);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [initialised, setInitialised] = useState(false);
  useEffect(() => { if (!open) { setInitialised(false); setError(null); setStarting(false); } }, [open]);
  useEffect(() => {
    if (!open || initialised || picker.loading) return;
    setSelected(new Set(picker.defaultSelectedUserIds));
    setInitialised(true);
  }, [open, initialised, picker.loading, picker.defaultSelectedUserIds.join(",")]);
  const eligible = picker.members.filter((member) => member.canRing);
  const atLimit = selected.size >= picker.maxSelections;
  const toggle = (userId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(userId)) next.delete(userId); else if (next.size < picker.maxSelections) next.add(userId);
    return next;
  });

  async function start() {
    setStarting(true); setError(null);
    const failure = await onStart([...selected]);
    setStarting(false);
    if (failure) setError(failure); else onClose();
  }

  const stateLabel = (stage: string): TranslationKey => stage === "needs_update" ? "groupCall.state.needsUpdate"
    : stage === "timed_out" ? "groupCall.state.timedOut" : stage === "ringing" ? "groupCall.state.ringing" : "groupCall.state.available";

  return <Dialog open={open} onClose={onClose} title={t("groupCall.ringTitle")} description={t("groupCall.ringDescription", { count: picker.maxSelections })}
    footer={<>
      <Button variant="secondary" onClick={onClose} disabled={starting}>{t("cancel")}</Button>
      <Button leadingIcon={type === "video" ? "video" : "phone"} loading={starting} disabled={picker.loading} onClick={() => void start()}>
        {selected.size === 0 ? t("groupCall.ringStartQuietly") : type === "video" ? t("groupCall.ringStartVideo") : t("groupCall.ringStartVoice")}
      </Button>
    </>}>
    {picker.loading ? <div className="py-6 text-center"><Spinner label={t("groupCall.loadingMembers")} /></div> : <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-sm text-ink-muted" aria-live="polite">{t("groupCall.ringSelected", { count: selected.size })}</p>
        {eligible.length > 0 && (selected.size > 0 || eligible.length <= picker.maxSelections) && <Button variant="ghost" size="sm" onClick={() => setSelected(selected.size ? new Set() : new Set(eligible.slice(0, picker.maxSelections).map((member) => member.userId)))}>
          {selected.size ? t("groupCall.ringSelectNone") : t("groupCall.ringSelectAll")}</Button>}
      </div>
      {atLimit && eligible.length > selected.size && <Notice tone="info" className="mb-2">{t("groupCall.ringLimit", { max: picker.maxSelections })}</Notice>}
      {error && <Notice tone="danger" className="mb-2">{t(error)}</Notice>}
      <ul role="list" className="-mx-2">
        {picker.members.map((member) => {
          const name = member.displayName ?? t("groupCall.unknownMember");
          const checked = selected.has(member.userId);
          const disabled = !member.canRing || (!checked && atLimit);
          return <li key={member.userId}>
            <label className={cx("flex min-h-14 items-center gap-3 rounded-control px-2 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand",
              disabled ? "opacity-60" : "cursor-pointer hover:bg-sunken")}>
              <UserAvatar avatarUrl={member.avatarUrl ?? null} displayName={name} size="sm" />
              <span className="min-w-0 grow">
                <span className="block truncate font-semibold">{name}</span>
                {!member.canRing && <span className="block truncate text-sm text-ink-muted">{t(stateLabel(member.stage))}</span>}
              </span>
              <input type="checkbox" className="size-5 accent-brand" checked={checked} disabled={disabled} onChange={() => toggle(member.userId)} />
            </label>
          </li>;
        })}
      </ul>
    </>}
  </Dialog>;
}


type TimelineEvent = Banner["timeline"][number];

/** Centred system lines for group calls in the chat timeline (spec §1.6); no per-join/leave lines. */
export function GroupCallTimelineLines({ events, conversation, after, before }: {
  events: TimelineEvent[]; conversation: ConversationWithMembers; after: number; before: number;
}) {
  useLocale();
  const lines: { key: string; at: number; text: string }[] = [];
  for (const event of events) {
    const starter = conversation.members.find((member) => member.userId === event.initiatorId)?.user.displayName ?? t("groupCall.unknownMember");
    lines.push({ key: `${event.callId}:start`, at: event.startedAt,
      text: event.type === "video" ? t("groupCall.eventStartedVideo", { name: starter }) : t("groupCall.eventStarted", { name: starter }) });
    if (event.missed) lines.push({ key: `${event.callId}:missed`, at: event.startedAt + 1, text: t("groupCall.eventMissed") });
    if (event.endedAt) lines.push({ key: `${event.callId}:end`, at: event.endedAt,
      text: t("groupCall.eventEnded", { duration: formatCallClock((event.endedAt - event.startedAt) / 1000) }) });
  }
  const visible = lines.filter((line) => line.at > after && line.at <= before).sort((first, second) => first.at - second.at);
  if (!visible.length) return null;
  return <>{visible.map((line) => <p key={line.key} className="flex items-center justify-center gap-1.5 py-1.5 text-center text-[0.8125rem] text-ink-muted">
    <Icon name="phone" size={14} className="shrink-0" />{line.text}</p>)}</>;
}
