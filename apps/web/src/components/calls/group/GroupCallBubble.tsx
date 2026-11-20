import { useEffect, useState } from "react";
import { t, useLocale } from "../../../i18n/index.js";
import { useGroupCall } from "../../../features/calls/useGroupCall.js";
import { useCallBubblePosition } from "../../../features/calls/useCallBubblePosition.js";
import { useMediaElement } from "../../../features/calls/useMediaElement.js";
import { formatCallClock, useGroupConversation } from "../../../features/calls/group-call-view.js";
import { IconButton } from "../../../ui/index.js";
import CallPlaybackRecovery from "../CallPlaybackRecovery.js";
import UserAvatar from "../../avatar/UserAvatar.js";
import { participantName } from "./GroupCallTile.js";
import { useGroupCallEventText } from "./useGroupCallEventText.js";

/** Minimised group call (spec §4.1): active speaker's video or the group avatar, "4 people · 12:34". */
export default function GroupCallBubble() {
  useLocale();
  const call = useGroupCall();
  const drag = useCallBubblePosition();
  const session = call.session!;
  const conversation = useGroupConversation(session.room.conversationId);
  const groupName = conversation?.name ?? t("groupCall.bannerLabel");
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const duration = formatCallClock((now - session.room.startedAt) / 1000);
  const featured = call.participants.find((participant) => participant.userId === call.spotlightUserId);
  const video = session.room.type === "video" && !!featured?.stream && featured.media?.cameraOff === false && featured.stage === "live";
  const { ref } = useMediaElement<HTMLVideoElement>(video ? featured!.stream : null, true);
  const people = call.participants.length + 1;
  const eventText = useGroupCallEventText(call);
  const alone = call.participants.length === 0;
  const meta = session.stage === "reconnecting" ? t("callReconnecting") : alone ? t("groupCall.bubbleWaiting") : t("groupCall.bubbleMeta", { count: people, duration });
  return <div ref={drag.boundsRef} className="call-bubble-bounds pointer-events-none fixed">
    <div role="status" aria-live="polite" className="sr-only">{eventText}</div>
    <div className="pointer-events-none absolute inset-0" style={drag.areaStyle}>
      <div ref={drag.bubbleRef} className={`call-bubble pointer-events-auto absolute flex flex-col overflow-hidden rounded-card border border-line-strong bg-raised text-ink shadow-overlay ${drag.snapping ? "call-bubble-snapping" : ""}`}
        style={drag.position ? { left: drag.position.x, top: drag.position.y } : undefined}>
        <button type="button" {...drag.dragProps}
          aria-label={t("groupCall.bubbleReturn", { group: groupName, people: t("groupCall.peopleCount", { count: people }), duration })}
          onClick={(event) => { if (drag.shouldExpand(event.detail)) call.actions.restore(); }}
          className="relative flex min-h-0 flex-1 touch-none cursor-grab flex-col items-center justify-center gap-2 overflow-hidden active:cursor-grabbing focus-visible:-outline-offset-4">
          {video ? <video ref={ref} autoPlay muted playsInline aria-hidden="true" className="absolute inset-0 h-full w-full bg-sunken object-cover" />
            : <UserAvatar avatarUrl={conversation?.avatarUrl ?? null} displayName={groupName} group size="lg" />}
          <span className={`max-w-full px-3 text-sm font-semibold truncate ${video ? "relative rounded-control bg-raised py-1" : ""}`}>
            {video && featured ? participantName(featured) : groupName}</span>
          <span aria-live={session.stage === "reconnecting" ? "polite" : "off"}
            className={`tabular-nums text-sm ${video ? "relative rounded-control bg-raised px-2 py-1" : "text-ink-muted"}`}>{meta}</span>
        </button>
        <div className="call-bubble-actions flex shrink-0 flex-wrap content-start justify-center gap-2 overflow-y-auto overscroll-y-contain border-t border-line bg-raised p-1">
          <IconButton icon="phone-off" label={t("groupCall.leave")} variant="danger" onClick={() => void call.actions.leave()} />
          <CallPlaybackRecovery compact />
          <IconButton icon={session.media.muted ? "mic-off" : "mic"} label={session.media.muted ? t("unmuteMicrophone") : t("muteMicrophone")}
            aria-pressed={session.media.muted} variant="secondary" onClick={() => call.actions.toggleMute()} />
          {session.room.type === "video" && !session.media.cameraOff && <IconButton icon="video" label={t("turnOffCamera")} variant="secondary" onClick={() => void call.actions.toggleCamera()} />}
          {session.media.sharing && <IconButton icon="monitor" label={t("stopSharingScreen")} variant="secondary" onClick={() => void call.actions.toggleScreenShare()} />}
        </div>
      </div>
    </div>
  </div>;
}
