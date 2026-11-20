import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t, useLocale } from "../i18n/index.js";
import { formatDuration } from "../i18n/format.js";
import { useGroupCall, useRingMembersPicker } from "../features/calls/useGroupCall.js";
import { groupCallErrorTranslation, groupCallExitTranslation } from "../features/calls/group-call-messages.js";
import { useCallPresentation } from "../features/calls/useCallPresentation.js";
import { useMediaElement } from "../features/calls/useMediaElement.js";
import { useObscuringSurface } from "../features/calls/call-surface.js";
import { formatCallClock, useGroupConversation, useSignedInUser, type ConversationWithMembers } from "../features/calls/group-call-view.js";
import { Button, DarkSurface, Icon, IconButton, Notice, Spinner, cx } from "../ui/index.js";
import UserAvatar from "../components/avatar/UserAvatar.js";
import CallPlaybackRecovery from "../components/calls/CallPlaybackRecovery.js";
import GroupCallStage, { isSpotlight, usePhonePortrait } from "../components/calls/group/GroupCallStage.js";
import GroupCallControls from "../components/calls/group/GroupCallControls.js";
import GroupParticipantsSheet from "../components/calls/group/GroupParticipantsSheet.js";
import { useGroupCallEventText } from "../components/calls/group/useGroupCallEventText.js";

type GroupCall = ReturnType<typeof useGroupCall>;

function useElapsed(startedAt: number | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}

function SelfPreview({ call, view, aboveFilmstrip }: { call: GroupCall; view: ReturnType<typeof useCallPresentation>; aboveFilmstrip: boolean }) {
  const session = call.session!;
  const user = useSignedInUser();
  const video = session.room.type === "video";
  const showCamera = video && !session.media.cameraOff;
  const { ref } = useMediaElement<HTMLVideoElement>(showCamera ? session.localStream : null);
  if (call.selfViewHidden) return null;
  const position = `${view.corner.startsWith("top") ? "self-start" : "self-end"} ${view.corner.endsWith("start") ? "justify-self-start" : "justify-self-end"}`;
  // In Spotlight on phones the preview sits over the main tile, never over the filmstrip (spec §2.5).
  return <div data-call-self-preview="" className={cx("pointer-events-none absolute inset-2 z-10 grid sm:inset-4 [@media(max-height:400px)]:hidden", aboveFilmstrip && "bottom-28")}>
    <button type="button" data-corner={view.corner} {...view.previewControls} aria-label={t("callMovePreview")}
      className={`${position} pointer-events-auto relative h-32 w-24 touch-none cursor-grab overflow-hidden rounded-card border border-line bg-sunken shadow-overlay active:cursor-grabbing focus-visible:-outline-offset-4 sm:h-30 sm:w-40`}>
      {showCamera
        ? <video ref={ref} autoPlay muted playsInline aria-label={t("yourVideo")} className="h-full w-full scale-x-[-1] object-cover" />
        : <span className="flex h-full w-full items-center justify-center">{user && <UserAvatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="sm" />}</span>}
      {session.media.muted && <span className="absolute bottom-1 start-1 rounded-control bg-raised p-1"><Icon name="mic-off" size={16} label={t("groupCall.state.muted")} /></span>}
    </button>
  </div>;
}

function WaitingState({ call, conversation, groupName, onAnnounce }: {
  call: GroupCall; conversation: ConversationWithMembers | undefined; groupName: string; onAnnounce: (text: string) => void;
}) {
  const room = call.session!.room;
  const [now, setNow] = useState(Date.now);
  const everJoined = useRef(false);
  const warned = useRef(false);
  if (call.participants.length > 0 || room.participants.length > 1) everJoined.current = true;
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const picker = useRingMembersPicker(conversation ?? { id: room.conversationId, members: [] } as unknown as ConversationWithMembers, room.type);
  const ringing = picker.members.filter((member) => member.stage === "ringing").length;
  const remaining = room.aloneUntil ? Math.max(0, Math.ceil((room.aloneUntil - now) / 1000)) : null;
  useEffect(() => {
    if (remaining !== null && remaining <= 60 && !warned.current) {
      warned.current = true;
      onAnnounce(t("groupCall.aloneEndsIn", { time: formatDuration(60) }));
    }
  }, [remaining !== null && remaining <= 60]);
  return <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
    <div className="rounded-full p-2.5 ring-1 ring-line"><UserAvatar avatarUrl={conversation?.avatarUrl ?? null} displayName={groupName} group size="xl" /></div>
    <h2 className="text-xl font-semibold">{everJoined.current ? t("groupCall.aloneTitle") : t("groupCall.waitingTitle")}</h2>
    <p className="text-ink-muted tabular-nums" aria-live="off">
      {ringing > 0 && !everJoined.current ? t("groupCall.ringingMembers", { count: ringing })
        : remaining !== null ? t("groupCall.aloneEndsIn", { time: formatDuration(Math.max(60, Math.ceil(remaining / 30) * 30)) }) : null}
    </p>
  </div>;
}

function EndedState({ call, groupName }: { call: GroupCall; groupName: string }) {
  const ended = call.ended!;
  const navigate = useNavigate();
  const back = useRef<HTMLButtonElement>(null);
  const conversation = useGroupConversation(ended.room.conversationId);
  const member = conversation?.members.find((item) => item.userId === ended.room.endedBy);
  const message = ended.reason === "ended_for_everyone" && member
    ? t("groupCall.endedByName", { name: member.user.displayName })
    : t(groupCallExitTranslation[ended.reason]);
  useEffect(() => { back.current?.focus(); }, []);
  return <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
    <p className="text-ink-muted">{groupName}</p>
    <h2 role="status" className="text-[1.75rem] leading-tight font-semibold text-balance">{message}</h2>
    <Button ref={back} variant="secondary" className="mt-3" onClick={() => {
      call.actions.dismissEnd();
      // Removed members and deleted groups have no chat to go back to.
      navigate(conversation && ended.reason !== "removed" && ended.reason !== "group_deleted" ? `/chat/${conversation.id}` : "/");
    }}>{t("groupCall.backToChat")}</Button>
  </div>;
}

export default function GroupCallPage() {
  const { locale } = useLocale();
  const call = useGroupCall();
  const session = call.session;
  const room = call.room;
  const conversation = useGroupConversation(room?.conversationId);
  const groupName = conversation?.name ?? t("groupCall.bannerLabel");
  const video = room?.type === "video";
  const live = session?.stage === "live" || session?.stage === "reconnecting";
  const view = useCallPresentation(!!video, !!live);
  const elapsed = useElapsed(session?.room.startedAt);
  const phonePortrait = usePhonePortrait();
  const eventText = useGroupCallEventText(call);
  const [announcement, setAnnouncement] = useState("");
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const participantsButton = useRef<HTMLButtonElement>(null);
  const micButtonFocused = useRef(false);
  useObscuringSurface(!!session || !!call.ended);
  useEffect(() => { document.title = t("groupCall.screenTitle", { group: groupName }); }, [groupName, locale]);
  useEffect(() => { if (eventText) setAnnouncement(eventText); }, [eventText, call.event?.at]);
  // On join, focus the mic button so the first available action is mute (spec §7.1).
  useEffect(() => {
    if (!session || micButtonFocused.current) return;
    micButtonFocused.current = true;
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-call-controls] button")?.focus());
  }, [session]);

  if (!session && !call.ended) return null;
  const people = session ? call.participants.length + 1 : 0;
  const status = !session ? null
    : session.stage === "reconnecting" ? t("callReconnecting")
    : session.stage === "connecting" ? t("connecting")
    : [formatCallClock(elapsed), t("groupCall.peopleCount", { count: people }), session.secureMedia ? t("endToEndEncrypted") : null].filter(Boolean).join(" · ");
  const alone = !!session && (session.stage === "waiting" || call.participants.length === 0);
  const spotlight = !!session && !alone && isSpotlight(call.participants, call.layout, call.pinnedUserId, phonePortrait);
  const hideChrome = video && live && !view.controlsVisible;

  return <DarkSurface data-obscuring-surface="" aria-label={t("groupCall.screenTitle", { group: groupName })} onPointerDown={view.showControls} onKeyDown={view.showControls}
    className="fixed inset-0 z-50 flex h-dvh flex-col bg-canvas text-ink px-safe pb-safe [@media(max-width:319px),(max-height:319px)]:overflow-auto">
    <div data-tauri-drag-region="" aria-hidden="true" className="drag-region h-[var(--titlebar-height)] shrink-0 bg-canvas" />
    {/* One persistent polite region for join/leave/removal events and the alone warning (spec §7.2). */}
    <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
    <header className={cx("flex shrink-0 items-start gap-3 px-4 pt-safe transition-opacity focus-within:pointer-events-auto focus-within:opacity-100",
      hideChrome ? "pointer-events-none opacity-0 sm:pointer-events-auto sm:opacity-100" : "opacity-100")}>
      <div className="min-w-0 grow pt-3">
        <h1 className="truncate text-lg font-semibold">{groupName}</h1>
        {status && <p className="text-sm text-ink-muted tabular-nums" aria-live={session?.stage === "reconnecting" ? "polite" : "off"}>{status}</p>}
        {(session?.quality === "poor" || session?.videoPaused) && <div className="mt-1 flex flex-wrap gap-1">
          {session.quality === "poor" && <span className="inline-flex items-center gap-1 rounded-control bg-warn-soft px-2 py-0.5 text-xs font-semibold text-warn">
            <Icon name="signal" size={16} />{t("groupCall.yourPoorConnection")}</span>}
          {session.videoPaused && <span className="inline-flex items-center rounded-control bg-raised px-2 py-0.5 text-xs text-ink-muted">{t("groupCall.videoPaused")}</span>}
        </div>}
      </div>
      {session && <div className="pt-2"><IconButton icon="chevron-down" label={t("minimizeCall")} variant="secondary" onClick={() => call.actions.minimize()} /></div>}
    </header>

    {/* Reserved event row below the header, so the pill never covers a tile or its pin button. */}
    {session && <div aria-hidden="true" className="flex h-9 shrink-0 items-center justify-center px-4">
      {eventText && <span key={call.event?.at} className="inline-flex max-w-full items-center gap-2 rounded-full bg-raised px-3 py-1 text-sm text-ink-muted animate-ui-fade">
        <Icon name="users" size={16} className="shrink-0" /><span className="truncate">{eventText}</span></span>}
    </div>}

    <main className="relative min-h-0 flex-1">
      {call.ended && !session ? <EndedState call={call} groupName={groupName} />
        : session && <>
          {alone ? <WaitingState call={call} conversation={conversation} groupName={groupName} onAnnounce={setAnnouncement} />
            : <GroupCallStage participants={call.participants} layout={call.layout} spotlightUserId={call.spotlightUserId}
                pinnedUserId={call.pinnedUserId} onPin={(userId) => call.actions.pin(userId)} controlsVisible={view.controlsVisible} />}
          <SelfPreview call={call} view={view} aboveFilmstrip={spotlight && phonePortrait} />
          {session.stage === "connecting" && alone && <div className="absolute inset-x-0 bottom-4 flex justify-center"><Spinner label={t("settingUpEncryptedCall")} /></div>}
        </>}
    </main>

    {session && (session.mediaError || call.error) && <div className="flex shrink-0 flex-col items-center gap-3 px-4 pt-3">
      {session.mediaError && <Notice tone="danger" className="max-w-md">
        {session.mediaError === "microphone" ? t("groupCall.microphoneDenied") : session.mediaError === "screen" ? t("groupCall.screenShareFailed") : t("callCameraPermissionDenied")}
      </Notice>}
      {call.error && <Notice tone="danger" className="max-w-md">{t(groupCallErrorTranslation[call.error])}</Notice>}
    </div>}
    {session && <div className="flex shrink-0 justify-center px-4 pt-3 empty:hidden"><CallPlaybackRecovery /></div>}

    {session && <div data-call-controls="" className={cx(
      "relative flex shrink-0 justify-center px-4 pt-3 pb-8 transition-opacity focus-within:opacity-100 sm:opacity-100 sm:pointer-events-auto",
      "[@media(max-height:400px)]:px-2 [@media(max-height:400px)]:py-2 [@media(max-height:400px)]:opacity-100 [@media(max-height:400px)]:pointer-events-auto",
      view.controlsVisible || !live || !video ? "opacity-100" : "pointer-events-none opacity-0",
    )}>
      <GroupCallControls call={call} session={session} participantsButtonRef={participantsButton} onOpenParticipants={() => setParticipantsOpen(true)} />
    </div>}

    {session && conversation && <GroupParticipantsSheet open={participantsOpen} call={call} conversation={conversation}
      onClose={() => { setParticipantsOpen(false); requestAnimationFrame(() => participantsButton.current?.focus()); }} />}
  </DarkSurface>;
}
