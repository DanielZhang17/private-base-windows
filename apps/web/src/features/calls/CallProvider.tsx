import { useEffect, useRef, type ReactNode } from "react";
import { useMatch } from "react-router-dom";
import { useOutgoingQueue } from "../chat/useOutgoingQueue.js";
import { useCallStore } from "../../stores/callStore.js";
import { IncomingCallContext } from "./IncomingCallContext.js";
import { useCallInvitationOwner } from "./useCallInvitationOwner.js";
import { useNativeCallNotifications } from "./useNativeCallNotifications.js";
import { CallContext } from "./CallContext.js";
import { useCallSession } from "./useCall.js";
import { useMediaElement } from "./useMediaElement.js";
import CallBubble from "../../components/calls/CallBubble.js";
import IncomingCallModal from "../../components/calls/IncomingCallModal.js";
import { usePushCallInvitation } from "./usePushCallInvitation.js";
import { CallPlaybackProvider } from "./CallPlaybackContext.js";

/** Mounted above Routes for the whole unlocked session, including persistent audio. */
export function CallProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const match = useMatch("/call/:callId");
  const { activeCallId, localCallOwnership, setMinimized, clearAllCalls } = useCallStore();
  // Incoming ringing invitations still belong to the existing incoming-call modal.
  const ownerId = useRef<string | null>(null);
  const lastStage = useRef<string | undefined>(undefined);
  const showingOwnedEnd = !activeCallId && lastStage.current === "ended" && !!ownerId.current && match?.params.callId === ownerId.current;
  if (!enabled || (!activeCallId && !showingOwnedEnd)) ownerId.current = null;
  else if (localCallOwnership?.callId === activeCallId) ownerId.current = activeCallId;
  // Retain an accepted call through its end state, but never own a declined invitation.
  // A reload has no in-memory owner: a stale /call URL must not restart capture.
  const callId = enabled && (activeCallId === ownerId.current || showingOwnedEnd) ? ownerId.current ?? undefined : undefined;
  usePushCallInvitation(enabled, match?.params.callId);
  const invitation = useCallInvitationOwner(enabled);
  const call = useCallSession(callId ?? undefined, invitation.pendingLocalAcceptance, invitation.finishNativeCaptureWait);
  lastStage.current = call.stage;
  useNativeCallNotifications(enabled, invitation.respond);
  const minimized = enabled && !!callId && !match && call.stage !== "ended";
  useEffect(() => { setMinimized(minimized); }, [minimized, setMinimized]);
  useEffect(() => { if (!enabled) clearAllCalls(); }, [enabled, clearAllCalls]);
  return <IncomingCallContext.Provider value={invitation}><CallContext.Provider value={call}><CallPlaybackProvider>
    {children}
    {enabled && <CallQueue />}
    {enabled && match && <IncomingCallModal />}
    {enabled && call.remoteEntries.map(([id, stream]) => <RemoteAudio key={id} stream={stream} />)}
    {minimized && <CallBubble />}
  </CallPlaybackProvider></CallContext.Provider></IncomingCallContext.Provider>;
}

function RemoteAudio({ stream }: { stream: MediaStream }) {
  const { ref } = useMediaElement<HTMLAudioElement>(stream, true);
  return <audio ref={ref} autoPlay />;
}

function CallQueue() {
  useOutgoingQueue();
  return null;
}
