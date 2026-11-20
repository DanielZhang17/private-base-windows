import { WSFrameType, type GetCallResponse, type WSSignalFrame } from "@e2ee-chat/shared";
import { useAuthStore } from "../../stores/authStore.js";
import { api, resolveWsBaseUrl } from "../../services/api.js";
import { acceptCallOffer, fetchTurnCredentials, sendSignal } from "../../services/webrtc.js";
import { LocalizedError } from "../../i18n/messages.js";
import { withNativeDeadline } from "../../platform/native-wait.js";

type Signal = WSSignalFrame["payload"];
const BACKOFF_MS = [1000, 2000, 5000, 10_000];
const DISCONNECTED_GRACE_MS = 3000;
const ICE_RETRY_MS = 8000;
const RECOVERY_TIMEOUT_MS = 45_000;
const TURN_REFRESH_TIMEOUT_MS = 2500;
const CALL_STATUS_TIMEOUT_MS = 5000;
const MAX_CANDIDATES = 48;

function matchesIceGeneration(sdp: string, signal: Signal) {
  return !signal.usernameFragment || sdp.split(/\r?\n/).includes(`a=ice-ufrag:${signal.usernameFragment}`);
}

function trimCandidates(signals: Signal[], offset = 0): number {
  if (signals.length <= offset + MAX_CANDIDATES) return -1;
  const nonRelay = signals.findIndex((signal, index) => index >= offset && signal.candidate !== "" && !signal.candidate?.includes(" typ relay "));
  const removed = nonRelay === -1 ? offset : nonRelay;
  signals.splice(removed, 1);
  return removed;
}

interface Options {
  pc: RTCPeerConnection;
  callId: string;
  userId: string;
  caller: boolean;
  isCurrent: () => boolean;
  onStage: (stage: "connected" | "reconnecting") => void;
  onTerminal: () => void;
  onError: (error?: unknown) => void;
}

/** One transport for the lifetime of an already encrypted peer connection. */
export function startCallSignaling({ pc, callId, userId, caller, isCurrent, onStage, onTerminal, onError }: Options) {
  let stopped = false;
  let ws: WebSocket | null = null;
  let ready = false;
  let resumeSupported = false;
  let cursor = 0;
  let replayId: string | undefined;
  let socketLost = false;
  let attempts = 0;
  let everConnected = false;
  let initialOfferStarted = false;
  let iceUnhealthy = false;
  const roleDelay = caller ? 0 : 2000;
  let iceRestarting = false;
  let restartSent = false;
  let reopenedForIce = false;
  let offerId: string | undefined;
  let remoteSdp: string | undefined;
  const incomingCandidates: Signal[] = [];
  const addedCandidates = new Set<string>();
  let localSignals: Signal[] = [];
  let sent = 0;
  let descriptionInProgress = false;
  let stagedCandidates: Signal[] = [];
  let work = Promise.resolve();
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let iceTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const requestLifetime = new AbortController();

  const active = () => !stopped && isCurrent();
  const connected = () => pc.connectionState === "connected" && pc.iceConnectionState !== "failed" && pc.iceConnectionState !== "disconnected";
  const restartChecking = () => restartSent && pc.signalingState === "stable" && pc.iceConnectionState === "checking";
  const enqueue = (task: () => Promise<void>) => {
    work = work.then(async () => { if (active()) await task(); }).catch((error) => {
      if (active()) onError(error);
    });
    return work;
  };

  const clearDeadline = () => {
    clearTimeout(deadline);
    deadline = undefined;
  };

  const transportHealthy = () => {
    if (!active() || iceUnhealthy) return;
    clearDeadline();
    if (everConnected) onStage(socketLost ? "reconnecting" : "connected");
  };

  const recovering = () => {
    if (everConnected) onStage("reconnecting");
    // Keep working media alive through a signaling-only outage.
    if (iceUnhealthy) deadline ??= setTimeout(() => { if (active()) onError(); }, RECOVERY_TIMEOUT_MS);
  };

  const flush = () => {
    const socket = ws;
    if (!active() || !ready || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      while (sent < localSignals.length) {
        sendSignal(socket, localSignals[sent]!);
        sent++;
      }
    } catch {
      disconnect(socket);
    }
  };

  const publishDescription = (signal: Signal) => {
    localSignals = [signal, ...stagedCandidates.filter((candidate) => matchesIceGeneration(signal.sdp!, candidate))];
    sent = 0;
    flush();
  };

  const makeOffer = async (restart: boolean) => {
    descriptionInProgress = true;
    stagedCandidates = [];
    try {
      const offer = await pc.createOffer(restart ? { iceRestart: true } : undefined);
      if (!active()) return;
      await pc.setLocalDescription(offer);
      if (!active()) return;
      offerId = crypto.randomUUID();
      publishDescription({ kind: "offer", sdp: offer.sdp, fromUserId: userId, offerId });
    } finally {
      descriptionInProgress = false;
    }
  };

  const scheduleIceRestart = (delay: number) => {
    if (iceTimer !== undefined || iceRestarting || !ready || !active() || restartChecking()) return;
    iceTimer = setTimeout(async () => {
      iceTimer = undefined;
      if (!active() || !ready || !iceUnhealthy || connected() || restartChecking()) return;
      // A half-open signaling socket can still report OPEN during a network handover.
      if (restartSent && !reopenedForIce && ws && pc.signalingState === "have-local-offer") {
        reopenedForIce = true;
        disconnect(ws);
        return;
      }
      iceRestarting = true;
      try {
        const turn = await withNativeDeadline(TURN_REFRESH_TIMEOUT_MS, fetchTurnCredentials, requestLifetime.signal)
          .catch(() => undefined);
        await enqueue(async () => {
          if (!active() || !ready || !iceUnhealthy || connected() || restartChecking()) return;
          try {
            if (turn) {
              try { pc.setConfiguration({ ...pc.getConfiguration(), iceServers: turn.iceServers }); }
              catch (error) { console.warn("Could not update call TURN credentials", error); }
            }
            if (pc.signalingState === "have-local-offer") await pc.setLocalDescription({ type: "rollback" });
            if (active() && ready && !connected() && pc.signalingState === "stable") {
              await makeOffer(true);
              restartSent = true;
            }
          } catch (error) {
            if (active()) console.warn("Call ICE restart failed", error);
          }
        });
      } finally {
        iceRestarting = false;
        if (iceUnhealthy) scheduleIceRestart(ICE_RETRY_MS + roleDelay);
      }
    }, delay);
  };

  const updateIce = () => {
    if (!active()) return;
    if (pc.connectionState === "closed") { onError(); return; }
    const failed = pc.connectionState === "failed" || pc.iceConnectionState === "failed";
    const disconnected = pc.connectionState === "disconnected" || pc.iceConnectionState === "disconnected";
    if (!failed && !disconnected && connected()) {
      everConnected = true;
      iceUnhealthy = false;
      restartSent = false;
      reopenedForIce = false;
      clearTimeout(iceTimer);
      iceTimer = undefined;
      transportHealthy();
    } else if (failed || disconnected) {
      iceUnhealthy = true;
      recovering();
      scheduleIceRestart((failed ? 0 : DISCONNECTED_GRACE_MS) + roleDelay);
    }
  };
  pc.onconnectionstatechange = updateIce;
  pc.oniceconnectionstatechange = updateIce;

  pc.onicecandidate = ({ candidate }) => {
    if (!active() || !candidate) return;
    const signal: Signal = {
      kind: "ice-candidate", fromUserId: userId, candidate: candidate.candidate,
      sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: candidate.usernameFragment,
    };
    if (descriptionInProgress || !localSignals.length) {
      stagedCandidates.push(signal);
      trimCandidates(stagedCandidates);
    } else if (matchesIceGeneration(localSignals[0]!.sdp!, signal)) {
      localSignals.push(signal);
      flush();
      const removed = trimCandidates(localSignals, 1);
      if (removed >= 0 && removed < sent) sent--;
    }
  };

  const addCandidate = async (signal: Signal) => {
    if (!remoteSdp) return false;
    if (!matchesIceGeneration(remoteSdp, signal)) return false;
    const key = JSON.stringify([signal.candidate, signal.sdpMid, signal.sdpMLineIndex]);
    if (addedCandidates.has(key)) return true;
    try {
      await pc.addIceCandidate({
        candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex, usernameFragment: signal.usernameFragment,
      });
    } catch (error) {
      // Legacy candidates can arrive from the previous ICE generation without a username fragment.
      if (!(error instanceof DOMException && error.name === "OperationError")) throw error;
    }
    if (addedCandidates.size === MAX_CANDIDATES) addedCandidates.delete(addedCandidates.values().next().value!);
    addedCandidates.add(key);
    return true;
  };

  const receive = async (socket: WebSocket, signal: Signal) => {
    if (signal.kind === "ice-candidate" && typeof signal.candidate === "string") {
      if (!await addCandidate(signal) && active()) {
        incomingCandidates.push(signal);
        trimCandidates(incomingCandidates);
      }
      return;
    }
    if (!signal.sdp || signal.sdp === remoteSdp) return;
    if (signal.kind === "offer") {
      if (pc.signalingState === "have-local-offer") {
        // The initiator wins glare between two updated clients. Yield to a legacy peer.
        if (caller && signal.offerId) return;
        await pc.setLocalDescription({ type: "rollback" });
        if (!active()) return;
        offerId = undefined;
        localSignals = [];
        sent = 0;
      }
      descriptionInProgress = true;
      stagedCandidates = [];
      try {
        await acceptCallOffer(pc, socket, signal.sdp, active, (sdp) => {
          publishDescription({ kind: "answer", sdp, fromUserId: userId, offerId: signal.offerId });
        });
      } finally {
        descriptionInProgress = false;
      }
    } else if (signal.kind === "answer") {
      if (pc.signalingState !== "have-local-offer" || (signal.offerId && signal.offerId !== offerId)) return;
      await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
    } else {
      return;
    }
    if (!active()) return;
    remoteSdp = signal.sdp;
    addedCandidates.clear();
    for (const candidate of incomingCandidates.splice(0)) {
      if (!active()) return;
      await addCandidate(candidate);
    }
  };

  function disconnect(socket: WebSocket) {
    if (!active() || ws !== socket) return;
    ws = null;
    ready = false;
    socketLost = true;
    if (restartSent) reopenedForIce = true;
    clearTimeout(handshakeTimer);
    socket.close();
    recovering();
    const delay = BACKOFF_MS[Math.min(attempts++, BACKOFF_MS.length - 1)]!;
    reconnectTimer = setTimeout(() => void reconnect(), delay);
  }

  async function reconnect() {
    if (!active()) return;
    try {
      // The authenticated call lookup refreshes expired access tokens through the normal
      // API rotation path. Read the socket token only after that request and epoch check.
      const call = await withNativeDeadline(CALL_STATUS_TIMEOUT_MS,
        (signal) => api.get<GetCallResponse>(`/api/calls/${callId}`, signal), requestLifetime.signal);
      if (!active()) return;
      if (call.status !== "active") { onTerminal(); return; }
      openSocket(true);
    } catch (error) {
      if (!active()) return;
      const status = (error as { status?: number })?.status;
      if (status === 401 || status === 403 || status === 404 || status === 410) { onTerminal(); return; }
      const delay = BACKOFF_MS[Math.min(attempts++, BACKOFF_MS.length - 1)]!;
      reconnectTimer = setTimeout(() => void reconnect(), delay);
    }
  }

  function openSocket(resuming: boolean) {
    const after = resuming && resumeSupported ? `&after=${cursor}${replayId ? `&replay=${encodeURIComponent(replayId)}` : ""}` : "";
    const socket = new WebSocket(`${resolveWsBaseUrl()}/ws/call/${callId}?resume=1${after}`,
      [`token.${useAuthStore.getState().accessToken}`]);
    ws = socket;
    let repeatedOffer: string | undefined;
    const currentSocket = () => active() && ws === socket;
    const opened = async (acknowledged: boolean) => {
      if (!currentSocket() || ready) return;
      clearTimeout(handshakeTimer);
      ready = true;
      socketLost = false;
      attempts = 0;
      // Legacy replay runs before this fallback. An offer replayed during initial
      // setup may still be waiting for the answer previously queued on the old socket.
      const pendingOffer = pc.signalingState === "have-local-offer" && localSignals[0]?.kind === "offer";
      const pendingAnswer = !everConnected && repeatedOffer !== undefined && repeatedOffer === remoteSdp && localSignals[0]?.kind === "answer";
      if (resuming && (acknowledged || pendingOffer || pendingAnswer)) sent = 0;
      if (caller && !initialOfferStarted && !remoteSdp) {
        initialOfferStarted = true;
        await makeOffer(false);
      }
      if (!currentSocket()) return;
      flush();
      updateIce();
      if (iceUnhealthy) scheduleIceRestart(DISCONNECTED_GRACE_MS + roleDelay);
      transportHealthy();
    };

    socket.onopen = () => {
      if (!currentSocket()) return;
      clearTimeout(handshakeTimer);
      if (!resuming) return enqueue(() => opened(false));
      // A rolled-back or older Worker sends legacy replay without an acknowledgment.
      handshakeTimer = setTimeout(() => {
        resumeSupported = false;
        cursor = 0;
        replayId = undefined;
        void enqueue(() => opened(false));
      }, 2000);
    };
    socket.onmessage = (event) => enqueue(async () => {
      if (!currentSocket()) return;
      const frame = JSON.parse(event.data);
      if (frame.type === "call-resume-ack" && frame.version === 1) {
        resumeSupported = true;
        await opened(true);
        return;
      }
      if (frame.type !== WSFrameType.Signal || frame.payload?.fromUserId === userId) return;
      const { sequence, replayId: incomingReplay, payload } = frame as WSSignalFrame;
      if (sequence !== undefined && incomingReplay === replayId && sequence <= cursor) return;
      if (resuming && !ready && payload.kind === "offer" && payload.sdp === remoteSdp) repeatedOffer = payload.sdp;
      await receive(socket, payload);
      if (active() && sequence !== undefined) {
        cursor = sequence;
        replayId = incomingReplay;
      }
    });
    socket.onclose = (event) => {
      if (!currentSocket()) return;
      if (event.code === 4403) { onError(new LocalizedError("callSignalingFailed")); return; }
      if (event.code === 4409 || (event.code === 1000 && (event.reason === "Call ended" || event.reason === "Ring timeout"))) { onTerminal(); return; }
      disconnect(socket);
    };
    socket.onerror = () => disconnect(socket);
    handshakeTimer = setTimeout(() => disconnect(socket), 10_000);
  }

  openSocket(false);
  return {
    hasConnected: () => everConnected || connected(),
    stop() {
      stopped = true;
      requestLifetime.abort();
      clearTimeout(reconnectTimer);
      clearTimeout(handshakeTimer);
      clearTimeout(iceTimer);
      clearDeadline();
      ws?.close();
      ws = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onicecandidate = null;
    },
  };
}
