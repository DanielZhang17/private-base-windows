import { t, useLocale } from "../i18n/index.js";
import { useEffect } from "react";
import { useCallPresentation } from "../features/calls/useCallPresentation.js";
import { useCall } from "../features/calls/useCall.js";
import { useMediaElement } from "../features/calls/useMediaElement.js";
import { Button, DarkSurface, IconButton, Notice, Spinner } from "../ui/index.js";
import UserAvatar from "../components/avatar/UserAvatar.js";
import CallControls from "../components/calls/CallControls.js";
import VideoGrid from "../components/calls/VideoGrid.js";

export default function CallPage() {
  const { locale } = useLocale();
  const call = useCall();
  const connected = call.stage === "connected";
  const ended = call.stage === "ended";
  const video = call.callType === "video";
  const view = useCallPresentation(video, connected);
  useEffect(() => { document.title = t("callPrivateBase", { conversationName: call.conversationName }); }, [call.conversationName, locale]);
  return <DarkSurface onPointerDown={view.showControls} onKeyDown={view.showControls} aria-label={t("callScreenTitle")} className="fixed inset-0 z-50 flex h-dvh flex-col bg-canvas text-ink px-safe pb-safe">
    <div data-tauri-drag-region="" aria-hidden="true" className="drag-region h-[var(--titlebar-height)] shrink-0 bg-canvas" />
    {video && connected && <div className="absolute inset-x-0 bottom-0 top-[var(--titlebar-height)]"><VideoGrid streams={new Map(call.remoteEntries)} /></div>}
    <div className={`relative flex min-h-0 flex-1 flex-col items-center justify-center gap-4 pt-safe text-center ${video && connected ? "justify-start" : ""}`}>
      {!(video && connected) && <div className="rounded-full p-2.5 ring-1 ring-line shadow-[0_0_0_14px_color-mix(in_srgb,var(--primary)_10%,transparent)]"><UserAvatar avatarUrl={call.callerAvatarUrl} displayName={call.conversationName} size="xl" /></div>}
      <div className={video && connected ? "mt-4 rounded-card bg-canvas px-6 py-3" : "px-4"}>
        <h1 className="text-[1.75rem] leading-tight font-semibold">{call.conversationName}</h1>
        <p className="mt-3 text-xl text-ink-muted tabular-nums" aria-live="off">{connected ? call.formatDuration(call.callDuration) : ended ? t("callEnded") : call.stage === "ringing" ? t("calling") : t("connecting")}</p>
        {connected && <p className="mt-1 text-sm text-ink-muted">{t("endToEndEncrypted")}</p>}
      </div>
      {call.callUnsupported ? <Notice tone="warning" className="mx-4 max-w-md">{t("encryptedCallsArenTSupportedOnThisDevice")}</Notice>
        : call.error && <Notice tone="danger" className="mx-4 max-w-md">{call.error}</Notice>}
      {!connected && !ended && !call.callUnsupported && <Spinner label={t("settingUpEncryptedCall")} />}
      {!video && call.remoteEntries.map(([userId, stream]) => <RemoteAudio key={userId} stream={stream} />)}
    </div>
    {video && call.localStream && (!call.isVideoOff || call.isSharingScreen) && <div className="absolute end-4 bottom-[calc(var(--safe-bottom)+7rem)] h-32 w-24 overflow-hidden rounded-card border border-line shadow-overlay sm:h-30 sm:w-40"><video ref={call.localVideoRef} autoPlay muted playsInline aria-label={t("yourVideo")} className="h-full w-full object-cover" /></div>}
    <div className={`relative flex justify-center px-4 pt-6 pb-8 transition-opacity focus-within:opacity-100 sm:opacity-100 sm:pointer-events-auto ${view.controlsVisible || !connected || !video ? "opacity-100" : "pointer-events-none opacity-0"}`}>
      {ended || call.callUnsupported ? <Button variant="secondary" onClick={() => void call.handleEnd()}>{t("backToChat")}</Button> : <CallControls onEnd={() => void call.handleEnd()} isMuted={call.isMuted} isVideoOff={call.isVideoOff} video={video} cameraDisabled={!call.localStream} toggleMute={call.toggleMute} toggleVideo={() => void call.handleToggleVideo()} canShareScreen={call.canShareScreen} isSharingScreen={call.isSharingScreen} toggleScreenShare={() => void call.toggleScreenShare()} />}
    </div>
  </DarkSurface>;
}
function RemoteAudio({ stream }: { stream: MediaStream }) {
  const ref = useMediaElement<HTMLAudioElement>(stream);
  return <audio ref={ref} autoPlay />;
}
