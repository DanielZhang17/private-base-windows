import { localized, renderMessage, LocalizedError, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { t, useLocale } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useToast } from "../../ui/index.js";
import type { ConversationWithMembers, GetCallResponse } from "@e2ee-chat/shared";
import { fromBase64Url } from "@e2ee-chat/crypto";
import { useCallStore } from "../../stores/callStore.js";
import { useAuthStore } from "../../stores/authStore.js";

import { cleanupCallBestEffort } from "../../services/call-cleanup.js";
import { api } from "../../services/api.js";
import {
  addSenderTransform,
  attachLocalTracks,
  createPeerConnection,
  deriveCallKey,
  disposeCallTransforms,
  supportsE2EECalling,
  type CallFrameKey,
} from "../../services/webrtc.js";
import { deletePendingCall, getPendingCall } from "../../db/index.js";
import { syncMessages } from "../../lib/message-sync.js";
import {
  captureUserMedia, captureDisplayMedia, captureCallCamera, callCameraConstraints, listCallCameras, watchCallCameras,
  type CallCamera,
} from "../../platform/media.js";
import { E2EECallUnsupportedError } from "../../platform/calls.js";
import type { PendingLocalAcceptance } from "./useCallInvitationOwner.js";
import { isSameSession } from "../../services/session-identity.js";
import { startCallSignaling } from "./call-signaling.js";
import { startCallMediaMonitor } from "../../services/call-media-monitor.js";
import type { CallDiagnostics } from "../../services/call-stats.js";

type Stage = "loading" | "ringing" | "connecting" | "connected" | "reconnecting" | "ended";

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
  const signalingRef = useRef<ReturnType<typeof startCallSignaling> | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const callKeyRef = useRef<CallFrameKey | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const pendingCameraTrack = useRef<MediaStreamTrack | null>(null);
  const cameraIntent = useRef(0);
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
  const screenRequest = useRef<symbol | null>(null);
  const setupStartedRef = useRef(false);
  const endingRef = useRef(false);
  const endHandledRef = useRef(false);
  const connectingTimeoutCleanupRef = useRef<(() => void) | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [cameras, setCameras] = useState<CallCamera[]>([]);
  const selectedCamera = useRef<CallCamera | undefined>(undefined);
  const mediaAction = useRef<Promise<void> | null>(null);
  const [cameraId, setCameraId] = useState("");
  const [videoBusy, setVideoBusy] = useState(false);
  const [stateCallId, setStateCallId] = useState<string>();
  const [callInfo, setCallInfo] = useState<GetCallResponse | null>(null);
  const [conversation, setConversation] = useState<ConversationWithMembers | null>(null);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [callUnsupported, setCallUnsupported] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [diagnostics, setDiagnostics] = useState<CallDiagnostics | null>(null);
  const connectedAtRef = useRef<number | null>(null);
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
    if (stage !== "connected" && stage !== "reconnecting") return;
    const update = () => {
      if (isRunningSession(epoch) && connectedAtRef.current !== null) {
        setCallDuration(Math.floor((Date.now() - connectedAtRef.current) / 1000));
      }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
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
    connectedAtRef.current = null;
    setCallDuration(0);
    setDiagnostics(null);
    setIsSharingScreen(false);
    setCameras([]);
    selectedCamera.current = undefined;
    setCameraId("");
    setVideoBusy(false);
    mediaAction.current = null;
    cameraTrackRef.current = null;
    pendingCameraTrack.current = null;
    screenTrackRef.current = null;
    screenRequest.current = null;
    setStage("loading");
    return () => {
      sessionEpochRef.current += 1;
      signalingRef.current?.stop();
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
    let signaling: ReturnType<typeof startCallSignaling> | null = null;
    let sessionStream: MediaStream | null = null;
    let clearConnectingTimeout = () => {};
    let unwatchCameras = () => {};
    let stopMediaMonitor = () => {};
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
    const fail = (error?: unknown) => {
      if (!isCurrent()) return;
      endingRef.current = true;
      if (error) {
        setCallUnsupported(error instanceof E2EECallUnsupportedError);
        setError(toErrorMessage(error, "callSignalingFailed"));
      } else {
        setError(localized("connectionFailed"));
        void cleanupCallBestEffort(currentCallId, callAuthRef.current);
      }
      setStage("ended");
    };

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

        let mediaStream = await captureUserMedia({
          audio: true,
          video: currentCallInfo.type === "video" && !useCallStore.getState().isVideoOff
            ? callCameraConstraints
            : false,
        });
        if (!isCurrent()) {
          mediaStream.getTracks().forEach((track) => track.stop());
          pc.close();
          return;
        }

        if (useCallStore.getState().isVideoOff && mediaStream.getVideoTracks().length) {
          mediaStream.getVideoTracks().forEach((track) => track.stop());
          mediaStream = new MediaStream(mediaStream.getAudioTracks());
        }
        sessionStream = mediaStream;
        rememberStream(mediaStream);
        setLocalStream(mediaStream);
        const cameraTrack = mediaStream.getVideoTracks()[0] ?? null;
        cameraTrackRef.current = cameraTrack;
        if (cameraTrack) monitorCamera(cameraTrack, epoch);

        const { videoSender } = attachLocalTracks(pc, mediaStream, currentCallKey, currentCallInfo.type === "video");
        videoSenderRef.current = videoSender;
        stopMediaMonitor = startCallMediaMonitor(pc, videoSender, isCurrent, setDiagnostics, () => screenTrackRef.current !== null);
        if (currentCallInfo.type === "video") {
          const refresh = () => { void refreshCameras(epoch, true); };
          unwatchCameras = watchCallCameras(refresh);
          void refreshCameras(epoch);
        }

        signaling = startCallSignaling({
          pc, callId: currentCallId, userId: currentUser.id,
          caller: currentCallInfo.initiatorId === currentUser.id,
          isCurrent,
          onStage: (next) => {
            connectedAtRef.current ??= Date.now();
            setStage(next);
          },
          onTerminal: () => {
            if (!isCurrent()) return;
            endingRef.current = true;
            setStage("ended");
          },
          onError: fail,
        });
        signalingRef.current = signaling;

        // --- Connecting timeout: give up after 30s if still not connected ---
        const connectingTimeout = window.setTimeout(() => {
          if (isCurrent() && !signaling?.hasConnected()) {
            endingRef.current = true;
            setError(localized("couldNotEstablishConnection"));
            setStage("ended");
            void cleanupCallBestEffort(currentCallId, callAuthRef.current);
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
        endingRef.current = true;
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
      unwatchCameras();
      stopMediaMonitor();
      signaling?.stop();
      sessionPc?.close();
      sessionStream?.getTracks().forEach((track) => track.stop());
      if (useCallStore.getState().localStream === sessionStream) setLocalStream(null);
      if (signalingRef.current === signaling) signalingRef.current = null;
      if (pcRef.current === sessionPc) { pcRef.current = null; videoSenderRef.current = null; }
    };
  }, [addRemoteStream, callId, callInfo, callStatus, localCallOwnership, setLocalStream, userId]);

  useEffect(() => {
    if (!callId || !callStatus || (stage === "ended" && (callStatus === "active" || callStatus === "ringing"))) return;
    if (callStatus === "ringing") {
      setStage((current) => current === "ended" ? current : "ringing");
      return;
    }
    if (callStatus === "active") {
      setStage((current) => current === "loading" || current === "ringing" ? "connecting" : current);
      return;
    }
    if (callStatus === "declined" || callStatus === "missed" || callStatus === "ended") {
      signalingRef.current?.stop();
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
    void deletePendingCall(callId).catch(() => undefined);
    stopAcquiredTracks();
    useCallStore.getState().remoteStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    connectingTimeoutCleanupRef.current?.();
    signalingRef.current?.stop();
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
      signalingRef.current?.stop();
      pcRef.current?.close();
      videoSenderRef.current = null;
    };
  }, []);

  const replaceOutgoingVideoTrack = async (nextTrack: MediaStreamTrack | null) => {
    const epoch = sessionEpochRef.current;
    const videoSender = videoSenderRef.current;
    if (!isRunningSession(epoch)) return false;
    if (!videoSender) return nextTrack === null;
    // Establish the transform before handing any track to the sender. The helper
    // is idempotent and the same transform remains attached after replaceTrack.
    if (nextTrack) {
      if (!callKeyRef.current) throw new E2EECallUnsupportedError();
      addSenderTransform(videoSender, callKeyRef.current);
    }
    await videoSender.replaceTrack(nextTrack);
    return isRunningSession(epoch);
  };

  function stopVideoTrack(track: MediaStreamTrack | null) {
    if (!track) return;
    track.onended = null;
    if (track.readyState !== "ended") track.stop();
    acquiredTracks.current.delete(track);
  }

  function showVideo(track: MediaStreamTrack | null) {
    const audio = useCallStore.getState().localStream?.getAudioTracks() ?? [];
    setLocalStream(new MediaStream(track ? [...audio, track] : audio));
  }

  function selectCamera(camera: CallCamera | undefined) {
    selectedCamera.current = camera;
    setCameraId(camera?.id ?? "");
  }

  function runVideoAction(epoch: number, action: () => Promise<void>, onFailure: (error: unknown) => void, queue = false) {
    if (!isRunningSession(epoch) || (!queue && mediaAction.current)) return Promise.resolve();
    setVideoBusy(true);
    const start = async () => {
      if (isRunningSession(epoch)) await action();
    };
    const pending = (mediaAction.current ? mediaAction.current.then(start) : start()).catch((error) => {
      if (isRunningSession(epoch)) onFailure(error);
    }).finally(() => {
      if (mediaAction.current === pending) {
        mediaAction.current = null;
        if (isRunningSession(epoch)) setVideoBusy(false);
      }
    });
    mediaAction.current = pending;
    return pending;
  }

  const cameraError = (error: unknown) => toast.show({
    message: t((error as { name?: string })?.name === "NotAllowedError" ? "callCameraPermissionDenied" : "callCameraSwitchFailed"),
    tone: "warning",
  });

  async function retireCamera(track: MediaStreamTrack, epoch: number) {
    if (!isRunningSession(epoch) || cameraTrackRef.current !== track) return false;
    stopVideoTrack(track);
    cameraTrackRef.current = null;
    if (!useCallStore.getState().isVideoOff) toggleVideo();
    if (!screenTrackRef.current) {
      showVideo(null);
      await replaceOutgoingVideoTrack(null);
    }
    return isRunningSession(epoch);
  }

  function cameraUnavailable(track: MediaStreamTrack, epoch: number) {
    return runVideoAction(epoch, async () => {
      if (!await retireCamera(track, epoch)) return;
      void refreshCameras(epoch);
      toast.show({ message: t("callCameraDisconnected"), tone: "warning" });
    }, cameraError, true);
  }

  function monitorCamera(track: MediaStreamTrack, epoch: number) {
    track.onended = () => { void cameraUnavailable(track, epoch); };
  }

  async function refreshCameras(epoch: number, deviceChanged = false) {
    const track = cameraTrackRef.current;
    try {
      const inputs = await listCallCameras(track);
      if (!isRunningSession(epoch) || cameraTrackRef.current !== track) return;
      setCameras(inputs);
      const settings = track?.getSettings?.();
      const activeCamera = inputs.find((input) => input.id === settings?.deviceId || (input.facingMode && input.facingMode === settings?.facingMode));
      if (track && (track.readyState === "ended" || (deviceChanged && selectedCamera.current && !selectedCamera.current.facingMode
        && selectedCamera.current.id === settings?.deviceId && !activeCamera))) {
        selectCamera(inputs[0]);
        void cameraUnavailable(track, epoch);
      } else if (activeCamera) {
        selectCamera(activeCamera);
      } else if (!inputs.some((input) => input.id === selectedCamera.current?.id)) {
        selectCamera(inputs[0]);
      }
    } catch {
      // Enumeration is optional. The current track can still be used.
    }
  }

  const wantsCamera = (epoch: number, intent: number) =>
    isRunningSession(epoch) && cameraIntent.current === intent && !useCallStore.getState().isVideoOff;

  async function installCamera(camera: CallCamera | undefined, epoch: number, intent: number) {
    const cameraStream = await captureCallCamera(camera);
    const next = cameraStream.getVideoTracks()[0];
    if (!wantsCamera(epoch, intent) || !next || next.readyState === "ended") {
      cameraStream.getTracks().forEach((track) => track.stop());
      if (wantsCamera(epoch, intent)) throw new DOMException("No live camera track", "NotReadableError");
      return;
    }
    rememberStream(cameraStream);
    pendingCameraTrack.current = next;
    try {
      if (!screenTrackRef.current && !await replaceOutgoingVideoTrack(next) && wantsCamera(epoch, intent)) throw new Error("No video sender");
      if (!wantsCamera(epoch, intent)) return;
      stopVideoTrack(cameraTrackRef.current);
      cameraTrackRef.current = next;
      monitorCamera(next, epoch);
      if (!screenTrackRef.current) showVideo(next);
      selectCamera(camera);
      void refreshCameras(epoch);
    } finally {
      if (pendingCameraTrack.current === next) pendingCameraTrack.current = null;
      if (cameraTrackRef.current !== next) stopVideoTrack(next);
    }
  }

  const handleSelectCamera = (id: string) => {
    const camera = cameras.find((input) => input.id === id);
    const epoch = sessionEpochRef.current;
    if (!camera || id === selectedCamera.current?.id) return Promise.resolve();
    return runVideoAction(epoch, async () => {
      if (useCallStore.getState().isVideoOff) { selectCamera(camera); return; }
      const intent = cameraIntent.current;
      const previous = cameraTrackRef.current;
      const previousCamera = selectedCamera.current;
      try {
        await installCamera(camera, epoch, intent);
      } catch (error) {
        if (!wantsCamera(epoch, intent)) return;
        const name = (error as { name?: string })?.name;
        // Some camera drivers only allow one active capture at a time.
        if (!previous || (name !== "NotReadableError" && name !== "AbortError")) throw error;
        stopVideoTrack(previous);
        try {
          await installCamera(camera, epoch, intent);
        } catch (retryError) {
          if (!wantsCamera(epoch, intent)) return;
          try { await installCamera(previousCamera, epoch, intent); }
          catch { await retireCamera(previous, epoch); }
          if (wantsCamera(epoch, intent)) throw retryError;
        }
      }
    }, cameraError);
  };

  const cycleCamera = () => {
    if (cameras.length < 2) return;
    const index = cameras.findIndex((camera) => camera.id === selectedCamera.current?.id);
    void handleSelectCamera(cameras[(index + 1) % cameras.length]!.id);
  };

  const toggleScreenShare = () => {
    const epoch = sessionEpochRef.current;
    if (!isRunningSession(epoch) || callType !== "video" || !localStream || !canShareScreen) return Promise.resolve();
    const shareError = (error: unknown) => console.error("Screen share failed:", error);
    const stopSharing = (request: symbol) => {
      if (!isRunningSession(epoch) || screenRequest.current !== request) return Promise.resolve();
      screenRequest.current = null;
      setIsSharingScreen(false);
      const displayTrack = screenTrackRef.current;
      if (!displayTrack) return Promise.resolve();
      stopVideoTrack(displayTrack);
      if (useCallStore.getState().localStream?.getVideoTracks().some((track) => track === displayTrack)) showVideo(null);
      return runVideoAction(epoch, async () => {
        // Keep the ended screen in the ref until the pending camera operation has parked its track.
        screenTrackRef.current = null;
        const camera = useCallStore.getState().isVideoOff ? null : cameraTrackRef.current;
        const next = camera?.readyState === "live" ? camera : null;
        if (await replaceOutgoingVideoTrack(next) && (!next || cameraTrackRef.current === next)) showVideo(next);
      }, shareError, true);
    };
    if (screenRequest.current) return stopSharing(screenRequest.current);
    return runVideoAction(epoch, async () => {
      const request = Symbol();
      screenRequest.current = request;
      setIsSharingScreen(true);
      const sharingRequested = () => isRunningSession(epoch) && screenRequest.current === request;
      try {
        const displayStream = await captureDisplayMedia({ video: true, audio: false });
        const displayTrack = displayStream.getVideoTracks()[0];
        if (!sharingRequested() || !displayTrack) {
          displayStream.getTracks().forEach((track) => track.stop());
          void stopSharing(request);
          return;
        }
        rememberStream(displayStream);
        screenTrackRef.current = displayTrack;
        displayTrack.onended = () => { void stopSharing(request); };
        if (displayTrack.readyState === "ended") { void stopSharing(request); return; }
        if (!await replaceOutgoingVideoTrack(displayTrack)) { void stopSharing(request); return; }
        if (sharingRequested()) showVideo(displayTrack);
      } catch (error) {
        if (sharingRequested()) { void stopSharing(request); throw error; }
      }
    }, shareError);
  };

  const handleToggleVideo = () => {
    const epoch = sessionEpochRef.current;
    if (!isRunningSession(epoch) || callType !== "video") return Promise.resolve();
    if (!useCallStore.getState().isVideoOff) {
      cameraIntent.current += 1;
      const hadCamera = !!(cameraTrackRef.current || pendingCameraTrack.current);
      stopVideoTrack(cameraTrackRef.current);
      stopVideoTrack(pendingCameraTrack.current);
      cameraTrackRef.current = null;
      pendingCameraTrack.current = null;
      toggleVideo();
      if (useCallStore.getState().localStream?.getVideoTracks().some((track) => track !== screenTrackRef.current)) showVideo(null);
      if (!hadCamera || screenTrackRef.current) return Promise.resolve();
      return runVideoAction(epoch, async () => {
        if (!screenTrackRef.current) await replaceOutgoingVideoTrack(null);
      }, cameraError, true);
    }
    if (!localStream) return Promise.resolve();
    return runVideoAction(epoch, async () => {
      toggleVideo();
      const intent = cameraIntent.current;
      try {
        await installCamera(selectedCamera.current, epoch, intent);
      } catch (error) {
        if (wantsCamera(epoch, intent)) { toggleVideo(); throw error; }
      }
    }, cameraError);
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
    signalingRef.current?.stop();
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
    cameras,
    cameraId,
    videoBusy,
    handleSelectCamera,
    cycleCamera,
    error: error ? renderMessage(error) : error,
    callUnsupported,
    callDuration,
    diagnostics: stateCallId === callId ? diagnostics : null,
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
