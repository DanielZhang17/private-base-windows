import { t, useLocale } from "../../i18n/index.js";
import { useCall } from "../../features/calls/useCall.js";
import { useCallBubblePosition } from "../../features/calls/useCallBubblePosition.js";
import { useMediaElement } from "../../features/calls/useMediaElement.js";
import { IconButton } from "../../ui/index.js";
import CallPlaybackRecovery from "./CallPlaybackRecovery.js";
import UserAvatar from "../avatar/UserAvatar.js";

export default function CallBubble() {
  useLocale();
  const call = useCall();
  const drag = useCallBubblePosition();
  const video = call.callType === "video";
  const duration = call.stage === "reconnecting" ? t("callReconnecting") : call.formatDuration(call.callDuration);
  const { ref } = useMediaElement<HTMLVideoElement>(call.remoteEntries[0]?.[1] ?? null, video);
  return <div ref={drag.boundsRef} className="call-bubble-bounds pointer-events-none fixed">
    <div className="pointer-events-none absolute inset-0" style={drag.areaStyle}>
    <div ref={drag.bubbleRef} className={`call-bubble pointer-events-auto absolute flex flex-col overflow-hidden rounded-card border border-line-strong bg-raised text-ink shadow-overlay ${drag.snapping ? "call-bubble-snapping" : ""}`}
      style={drag.position ? { left: drag.position.x, top: drag.position.y } : undefined}>
      <button type="button" {...drag.dragProps} aria-label={t("ongoingCallReturn", { name: call.peerName, duration })}
        onClick={(event) => { if (drag.shouldExpand(event.detail)) call.restoreCall(); }}
        className="relative flex min-h-0 flex-1 touch-none cursor-grab flex-col items-center justify-center gap-2 overflow-hidden active:cursor-grabbing focus-visible:-outline-offset-4">
        {video ? <video ref={ref} autoPlay muted playsInline aria-hidden="true" className="absolute inset-0 h-full w-full bg-sunken object-cover" />
          : <UserAvatar avatarUrl={call.peerAvatarUrl} displayName={call.peerName} group={call.isGroupCall} size="lg" />}
        <span className={`max-w-full px-3 text-sm font-semibold truncate ${video ? "relative rounded-control bg-raised py-1" : ""}`}>{call.peerName}</span>
        <span aria-live={call.stage === "reconnecting" ? "polite" : "off"} className={`tabular-nums text-sm ${video ? "relative rounded-control bg-raised px-2 py-1" : "text-ink-muted"}`}>{duration}</span>
      </button>
      <div className="call-bubble-actions flex shrink-0 flex-wrap content-start justify-center gap-2 overflow-y-auto overscroll-y-contain border-t border-line bg-raised p-1">
        <IconButton icon="phone-off" label={t("endCall")} variant="danger" onClick={call.handleEnd} />
        <CallPlaybackRecovery compact />
        <IconButton icon={call.isMuted ? "mic-off" : "mic"} label={call.isMuted ? t("unmuteMicrophone") : t("muteMicrophone")} aria-pressed={call.isMuted} variant="secondary" onClick={call.toggleMute} />
        {video && !call.isVideoOff && <IconButton icon="video" label={t("turnOffCamera")} variant="secondary" onClick={call.handleToggleVideo} />}
        {video && call.isSharingScreen && <IconButton icon="monitor" label={t("stopSharingScreen")} variant="secondary" onClick={call.toggleScreenShare} />}
      </div>
    </div>
    </div>
  </div>;
}
