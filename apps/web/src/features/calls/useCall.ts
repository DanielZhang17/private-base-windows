import { localized, renderMessage, LocalizedError, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { t, useLocale } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useToast } from "../../ui/index.js";
import type { ConversationWithMembers, GetCallResponse, WSSignalFrame } from "@e2ee-chat/shared";
import { WSFrameType } from "@e2ee-chat/shared";
import { fromBase64Url } from "@e2ee-chat/crypto";
import { useCallStore } from "../../stores/callStore.js";
import { useAuthStore } from "../../stores/authStore.js";

import { cleanupCallBestEffort } from "../../services/call-cleanup.js";
import { api, resolveWsBaseUrl } from "../../services/api.js";
import {
  addSenderTransform,
  attachLocalTracks,
  createPeerConnection,
  acceptCallOffer,
  deriveCallKey,
  disposeCallTransforms,
  supportsE2EECalling,
  sendSignal,
  type CallFrameKey,
} from "../../services/webrtc.js";
import { deletePendingCall, getPendingCall } from "../../db/index.js";
import { syncMessages } from "../../lib/message-sync.js";
import { captureUserMedia, captureDisplayMedia } from "../../platform/media.js";
import { E2EECallUnsupportedError } from "../../platform/calls.js";
import type { PendingLocalAcceptance } from "./useCallInvitationOwner.js";
import { isSameSession } from "../../services/session-identity.js";

type Stage = "loading" | "ringing" | "connecting" | "connected" | "ended";

function conversationDisplayName(conversation: ConversationWithMembers | null, localUserId: string | undefined): string {
  if (!conversation) return t("callScreenTitle");
  if (conversation.name) return conversation.name;
  return conversation.members
    .filter((member) => member.userId !== localUserId)
    .map((member) => member.user.displayName)
    .join(", ");
}

export function useCallSession(callId: string | undefined, pendingAcceptance: PendingLocalAcceptance | null = null,
  finishNativeCaptureWait?: (callId: string, epoch: number) => void) {
  const nativeAcceptanceRef = useRef(pendingAcceptance);
  nativeAcceptanceRef.current = pendingAcceptance;
  const finishCaptureWaitRef = useRef(finishNativeCaptureWait);
  finishCaptureWaitRef.current = finishNativeCaptureWait;
  useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const toast = useToast();
  const user = useAuthStore((state) => state.user);
  const userId = user?.id;
  const deviceId = useAuthStore((state) => state.device?.id);
  const sessionId = useAuthStore((state) => state.sessionId);
  const legacyEpoch = useAuthStore((state) => !state.sessionId && !state.device?.id ? state.authEpoch : undefined);
  const sessionEpochRef = useRef(0);
  const callAuthRef = useRef(useAuthStore.getState());
  const localCallEpochRef = useRef(useCallStore.getState().localCallEpoch);
  const currentCallIdRef = useRef(callId);
  currentCallIdRef.current = callId;
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const {
    callType,
    callStatus,
    localCallOwnership,
    releaseCallOwnership,
    conversationName: storedConversationName,
    localStream,
    remoteStreams,
    isMuted,
    isVideoOff,
    setMinimized,
    setLocalStream,
    addRemoteStream,
    hydrateCall,
    clearCall,
    clearAllCalls,
    toggleMute,
    toggleVideo,
  } = useCallStore();

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const callKeyRef = useRef<CallFrameKey | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const acquiredTracks = useRef(new Set<MediaStreamTrack>());
  const rememberStream = (stream: MediaStream) => {
    const muted = useCallStore.getState().isMuted;
    stream.getTracks().forEach((track) => {
      // Capture may resolve after the user muted, before a local stream existed.
      if (track.kind === "audio") track.enabled = !muted;
      acquiredTracks.current.add(track);
    });
  };
  const stopAcquiredTracks = () => {
    acquiredTracks.current.forEach((track) => track.stop());
    acquiredTracks.current.clear();
  };
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const setupStartedRef = useRef(false);
  const endingRef = useRef(false);
  const endHandledRef = useRef(false);
  const connectingTimeoutCleanupRef = useRef<(() => void) | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [stateCallId, setStateCallId] = useState<string>();
  const [callInfo, setCallInfo] = useState<GetCallResponse | null>(null);
  const [conversation, setConversation] = useState<ConversationWithMembers | null>(null);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [callUnsupported, setCallUnsupported] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const durationTimerRef = useRef<number | null>(null);
  const canShareScreen = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";

  const conversationName = conversation
    ? conversationDisplayName(conversation, userId)
    : storedConversationName ?? t("callScreenTitle");
  // Presentation identity is independent of who initiated the call.
  const isGroupCall = conversation?.type === "group";
  const peer = conversation?.members.find((member) => member.userId !== userId)?.user;
  const peerName = isGroupCall ? conversationName : peer?.displayName ?? conversationName;
  const peerAvatarUrl = isGroupCall ? conversation?.avatarUrl ?? null : peer?.avatarUrl ?? null;

  const isCurrentEpoch = (epoch: number) => {
    const auth = useAuthStore.getState();
    return mountedRef.current && sessionEpochRef.current === epoch && currentCallIdRef.current === callId &&
      auth.user?.id === callAuthRef.current.user?.id && auth.device?.id === callAuthRef.current.device?.id &&
      isSameSession(callAuthRef.current, auth);
  };
  const isRunningSession = (epoch: number) => {
    const current = useCallStore.getState();
    return isCurrentEpoch(epoch) && current.localCallEpoch === localCallEpochRef.current && !endingRef.current && !!callId &&
      current.activeCallId === callId && current.localCallOwnership?.callId === callId &&
      (current.callStatus === "ringing" || current.callStatus === "active") &&
      useAuthStore.getState().user?.id === userId;
  };

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  useEffect(() => {
    const epoch = sessionEpochRef.current;
    if (stage === "connected") {
      durationTimerRef.current = window.setInterval(() => {
        if (isRunningSession(epoch)) setCallDuration((d) => isRunningSession(epoch) ? d + 1 : d);
      }, 1000);
    } else if (stage !== "ended") {
      setCallDuration(0);
    }
    return () => {
      if (durationTimerRef.current) {
        window.clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
    };
  }, [stage, callId]);

  // The provider stays mounted across routes and calls. Reset per-call UI/refs here.
  useEffect(() => {
    callAuthRef.current = useAuthStore.getState();
    localCallEpochRef.current = useCallStore.getState().localCallEpoch;
    endingRef.current = false;
    endHandledRef.current = false;
    setupStartedRef.current = false;
    callKeyRef.current = null;
    setStateCallId(callId);
    setCallInfo(null);
    setConversation(null);
    setError(null);
    setCallUnsupported(false);
    setCallDuration(0);
    setIsSharingScreen(false);
    setStage("loading");
    return () => {
      sessionEpochRef.current += 1;
      wsRef.current?.close();
      pcRef.current?.close();
      stopAcquiredTracks();
      useCallStore.getState().remoteStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      disposeCallTransforms();
    };
  }, [callId]);

  useEffect(() => {
    const previous = callAuthRef.current;
    if (previous.user?.id !== userId || previous.device?.id !== deviceId || !isSameSession(previous, useAuthStore.getState())) clearAllCalls();
  }, [userId, deviceId, sessionId, legacyEpoch, clearAllCalls]);

  useEffect(() => {
    if (!callId || !user) return;

    const currentCallId = callId;
    const currentUser = user;
    let cancelled = false;
    const epoch = sessionEpochRef.current;
    const isCurrent = () => !cancelled && isRunningSession(epoch);

    async function loadCall() {
      try {
        if (!isCurrent()) return;
        const info = await api.get<GetCallResponse>(`/api/calls/${currentCallId}`);
        if (!isCurrent()) return;
        const conversationDetails = await api.get<ConversationWithMembers>(`/api/conversations/${info.conversationId}`);
        if (!isCurrent()) return;

        let pendingCall = await getPendingCall(currentCallId);
        if (!isCurrent()) return;
        if (!pendingCall) {
          await syncMessages({ force: true });
          if (!isCurrent()) return;
          pendingCall = await getPendingCall(currentCallId);
          if (!isCurrent()) return;
        }
        if (!pendingCall || pendingCall.expiresAt <= Date.now()) {
          throw new LocalizedError("secureCallKeyNotFoundOnThisDevice");
        }

        if (!isCurrent()) return;

        const key = await deriveCallKey(fromBase64Url(pendingCall.callKey), currentCallId);
        if (!isCurrent()) return;
        callKeyRef.current = key;

        // Acceptance can arrive on the socket while the ringing snapshot is in flight.
        const live = useCallStore.getState();
        const status = info.status === "ringing" && live.activeCallId === info.id && live.callStatus === "active" ? "active" : info.status;
        setStateCallId(currentCallId);
        setCallInfo({ ...info, status });
        setConversation(conversationDetails);
        hydrateCall({
          callId: info.id,
          conversationId: info.conversationId,
          callType: info.type,
          initiatorId: info.initiatorId,
          status,
          direction: info.initiatorId === currentUser.id ? "outgoing" : "incoming",
          keyReady: !!pendingCall,
          callerUserId: info.initiatorId,
          callerName: conversationDetails.members.find((member) => member.userId === info.initiatorId)?.user.displayName ?? null,
          callerAvatarUrl: conversationDetails.members.find((member) => member.userId === info.initiatorId)?.user.avatarUrl ?? null,
          conversationName: conversationDisplayName(conversationDetails, currentUser.id),
        });
        setStage(status === "active" ? "connecting" : status === "ringing" ? "ringing" : "ended");
      } catch (err: any) {
        if (isCurrent()) {
          setStateCallId(currentCallId);
          setError(toErrorMessage(err, "failedToLoadCall"));
          setStage("ended");
        }
      }
    }

    void loadCall();

    return () => {
      cancelled = true;
    };
  }, [callId, hydrateCall, userId]);

  useEffect(() => {
    if (!callId || callInfo?.id !== callId || !callKeyRef.current || !user) return;
    if (callStatus !== "active" || localCallOwnership?.callId !== callId) return;
    if (setupStartedRef.current) return;

    const currentCallId = callId;
    const currentCallInfo = callInfo;
    const currentCallKey = callKeyRef.current;
    const currentUser = user;
    let cancelled = false;
    const epoch = sessionEpochRef.current;
    const isCurrent = () => !cancelled && isRunningSession(epoch);
    let sessionPc: RTCPeerConnection | null = null;
    let sessionWs: WebSocket | null = null;
    let sessionStream: MediaStream | null = null;
    let clearConnectingTimeout = () => {};
    const visibilityWait = new AbortController();
    const waitForNativeVisibility = async () => {
      while (isCurrent() && nativeAcceptanceRef.current?.callId === currentCallId && document.hidden) {
        await new Promise<void>((resolve) => {
          const done = () => {
            document.removeEventListener("visibilitychange", changed);
            visibilityWait.signal.removeEventListener("abort", done);
            resolve();
          };
          const changed = () => { if (!document.hidden) done(); };
          document.addEventListener("visibilitychange", changed);
          visibilityWait.signal.addEventListener("abort", done, { once: true });
          if (!document.hidden || visibilityWait.signal.aborted) done();
        });
      }
      return isCurrent();
    };
    setupStartedRef.current = true;

    async function startCall() {
      try {
        if (!isCurrent()) return;
        if (!supportsE2EECalling()) {
          throw new E2EECallUnsupportedError();
        }
        if (nativeAcceptanceRef.current?.callId === currentCallId && !await waitForNativeVisibility()) return;

        // Validate the encrypted peer before asking for camera/microphone access.
        const pc = await createPeerConnection(currentCallId, currentCallKey, (remoteStream) => {
          if (!isCurrent()) { remoteStream.getTracks().forEach((track) => track.stop()); return; }
          addRemoteStream("remote", remoteStream);
          setStage("connected");
        }, isCurrent);
        if (!isCurrent()) {
          pc.close();
          return;
        }
        sessionPc = pc;
        pcRef.current = pc;

        // Native consent survives backgrounding; initial capture still requires visibility.
        while (nativeAcceptanceRef.current?.callId === currentCallId && document.hidden) {
          if (!await waitForNativeVisibility()) return;
        }
        if (!isCurrent()) return;
        const acceptance = nativeAcceptanceRef.current;
        if (acceptance?.callId === currentCallId) {
          finishCaptureWaitRef.current?.(acceptance.callId, acceptance.epoch);
        }

        const mediaStream = await captureUserMedia({
          audio: true,
          video: currentCallInfo.type === "video"
            ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
            : false,
        });
        if (!isCurrent()) {
          mediaStream.getTracks().forEach((track) => track.stop());
          pc.close();
          return;
        }

        sessionStream = mediaStream;
        rememberStream(mediaStream);
        setLocalStream(mediaStream);
        cameraTrackRef.current = mediaStream.getVideoTracks()[0] ?? null;

        const { videoSender } = attachLocalTracks(pc, mediaStream, currentCallKey);
        videoSenderRef.current = videoSender;

        // --- Connection state monitoring with ICE restart ---
        pc.onconnectionstatechange = () => {
          if (!isCurrent()) return;
          const state = pc.connectionState;
          if (state === "connected") {
            setStage("connected");
          } else if (state === "failed") {
            // Attempt ICE restart before giving up
            const restartSocket = sessionWs;
            if (restartSocket?.readyState === WebSocket.OPEN) {
              void (async () => {
                try {
                  const restartOffer = await pc.createOffer({ iceRestart: true });
                  if (!isCurrent()) return;
                  await pc.setLocalDescription(restartOffer);
                  if (!isCurrent()) return;
                  sendSignal(restartSocket, { kind: "offer", sdp: restartOffer.sdp, fromUserId: currentUser.id });
                } catch {
                  if (!isCurrent()) return;
                  setError(localized("connectionFailed"));
                  setStage("ended");
                }
              })();
            } else {
              setError(localized("connectionFailed"));
              setStage("ended");
            }
          }
        };

        // --- Queues for buffering signals ---
        const outgoingCandidateQueue: RTCIceCandidateInit[] = [];
        const incomingCandidateQueue: RTCIceCandidateInit[] = [];
        let wsOpen = false;

        const flushOutgoingCandidates = () => {
          while (isCurrent() && outgoingCandidateQueue.length > 0) {
            const c = outgoingCandidateQueue.shift()!;
            sendSignal(ws, {
              kind: "ice-candidate",
              candidate: c.candidate!,
              sdpMid: c.sdpMid ?? null,
              sdpMLineIndex: c.sdpMLineIndex ?? null,
              fromUserId: currentUser.id,
            });
          }
        };

        const flushIncomingCandidates = async () => {
          while (isCurrent() && incomingCandidateQueue.length > 0) {
            const c = incomingCandidateQueue.shift()!;
            await pc.addIceCandidate(new RTCIceCandidate(c));
            if (!isCurrent()) return;
          }
        };

        const ws = new WebSocket(`${resolveWsBaseUrl()}/ws/call/${currentCallId}`, [`token.${useAuthStore.getState().accessToken}`]);
        sessionWs = ws;
        wsRef.current = ws;

        // Buffer outgoing ICE candidates until WS is open
        pc.onicecandidate = (event) => {
          if (!isCurrent() || !event.candidate) return;
          const candidate: RTCIceCandidateInit = {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          };
          if (wsOpen) {
            sendSignal(ws, {
              kind: "ice-candidate",
              candidate: candidate.candidate!,
              sdpMid: candidate.sdpMid ?? null,
              sdpMLineIndex: candidate.sdpMLineIndex ?? null,
              fromUserId: currentUser.id,
            });
          } else {
            outgoingCandidateQueue.push(candidate);
          }
        };

        // Queue incoming ICE candidates until remote description is set
        ws.onmessage = async (event) => {
          if (!isCurrent()) return;
          try {
            const frame = JSON.parse(event.data);
            if (frame.type !== WSFrameType.Signal) return;
            const signal = (frame as WSSignalFrame).payload;

            if (signal.kind === "offer") {
              await acceptCallOffer(pc, ws, signal.sdp!, isCurrent);
              if (!isCurrent()) return;
              // Remote description is now set — flush queued incoming candidates
              await flushIncomingCandidates();
              if (!isCurrent()) return;
            } else if (signal.kind === "answer") {
              await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: signal.sdp! }));
              if (!isCurrent()) return;
              // Remote description is now set — flush queued incoming candidates
              await flushIncomingCandidates();
              if (!isCurrent()) return;
            } else if (signal.kind === "ice-candidate" && signal.candidate) {
              const candidate: RTCIceCandidateInit = {
                candidate: signal.candidate,
                sdpMid: signal.sdpMid,
                sdpMLineIndex: signal.sdpMLineIndex ?? undefined,
              };
              if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
                if (!isCurrent()) return;
              } else {
                incomingCandidateQueue.push(candidate);
              }
            }
          } catch (error: any) {
            if (isCurrent()) { setCallUnsupported(error instanceof E2EECallUnsupportedError); setError(toErrorMessage(error, "callSignalingFailed")); setStage("ended"); }
          }
        };

        ws.onopen = async () => {
          if (!isCurrent()) return;
          try {
            wsOpen = true;
            // Flush any ICE candidates that were generated before WS connected
            flushOutgoingCandidates();

            if (currentCallInfo.initiatorId !== currentUser.id) return;
            const offer = await pc.createOffer();
            if (!isCurrent()) return;
            await pc.setLocalDescription(offer);
            if (!isCurrent()) return;
            sendSignal(ws, { kind: "offer", sdp: offer.sdp, fromUserId: currentUser.id });
          } catch (error: any) {
            if (isCurrent()) { setCallUnsupported(error instanceof E2EECallUnsupportedError); setError(toErrorMessage(error, "callSignalingFailed")); setStage("ended"); }
          }
        };

        ws.onerror = () => {
          if (!isCurrent()) return;
          console.error("Call signaling WebSocket error");
        };

        ws.onclose = (event) => {
          if (!isCurrent()) return;
          wsOpen = false;
          if (event.code === 4403) {
            setError(localized("callSignalingFailed"));
            setStage("ended");
          }
        };

        // --- Connecting timeout: give up after 30s if still not connected ---
        const connectingTimeout = window.setTimeout(() => {
          if (isCurrent() && pc.connectionState !== "connected") {
            setError(localized("couldNotEstablishConnection"));
            setStage("ended");
          }
        }, 30_000);
        clearConnectingTimeout = () => {
          window.clearTimeout(connectingTimeout);
        };
        // Store cleanup for the effect return
        connectingTimeoutCleanupRef.current = clearConnectingTimeout;

        setStage("connecting");
      } catch (err: any) {
        if (!isCurrent()) return;
        console.error("Call setup failed:", err);
        setCallUnsupported(err instanceof E2EECallUnsupportedError);
        setError(toErrorMessage(err, "callSetupFailed"));
        setStage("ended");
      }
    }

    void startCall();

    return () => {
      cancelled = true;
      visibilityWait.abort();
      setupStartedRef.current = false;
      clearConnectingTimeout();
      sessionWs?.close();
      sessionPc?.close();
      sessionStream?.getTracks().forEach((track) => track.stop());
      if (useCallStore.getState().localStream === sessionStream) setLocalStream(null);
      if (wsRef.current === sessionWs) wsRef.current = null;
      if (pcRef.current === sessionPc) { pcRef.current = null; videoSenderRef.current = null; }
    };
  }, [addRemoteStream, callId, callInfo, callStatus, localCallOwnership, setLocalStream, userId]);

  useEffect(() => {
    if (!callId || !callStatus || (stage === "ended" && (callStatus === "active" || callStatus === "ringing"))) return;
    if (callStatus === "ringing") {
      setStage((current) => current === "ended" ? current : "ringing");
      return;
    }
    if (callStatus === "active" && stage !== "connected") {
      setStage((current) => current === "ended" || current === "connected" ? current : "connecting");
      return;
    }
    if (callStatus === "declined" || callStatus === "missed" || callStatus === "ended") {
      wsRef.current?.close();
      pcRef.current?.close();
      videoSenderRef.current = null;
      screenTrackRef.current?.stop();
      localStream?.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
      setStage("ended");
      if (callId) {
        void deletePendingCall(callId).catch(() => undefined);
      }
    }
  }, [callId, callStatus, localStream, setLocalStream, stage]);

  useEffect(() => {
    if (!callId || stateCallId !== callId || stage !== "ended") return;
    endingRef.current = true;
    sessionEpochRef.current += 1;
    const epoch = sessionEpochRef.current;
    releaseCallOwnership(callId);
    stopAcquiredTracks();
    useCallStore.getState().remoteStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    connectingTimeoutCleanupRef.current?.();
    wsRef.current?.close();
    pcRef.current?.close();
    screenTrackRef.current?.stop();
    cameraTrackRef.current?.stop();
    useCallStore.getState().localStream?.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    disposeCallTransforms();
    const targetConversationId = callInfo?.conversationId;
    const onCallScreen = pathnameRef.current === `/call/${callId}`;
    if (!onCallScreen) toast.show({ message: error ? renderMessage(error) : t("callEnded"), tone: error ? "danger" : "info" });
    const timer = window.setTimeout(() => {
      if (!isCurrentEpoch(epoch)) return;
      const current = useCallStore.getState();
      if (current.activeCallId && current.activeCallId !== callId) return;
      if (current.pendingCallStart && current.pendingCallStart.callId !== callId) return;
      clearCall(callId);
      if (pathnameRef.current === `/call/${callId}`) navigate(targetConversationId ? `/chat/${targetConversationId}` : "/");
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [callId, stateCallId, stage, callInfo?.conversationId, clearCall, releaseCallOwnership, navigate, toast.show]);

  useEffect(() => {
    return () => {
      stopAcquiredTracks();
      connectingTimeoutCleanupRef.current?.();
      screenTrackRef.current?.stop();
      wsRef.current?.close();
      pcRef.current?.close();
      videoSenderRef.current = null;
    };
  }, []);

  const replaceOutgoingVideoTrack = async (nextTrack: MediaStreamTrack | null) => {
    const epoch = sessionEpochRef.current;
    const videoSender = videoSenderRef.current;
    if (!isRunningSession(epoch)) return false;
    if (!videoSender) return true;
    await videoSender.replaceTrack(nextTrack);
    if (!isRunningSession(epoch)) return false;
    if (nextTrack && callKeyRef.current) {
      addSenderTransform(videoSender, callKeyRef.current);
    }
    return true;
  };

  const toggleScreenShare = async () => {
    const epoch = sessionEpochRef.current;
    if (!isRunningSession(epoch) || callType !== "video" || !localStream || !canShareScreen) return;

    if (isSharingScreen) {
      if (!await replaceOutgoingVideoTrack(cameraTrackRef.current) || !isRunningSession(epoch)) return;
      if (cameraTrackRef.current) {
        setLocalStream(new MediaStream([...localStream.getAudioTracks(), cameraTrackRef.current]));
      }
      screenTrackRef.current?.stop();
      screenTrackRef.current = null;
      setIsSharingScreen(false);
      return;
    }

    try {
      const displayStream = await captureDisplayMedia({ video: true, audio: false });
      if (!isRunningSession(epoch)) { displayStream.getTracks().forEach((track) => track.stop()); return; }
      rememberStream(displayStream);
      const displayTrack = displayStream.getVideoTracks()[0];
      if (!displayTrack) return;

      displayTrack.onended = () => {
        if (!isRunningSession(epoch)) return;
        void (async () => {
          const videoDisabled = useCallStore.getState().isVideoOff;
          if (videoDisabled || !cameraTrackRef.current) {
            if (!await replaceOutgoingVideoTrack(null) || !isRunningSession(epoch)) return;
            if (localStream) {
              setLocalStream(new MediaStream(localStream.getAudioTracks()));
            }
          } else {
            if (!await replaceOutgoingVideoTrack(cameraTrackRef.current) || !isRunningSession(epoch)) return;
            if (localStream) {
              setLocalStream(new MediaStream([...localStream.getAudioTracks(), cameraTrackRef.current]));
            }
          }
          screenTrackRef.current = null;
          setIsSharingScreen(false);
        })().catch((err) => { if (isRunningSession(epoch)) console.error("Screen share restore failed:", err); });
      };

      screenTrackRef.current = displayTrack;
      if (!await replaceOutgoingVideoTrack(displayTrack) || !isRunningSession(epoch)) return;
      setLocalStream(new MediaStream([...localStream.getAudioTracks(), displayTrack]));
      setIsSharingScreen(true);
    } catch (err) {
      if (isRunningSession(epoch)) console.error("Screen share failed:", err);
    }
  };

  const handleToggleVideo = async () => {
    const epoch = sessionEpochRef.current;
    if (!isRunningSession(epoch) || callType !== "video" || !localStream) return;

    if (isVideoOff) {
      try {
        const cameraStream = await captureUserMedia({ video: true, audio: false });
        if (!isRunningSession(epoch)) { cameraStream.getTracks().forEach((track) => track.stop()); return; }
        rememberStream(cameraStream);
        const nextCameraTrack = cameraStream.getVideoTracks()[0];
        if (!nextCameraTrack) return;

        cameraTrackRef.current?.stop();
        cameraTrackRef.current = nextCameraTrack;

        if (!isSharingScreen) {
          if (!await replaceOutgoingVideoTrack(nextCameraTrack) || !isRunningSession(epoch)) return;
          setLocalStream(new MediaStream([...localStream.getAudioTracks(), nextCameraTrack]));
        }

        toggleVideo();
      } catch (err) {
        if (isRunningSession(epoch)) console.error("Failed to turn camera back on:", err);
      }
      return;
    }

    if (!isSharingScreen) {
      if (!await replaceOutgoingVideoTrack(null) || !isRunningSession(epoch)) return;
    }

    cameraTrackRef.current?.stop();
    cameraTrackRef.current = null;

    if (isSharingScreen && screenTrackRef.current) {
      setLocalStream(new MediaStream([...localStream.getAudioTracks(), screenTrackRef.current]));
    } else {
      setLocalStream(new MediaStream(localStream.getAudioTracks()));
    }

    toggleVideo();
  };

  const handleEnd = () => {
    if (!callId) { navigate("/", { replace: true }); return; }
    if (currentCallIdRef.current !== callId || endHandledRef.current) return;
    const activeId = useCallStore.getState().activeCallId;
    if (activeId && activeId !== callId) return;
    endHandledRef.current = true;
    endingRef.current = true;
    sessionEpochRef.current += 1;
    const target = callInfo ? `/chat/${callInfo.conversationId}` : "/";
    screenTrackRef.current?.stop();
    cameraTrackRef.current?.stop();
    stopAcquiredTracks();
    useCallStore.getState().remoteStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    wsRef.current?.close();
    pcRef.current?.close();
    disposeCallTransforms();
    videoSenderRef.current = null;
    clearCall(callId);
    if (pathnameRef.current === `/call/${callId}`) navigate(target);
    else toast.show({ message: t("callEnded") });
    // Capture must stop immediately, even while the best-effort server request is offline.
    if (callId) {
      void cleanupCallBestEffort(callId, callAuthRef.current);
    }
  };

  const remoteEntries = Array.from(remoteStreams.entries());

  const restoreCall = () => {
    setMinimized(false);
    if (callId) navigate(`/call/${callId}`);
  };

  const minimizeCall = () => {
    setMinimized(true);
    const conversationId = callInfo?.conversationId ?? useCallStore.getState().conversationId;
    navigate(conversationId ? `/chat/${conversationId}` : "/");
  };

  return {
    minimizeCall,
    restoreCall,
    callType,
    localStream,
    isMuted,
    isVideoOff,
    toggleMute,
    peerAvatarUrl,
    peerName,
    isGroupCall,
    stage: callId ? stage : "ended" as Stage,
    isSharingScreen,
    error: error ? renderMessage(error) : error,
    callUnsupported,
    callDuration,
    canShareScreen,
    conversationName,
    formatDuration,
    toggleScreenShare,
    handleToggleVideo,
    handleEnd,
    remoteEntries
  };
}

export { useCall } from "./CallContext.js";
