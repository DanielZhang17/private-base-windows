import { localized, renderMessage, LocalizedError, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { t, useLocale } from "../../i18n/index.js";
import { useOutgoingQueue } from "../chat/useOutgoingQueue.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useMatch } from "react-router-dom";
import type { ConversationWithMembers, GetCallResponse, WSSignalFrame } from "@e2ee-chat/shared";
import { WSFrameType } from "@e2ee-chat/shared";
import { fromBase64Url } from "@e2ee-chat/crypto";
import { useCallStore } from "../../stores/callStore.js";
import { useAuthStore } from "../../stores/authStore.js";

import { api, resolveWsBaseUrl } from "../../services/api.js";
import {
  addSenderTransform,
  attachLocalTracks,
  createPeerConnection,
  acceptCallOffer,
  deriveCallKey,
  supportsE2EECalling,
  sendSignal,
  type CallFrameKey,
} from "../../services/webrtc.js";
import { deletePendingCall, getPendingCall } from "../../db/index.js";
import { syncMessages } from "../../lib/message-sync.js";
import { captureUserMedia, captureDisplayMedia } from "../../platform/media.js";
import { E2EECallUnsupportedError } from "../../platform/calls.js";

type Stage = "loading" | "ringing" | "connecting" | "connected" | "ended";

function conversationDisplayName(conversation: ConversationWithMembers | null, localUserId: string | undefined): string {
  if (!conversation) return t("callScreenTitle");
  if (conversation.name) return conversation.name;
  return conversation.members
    .filter((member) => member.userId !== localUserId)
    .map((member) => member.user.displayName)
    .join(", ");
}

export function useCall() {
  useLocale();
  useOutgoingQueue();
  const match = useMatch("/call/:callId");
  const storeCallId = useCallStore((state) => state.activeCallId);
  const callId = storeCallId || match?.params?.callId;

  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const userId = user?.id;
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const {
    callType,
    callStatus,
    localStream,
    remoteStreams,
    isMuted,
    isVideoOff,
    isMinimized,
    setMinimized,
    setLocalStream,
    addRemoteStream,
    hydrateCall,
    clearCall,
    toggleMute,
    toggleVideo,
  } = useCallStore();
  const callerAvatarUrl = useCallStore((state) => state.callerAvatarUrl);

  const localVideoRef = useRef<HTMLVideoElement>(null);
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
  const connectingTimeoutCleanupRef = useRef<(() => void) | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [callInfo, setCallInfo] = useState<GetCallResponse | null>(null);
  const [conversation, setConversation] = useState<ConversationWithMembers | null>(null);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [callUnsupported, setCallUnsupported] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const durationTimerRef = useRef<number | null>(null);
  const canShareScreen = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";

  const conversationName = useMemo(
    () => conversationDisplayName(conversation, user?.id),
    [conversation, user?.id],
  );

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  useEffect(() => {
    if (stage === "connected") {
      durationTimerRef.current = window.setInterval(() => {
        setCallDuration((d) => d + 1);
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
  }, [stage]);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (!callId || !user) return;

    const currentCallId = callId;
    const currentUser = user;
    let cancelled = false;

    async function loadCall() {
      try {
        const info = await api.get<GetCallResponse>(`/api/calls/${currentCallId}`);
        const conversationDetails = await api.get<ConversationWithMembers>(`/api/conversations/${info.conversationId}`);

        let pendingCall = await getPendingCall(currentCallId);
        if (!pendingCall) {
          await syncMessages({ force: true });
          pendingCall = await getPendingCall(currentCallId);
        }
        if (!pendingCall || pendingCall.expiresAt <= Date.now()) {
          throw new LocalizedError("secureCallKeyNotFoundOnThisDevice");
        }

        if (cancelled) return;

        const key = await deriveCallKey(fromBase64Url(pendingCall.callKey), currentCallId);
        if (cancelled) return;
        callKeyRef.current = key;

        setCallInfo(info);
        setConversation(conversationDetails);
        hydrateCall({
          callId: info.id,
          conversationId: info.conversationId,
          callType: info.type,
          initiatorId: info.initiatorId,
          status: info.status,
          direction: info.initiatorId === currentUser.id ? "outgoing" : "incoming",
          keyReady: !!pendingCall,
          callerUserId: info.initiatorId,
          callerName: conversationDetails.members.find((member) => member.userId === info.initiatorId)?.user.displayName ?? null,
          callerAvatarUrl: conversationDetails.members.find((member) => member.userId === info.initiatorId)?.user.avatarUrl ?? null,
          conversationName: conversationDisplayName(conversationDetails, currentUser.id),
        });
        setStage(info.status === "active" ? "connecting" : info.status === "ringing" ? "ringing" : "ended");
      } catch (err: any) {
        if (!cancelled) {
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
    if (!callId || !callInfo || !callKeyRef.current || !user) return;
    if (callStatus !== "active") return;
    if (setupStartedRef.current) return;

    const currentCallId = callId;
    const currentCallInfo = callInfo;
    const currentCallKey = callKeyRef.current;
    const currentUser = user;
    let cancelled = false;
    setupStartedRef.current = true;

    async function startCall() {
      try {
        if (!supportsE2EECalling()) {
          throw new E2EECallUnsupportedError();
        }

        // Validate the encrypted peer before asking for camera/microphone access.
        const pc = await createPeerConnection(currentCallId, currentCallKey, (remoteStream) => {
          addRemoteStream("remote", remoteStream);
          setStage("connected");
        });
        if (cancelled) {
          pc.close();
          return;
        }
        pcRef.current = pc;

        const mediaStream = await captureUserMedia({
          audio: true,
          video: currentCallInfo.type === "video"
            ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
            : false,
        });
        if (cancelled) {
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }

        rememberStream(mediaStream);
        setLocalStream(mediaStream);
        cameraTrackRef.current = mediaStream.getVideoTracks()[0] ?? null;

        const { videoSender } = attachLocalTracks(pc, mediaStream, currentCallKey);
        videoSenderRef.current = videoSender;

        // --- Connection state monitoring with ICE restart ---
        pc.onconnectionstatechange = () => {
          if (cancelled) return;
          const state = pc.connectionState;
          if (state === "connected") {
            setStage("connected");
          } else if (state === "failed") {
            // Attempt ICE restart before giving up
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              void (async () => {
                try {
                  const restartOffer = await pc.createOffer({ iceRestart: true });
                  await pc.setLocalDescription(restartOffer);
                  sendSignal(wsRef.current!, { kind: "offer", sdp: restartOffer.sdp, fromUserId: currentUser.id });
                } catch {
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
          while (outgoingCandidateQueue.length > 0) {
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
          while (incomingCandidateQueue.length > 0) {
            const c = incomingCandidateQueue.shift()!;
            await pcRef.current?.addIceCandidate(new RTCIceCandidate(c));
          }
        };

        const ws = new WebSocket(`${resolveWsBaseUrl()}/ws/call/${currentCallId}`, [`token.${useAuthStore.getState().accessToken}`]);
        wsRef.current = ws;

        // Buffer outgoing ICE candidates until WS is open
        pc.onicecandidate = (event) => {
          if (!event.candidate) return;
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
          if (cancelled) return;
          try {
            const frame = JSON.parse(event.data);
            if (frame.type !== WSFrameType.Signal) return;
            const signal = (frame as WSSignalFrame).payload;

            if (signal.kind === "offer" && pcRef.current) {
              await acceptCallOffer(pcRef.current, ws, signal.sdp!);
              // Remote description is now set — flush queued incoming candidates
              await flushIncomingCandidates();
            } else if (signal.kind === "answer" && pcRef.current) {
              await pcRef.current.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: signal.sdp! }));
              // Remote description is now set — flush queued incoming candidates
              await flushIncomingCandidates();
            } else if (signal.kind === "ice-candidate" && signal.candidate && pcRef.current) {
              const candidate: RTCIceCandidateInit = {
                candidate: signal.candidate,
                sdpMid: signal.sdpMid,
                sdpMLineIndex: signal.sdpMLineIndex ?? undefined,
              };
              if (pcRef.current.remoteDescription) {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
              } else {
                incomingCandidateQueue.push(candidate);
              }
            }
          } catch (error: any) {
            if (!cancelled) { setCallUnsupported(error instanceof E2EECallUnsupportedError); setError(toErrorMessage(error, "callSignalingFailed")); setStage("ended"); }
          }
        };

        ws.onopen = async () => {
          if (cancelled) return;
          try {
            wsOpen = true;
            // Flush any ICE candidates that were generated before WS connected
            flushOutgoingCandidates();

            if (currentCallInfo.initiatorId !== currentUser.id || !pcRef.current) return;
            const offer = await pcRef.current.createOffer();
            await pcRef.current.setLocalDescription(offer);
            sendSignal(ws, { kind: "offer", sdp: offer.sdp, fromUserId: currentUser.id });
          } catch (error: any) {
            if (!cancelled) { setCallUnsupported(error instanceof E2EECallUnsupportedError); setError(toErrorMessage(error, "callSignalingFailed")); setStage("ended"); }
          }
        };

        ws.onerror = () => {
          if (cancelled) return;
          console.error("Call signaling WebSocket error");
        };

        ws.onclose = () => {
          if (cancelled) return;
          wsOpen = false;
        };

        // --- Connecting timeout: give up after 30s if still not connected ---
        const connectingTimeout = window.setTimeout(() => {
          if (pcRef.current?.connectionState !== "connected" && !cancelled) {
            setError(localized("couldNotEstablishConnection"));
            setStage("ended");
          }
        }, 30_000);
        const origCleanup = () => {
          window.clearTimeout(connectingTimeout);
        };
        // Store cleanup for the effect return
        connectingTimeoutCleanupRef.current = origCleanup;

        setStage("connecting");
      } catch (err: any) {
        if (cancelled) return;
        console.error("Call setup failed:", err);
        setCallUnsupported(err instanceof E2EECallUnsupportedError);
        setError(toErrorMessage(err, "callSetupFailed"));
        setStage("ended");
      }
    }

    void startCall();

    return () => {
      cancelled = true;
      setupStartedRef.current = false;
      connectingTimeoutCleanupRef.current?.();
      wsRef.current?.close();
      pcRef.current?.close();
      screenTrackRef.current?.stop();
      cameraTrackRef.current?.stop();
      useCallStore.getState().localStream?.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
      videoSenderRef.current = null;
    };
  }, [addRemoteStream, callId, callInfo, callStatus, setLocalStream, userId]);

  useEffect(() => {
    if (!callStatus || (stage === "ended" && (callStatus === "active" || callStatus === "ringing"))) return;
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
    if (stage !== "ended") return;
    connectingTimeoutCleanupRef.current?.();
    wsRef.current?.close();
    pcRef.current?.close();
    screenTrackRef.current?.stop();
    cameraTrackRef.current?.stop();
    useCallStore.getState().localStream?.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    const targetConversationId = callInfo?.conversationId;
    const timer = window.setTimeout(() => {
      clearCall();
      navigate(targetConversationId ? `/chat/${targetConversationId}` : "/");
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [stage, callInfo?.conversationId, clearCall, navigate]);

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
    const videoSender = videoSenderRef.current;
    if (!videoSender) return;
    await videoSender.replaceTrack(nextTrack);
    if (nextTrack && callKeyRef.current) {
      addSenderTransform(videoSender, callKeyRef.current);
    }
  };

  const toggleScreenShare = async () => {
    if (callType !== "video" || !localStream || !canShareScreen) return;

    if (isSharingScreen) {
      await replaceOutgoingVideoTrack(cameraTrackRef.current);
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
      if (!mountedRef.current || endingRef.current) { displayStream.getTracks().forEach((track) => track.stop()); return; }
      rememberStream(displayStream);
      const displayTrack = displayStream.getVideoTracks()[0];
      if (!displayTrack) return;

      displayTrack.onended = () => {
        void (async () => {
          const videoDisabled = useCallStore.getState().isVideoOff;
          if (videoDisabled || !cameraTrackRef.current) {
            await replaceOutgoingVideoTrack(null);
            if (localStream) {
              setLocalStream(new MediaStream(localStream.getAudioTracks()));
            }
          } else {
            await replaceOutgoingVideoTrack(cameraTrackRef.current);
            if (localStream) {
              setLocalStream(new MediaStream([...localStream.getAudioTracks(), cameraTrackRef.current]));
            }
          }
          screenTrackRef.current = null;
          setIsSharingScreen(false);
        })();
      };

      screenTrackRef.current = displayTrack;
      await replaceOutgoingVideoTrack(displayTrack);
      setLocalStream(new MediaStream([...localStream.getAudioTracks(), displayTrack]));
      setIsSharingScreen(true);
    } catch (err) {
      console.error("Screen share failed:", err);
    }
  };

  const handleToggleVideo = async () => {
    if (callType !== "video" || !localStream) return;

    if (isVideoOff) {
      try {
        const cameraStream = await captureUserMedia({ video: true, audio: false });
        if (!mountedRef.current || endingRef.current) { cameraStream.getTracks().forEach((track) => track.stop()); return; }
        rememberStream(cameraStream);
        const nextCameraTrack = cameraStream.getVideoTracks()[0];
        if (!nextCameraTrack) return;

        cameraTrackRef.current?.stop();
        cameraTrackRef.current = nextCameraTrack;

        if (!isSharingScreen) {
          await replaceOutgoingVideoTrack(nextCameraTrack);
          setLocalStream(new MediaStream([...localStream.getAudioTracks(), nextCameraTrack]));
        }

        toggleVideo();
      } catch (err) {
        console.error("Failed to turn camera back on:", err);
      }
      return;
    }

    if (!isSharingScreen) {
      await replaceOutgoingVideoTrack(null);
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
    if (endingRef.current) return;
    endingRef.current = true;
    const target = callInfo ? `/chat/${callInfo.conversationId}` : "/";
    screenTrackRef.current?.stop();
    cameraTrackRef.current?.stop();
    wsRef.current?.close();
    pcRef.current?.close();
    videoSenderRef.current = null;
    clearCall();
    navigate(target);
    // Capture must stop immediately, even while the best-effort server request is offline.
    if (callId) {
      void api.post(`/api/calls/${callId}/end`).catch(() => undefined);
      void deletePendingCall(callId).catch(() => undefined);
    }
  };

  const remoteEntries = Array.from(remoteStreams.entries());

  const restoreCall = () => {
    setMinimized(false);
    navigate(callInfo?.conversationId ? `/chat/${callInfo.conversationId}` : "/");
  };

  return {
    restoreCall,
    callType,
    localStream,
    isMuted,
    isVideoOff,
    isMinimized,
    toggleMute,
    callerAvatarUrl,
    localVideoRef,
    stage,
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
