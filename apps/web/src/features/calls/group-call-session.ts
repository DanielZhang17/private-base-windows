import { fromBase64Url, toBase64Url } from "@e2ee-chat/crypto";
import {
  GROUP_CALL_CAPABILITY, GROUP_CALL_RECONNECT_MS, GROUP_SIGNAL_VERSION, groupRoutedSignalSchema,
  sameGroupCallPeer, type GroupCallExitReason, type GroupCallKey,
  type GroupCallPeer, type GroupCallRoom, type GroupRoutedSignal, type GroupSignalBody, type GroupSignalServerFrame,
} from "@e2ee-chat/shared";
import { api, ApiError, resolveWsBaseUrl } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { fetchTurnCredentials } from "../../services/webrtc.js";
import { encryptGroupCallControl } from "../../lib/message-processor.js";
import { decryptData, encryptData } from "../../lib/local-key-encryption.js";
import { syncMessages } from "../../lib/message-sync.js";
import {
  captureCallCamera, captureDisplayMedia, captureUserMedia, listCallCameras, watchCallCameras, type CallCamera,
} from "../../platform/media.js";
import { platformName } from "../../platform/environment.js";
import type { GroupFrameKey } from "../../services/group-frame-transform.js";
import { groupCallGrantId, groupCallPeerIdentity, importGroupCallKey, openGroupCallGrant } from "./group-call-keys.js";
import { GroupMeshPeer, type GroupPeerConnection, type GroupTrackName } from "./group-mesh-peer.js";
import { loadGroupCallStatus } from "./group-call-api.js";

export interface GroupMediaState {
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
  receivingVideo: boolean;
}
export interface GroupCallTile extends GroupCallPeer {
  stage: GroupPeerConnection;
  stream: MediaStream | null;
  screen: MediaStream | null;
  quality: "ok" | "poor";
  keyWaiting: boolean;
  secureMedia: boolean;
  videoPaused: boolean;
  media: GroupMediaState | null;
  speaking: boolean;
}
export interface GroupCallSessionView {
  room: GroupCallRoom;
  stage: "waiting" | "connecting" | "live" | "reconnecting";
  tiles: GroupCallTile[];
  localStream: MediaStream;
  localScreen: MediaStream;
  media: GroupMediaState;
  activeSpeakerId: string | null;
  secureMedia: boolean;
  cameras: CallCamera[];
  cameraId: string | null;
  mediaError: "microphone" | "camera" | "screen" | null;
  canShareScreen: boolean;
  screenShareOwnerId: string | null;
  videoPaused: boolean;
  quality: "ok" | "poor";
}
export interface GroupCallTransientEvent {
  userId: string;
  kind: "joined" | "sharing" | "left" | "lost_connection" | "removed" | "timed_out";
  at: number;
}
interface PeerSession {
  participant: GroupCallPeer;
  mesh: GroupMeshPeer | null;
  key: GroupFrameKey | null;
  failed: boolean;
  quality: GroupCallTile["quality"];
  media: GroupMediaState | null;
  pendingMedia?: Extract<GroupSignalBody, { kind: "media" }>;
  pending: GroupRoutedSignal[];
  analyser?: AnalyserNode;
  source?: MediaStreamAudioSourceNode;
  levels: number[];
  speakingUntil: number;
  secureDeadline: number;
  keyWaitingSince: number;
  mediaDirty: boolean;
  receivingVideo?: boolean;
  sendingMedia?: boolean;
  grant?: { pending?: Awaited<ReturnType<typeof encryptGroupCallControl>> & { id: string }; sent?: true; retryAt: number };
}
interface SessionEvents {
  change: (view: GroupCallSessionView) => void;
  exit: (reason: GroupCallExitReason, room: GroupCallRoom) => void;
  event: (event: GroupCallTransientEvent) => void;
  metric: (event: "reconnect" | "peer_lost" | "key_wait") => void;
}

const rosterProofMs = 20_000;
// Both TURN providers issue one-hour credentials. Refresh before expiry to
// leave time for gathering and the peer's corresponding SDP exchange.
const turnRefreshMs = 59 * 60_000;
const turnLifetimeMs = 60 * 60_000 - 1000; // Allow for the legacy provider rounding down to whole seconds.
const turnFetchTimeoutMs = 5000;
const turnRetryMs = 8000;
const defaultStunConfig: RTCConfiguration = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const mediaAAD = (epoch: number, from: GroupCallPeer, to: GroupCallPeer, callId: string) =>
  encoder.encode(JSON.stringify(["group-call-media-v1", callId, epoch, from.sessionId, to.sessionId]));

function readMediaState(bytes: Uint8Array): GroupMediaState | null {
  const state = JSON.parse(decoder.decode(bytes)) as GroupMediaState;
  return state && [state.muted, state.cameraOff, state.sharing, state.receivingVideo].every((value) => typeof value === "boolean") ? state : null;
}

export class GroupCallSession {
  private room: GroupCallRoom;
  private peers = new Map<string, PeerSession>();
  private life = new AbortController();
  private socket: WebSocket | null = null;
  private ready = false;
  private rosterProofUntil = 0;
  private cursor = 0;
  private connectedOnce = false;
  private socketLostAt: number | null = null;
  private socketAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private openDeadline: ReturnType<typeof setTimeout> | undefined;
  private signalQueue: GroupRoutedSignal[] = [];
  private rtcConfig: RTCConfiguration | undefined;
  private stunConfig = defaultStunConfig;
  private rtcConfigUntil = 0;
  private iceRefreshAt = 0;
  private iceFetchAt = -Infinity;
  private iceFetch?: Promise<RTCConfiguration>;
  private preparingConnections = false;
  private localKey: GroupFrameKey | null = null;
  private rawKey: Uint8Array | null = null;
  private readingKeys = false;
  private nextKeyReadAt = 0;
  private tracks: Record<GroupTrackName, MediaStreamTrack | null> = { audio: null, camera: null, screen: null };
  private mediaJobs: Partial<Record<GroupTrackName, Promise<void>>> = {};
  private captureLife: Record<GroupTrackName, number> = { audio: 0, camera: 0, screen: 0 };
  private wantsCamera: boolean;
  private camera: CallCamera | undefined;
  private readonly localStream = new MediaStream();
  private readonly localScreen = new MediaStream();
  private muted = false;
  private cameras: CallCamera[] = [];
  private mediaError: GroupCallSessionView["mediaError"] = null;
  private speaker: string | null = null;
  private context?: AudioContext;
  private ticker: ReturnType<typeof setInterval>;
  private voiceTicker: ReturnType<typeof setInterval>;
  private step = 0;
  private backgrounded = false;
  private videoPaused = false;
  private removeCameraWatcher: () => void;

  constructor(room: GroupCallRoom, readonly self: GroupCallPeer, cameraOff: boolean, private events: SessionEvents, audio?: AudioContext) {
    this.room = { ...room, epoch: 0 };
    this.wantsCamera = room.type === "video" && !cameraOff;
    this.context = audio;
    this.removeCameraWatcher = watchCallCameras(() => void this.updateCameras());
    document.addEventListener("visibilitychange", this.onVisibility);
    this.ticker = setInterval(() => void this.tick(), 1000);
    this.voiceTicker = setInterval(() => this.measureSpeakers(), 100);
    this.applyRoom(room);
    this.onVisibility();
    this.connect();
    void this.retryMicrophone();
    if (this.wantsCamera && !this.backgrounded) void this.acquireCamera();
  }

  get signal() { return this.life.signal; }

  private get current() { return !this.life.signal.aborted; }

  private viewMedia(peer?: PeerSession): GroupMediaState {
    return { muted: this.muted || !this.tracks.audio, cameraOff: !this.tracks.camera,
      sharing: !!this.tracks.screen, receivingVideo: !this.backgrounded && (!peer || this.receivesVideo(peer)) };
  }

  private emit() {
    if (!this.current) return;
    const tiles = this.room.participants.flatMap((participant): GroupCallTile[] => {
      const peer = this.peers.get(participant.userId);
      if (!peer || peer.failed) return [];
      const mesh = peer.mesh;
      const secured = !!mesh?.secureMedia;
      const keyWaiting = this.awaitingSecureMedia(peer) && Date.now() - peer.keyWaitingSince > 2500;
      const noExpectedMedia = peer.media?.muted && (this.room.type === "audio" || peer.media.cameraOff && !peer.media.sharing);
      const stage: GroupPeerConnection = participant.reconnecting || keyWaiting || this.socketLostAt !== null
        ? "reconnecting"
        : mesh?.connection === "live" ? (secured || noExpectedMedia ? "live" : "connecting") : mesh?.connection ?? "connecting";
      return [{ ...groupCallPeerIdentity(participant), stage, stream: mesh?.stream.getTracks().length ? mesh.stream : null,
        screen: mesh?.screen.getTracks().length ? mesh.screen : null, keyWaiting, secureMedia: secured, videoPaused: !this.receivesVideo(peer),
        quality: peer.quality, media: peer.media, speaking: peer.speakingUntil > Date.now() }];
    });
    const stage = this.socketLostAt !== null ? "reconnecting" : this.room.participants.length === 1 ? "waiting"
      : tiles.some((tile) => tile.stage === "live") ? "live"
      : tiles.some((tile) => tile.stage === "reconnecting") ? "reconnecting" : "connecting";
    const screenShareOwnerId = this.screenShareOwner();
    this.events.change({
      room: this.room, stage, tiles, localStream: this.localStream, localScreen: this.localScreen,
      media: this.viewMedia(), activeSpeakerId: this.speaker, secureMedia: tiles.some((tile) => tile.secureMedia),
      mediaError: this.mediaError, screenShareOwnerId,
      canShareScreen: this.room.type === "video" && !this.backgrounded
        && typeof navigator.mediaDevices?.getDisplayMedia === "function"
        && (screenShareOwnerId === null || screenShareOwnerId === this.self.userId), cameras: this.cameras, cameraId: this.camera?.id ?? null,
      videoPaused: this.videoPaused, quality: tiles.length && tiles.every((tile) => tile.quality === "poor") ? "poor" : "ok",
    });
  }

  private closeMesh(peer: PeerSession) {
    peer.mesh?.close();
    peer.source?.disconnect();
    peer.analyser?.disconnect();
    peer.mesh = null;
    peer.source = undefined;
    peer.analyser = undefined;
    peer.levels = [];
    peer.speakingUntil = 0;
    peer.pending = [];
  }

  private closePeer(peer: PeerSession) {
    this.closeMesh(peer);
    peer.key = null;
    peer.grant = undefined;
    peer.failed = true;
  }

  private suspendMedia() {
    this.ready = false;
    this.rosterProofUntil = 0;
    // Close the RTP transport synchronously. Clearing a worker transform's
    // key by itself would depend on when its MessagePort processes the update.
    for (const peer of this.peers.values()) this.closeMesh(peer);
    this.signalQueue = [];
    this.speaker = null;
  }

  private applyRoom(room: GroupCallRoom, departures: { userId: string; reason: GroupCallExitReason }[] = []) {
    if (!this.current || room.id !== this.room.id || room.epoch < this.room.epoch) return;
    if (room.endedAt !== null || !room.participants.some((p) => sameGroupCallPeer(p, this.self))) {
      const reason = room.endReason ?? (room.participants.some((p) => p.userId === this.self.userId) ? "moved" : "lost_connection");
      this.exit(reason, room);
      return;
    }
    const changed = room.epoch !== this.room.epoch;
    const first = this.room.epoch === 0;
    this.room = room;
    if (changed) {
      this.cursor = 0;
      this.signalQueue = [];
      this.localKey = null;
      this.rawKey?.fill(0);
      this.rawKey = crypto.getRandomValues(new Uint8Array(32));
      this.nextKeyReadAt = 0;
      for (const [id, peer] of this.peers) {
        const stillHere = room.participants.some((p) => sameGroupCallPeer(p, peer.participant));
        if (!stillHere || peer.failed) {
          this.closePeer(peer);
          this.peers.delete(id);
          if (!stillHere && !room.participants.some((p) => p.userId === id)) {
            const reason = departures.find((entry) => entry.userId === id)?.reason;
            this.events.event({ userId: id, kind: reason === "removed" || reason === "lost_connection" || reason === "timed_out" ? reason : "left", at: Date.now() });
          }
          continue;
        }
        peer.mesh?.setEpoch(room.epoch);
        if (this.ready && peer.mesh?.connection !== "live") peer.mesh?.ensureOffer(true);
        peer.key = null;
        peer.grant = undefined;
        peer.pending = [];
        peer.pendingMedia = undefined;
        peer.keyWaitingSince = Date.now();
        peer.secureDeadline = Date.now() + GROUP_CALL_RECONNECT_MS;
        peer.mediaDirty = true;
      }
      this.ensurePeers(first);
      if (this.ready) void this.distributeKeys();
      this.refreshKeys();
    }
    this.emit();
  }

  private ensurePeers(first: boolean) {
    for (const participant of this.room.participants) {
      if (participant.userId === this.self.userId || this.peers.has(participant.userId)) continue;
      const id = participant.userId;
      const peer: PeerSession = {
        participant: groupCallPeerIdentity(participant), mesh: null, key: null, failed: false, quality: "ok", media: null,
        levels: [], speakingUntil: 0, secureDeadline: Date.now() + GROUP_CALL_RECONNECT_MS,
        keyWaitingSince: Date.now(), pending: [], mediaDirty: true,
      };
      this.peers.set(id, peer);
      if (!first) this.events.event({ userId: id, kind: "joined", at: Date.now() });
    }
    void this.createConnections();
  }

  private async createConnections() {
    if (!this.current || !this.ready || this.preparingConnections) return;
    if (!this.peers.size || [...this.peers.values()].every((peer) => peer.mesh || peer.failed)) return;
    this.preparingConnections = true;
    const config = await this.configRtc().finally(() => { this.preparingConnections = false; });
    if (!this.current || !this.ready) return;
    for (const peer of this.peers.values()) {
      if (peer.mesh || peer.failed) continue;
      try {
        peer.mesh = new GroupMeshPeer(config, this.room.type === "video", this.self.userId < peer.participant.userId,
          (body) => this.send(peer, body), () => this.emit(), () => this.configRtc());
        peer.mesh.setEpoch(this.room.epoch);
        peer.mesh.setKeys(this.outboundKey(peer), peer.key);
        this.updatePeerTracks(peer);
        for (const frame of peer.pending) peer.mesh.receive(frame.body, frame.epoch);
        peer.pending = [];
        if (this.ready) peer.mesh.ensureOffer();
      } catch { this.losePeer(peer); }
    }
    this.emit();
  }

  private configRtc(): Promise<RTCConfiguration> {
    const now = Date.now();
    const usable = () => this.rtcConfig && Date.now() < this.rtcConfigUntil ? this.rtcConfig : this.stunConfig;
    if (!this.current || now < this.iceRefreshAt) return Promise.resolve(usable());
    if (this.iceFetch) return this.iceFetch;
    if (now - this.iceFetchAt < turnRetryMs) return Promise.resolve(usable());
    this.iceFetchAt = now;
    const request = new AbortController();
    const abort = () => request.abort();
    this.life.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, turnFetchTimeoutMs);
    // Release all waiting peers at the deadline, even if the transport has
    // not settled yet. Late responses cannot replace a newer configuration.
    const cancelled = new Promise<undefined>((resolve) => {
      request.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    this.iceFetch = Promise.race([fetchTurnCredentials(request.signal), cancelled]).then((credentials) => {
      if (credentials && !request.signal.aborted && Date.now() < now + turnLifetimeMs) {
        const { iceServers } = credentials;
        const stunUrls = iceServers.flatMap(({ urls }) => urls).filter((url) => /^stuns?:/i.test(url));
        this.stunConfig = stunUrls.length ? { iceServers: [{ urls: stunUrls }] } : defaultStunConfig;
        this.rtcConfig = { iceServers };
        this.rtcConfigUntil = now + turnLifetimeMs;
        this.iceRefreshAt = now + turnRefreshMs;
      }
      return usable();
    }).catch(usable).finally(() => {
      clearTimeout(timeout);
      this.life.signal.removeEventListener("abort", abort);
      this.iceFetch = undefined;
    });
    return this.iceFetch;
  }

  private connect() {
    const token = useAuthStore.getState().accessToken;
    if (!this.current || !token) return;
    const query = new URLSearchParams({
      version: String(GROUP_SIGNAL_VERSION), cap: GROUP_CALL_CAPABILITY, callId: this.room.id, sessionId: this.self.sessionId,
      epoch: String(this.room.epoch), after: String(this.cursor),
    });
    const socket = new WebSocket(`${resolveWsBaseUrl()}/ws/group-call/${this.room.conversationId}?${query}`, [`token.${token}`]);
    this.socket = socket;
    this.openDeadline = setTimeout(() => socket.close(), 8000);
    const current = () => this.current && this.socket === socket;
    const rebuilding = this.connectedOnce && !this.ready;
    let confirmedRoster = false;
    socket.onmessage = (message) => {
      if (!current()) return;
      let frame: GroupSignalServerFrame;
      try { frame = JSON.parse(message.data); } catch { return; }
      if (frame.version !== GROUP_SIGNAL_VERSION) return;
      if (frame.type === "group-exit") { this.exit(frame.reason, frame.room); return; }
      if (frame.type === "group-roster") {
        if (frame.room.id !== this.room.id || frame.room.epoch < this.room.epoch) return;
        this.applyRoom(frame.room, frame.departed);
        confirmedRoster = this.current;
        if (this.ready && this.current) this.refreshRosterProof();
        return;
      }
      if (frame.type === "group-heartbeat-ack") {
        if (this.ready && frame.epoch === this.room.epoch) this.refreshRosterProof();
        return;
      }
      if (frame.type === "group-resume-ack") {
        if (this.ready || !confirmedRoster || frame.epoch !== this.room.epoch) return;
        clearTimeout(this.openDeadline);
        this.ready = true;
        this.refreshRosterProof();
        this.connectedOnce = true;
        this.socketAttempt = 0;
        this.socketLostAt = null;
        const queued = this.signalQueue;
        this.signalQueue = [];
        try {
          for (const entry of queued) if (entry.epoch === this.room.epoch) socket.send(JSON.stringify(entry));
        } catch {
          this.suspendMedia();
          socket.close();
          return;
        }
        this.cursor = Math.max(this.cursor, frame.cursor);
        for (const peer of this.peers.values()) {
          if (rebuilding && !peer.failed) {
            peer.pending = [];
            peer.secureDeadline = Date.now() + GROUP_CALL_RECONNECT_MS;
            this.send(peer, { kind: "restart", reset: true });
          }
          peer.mediaDirty = true;
        }
        void this.createConnections();
        void this.distributeKeys();
        this.emit();
        return;
      }
      if (frame.type !== "group-signal") return;
      const { sequence, ...routed } = frame;
      const validation = groupRoutedSignalSchema.safeParse(routed);
      if (!validation.success || !Number.isSafeInteger(sequence) || sequence <= this.cursor || frame.callId !== this.room.id
        || frame.epoch !== this.room.epoch || !sameGroupCallPeer(frame.to, this.self)) return;
      const peer = this.peers.get(frame.from.userId);
      if (!peer || peer.failed || !sameGroupCallPeer(frame.from, peer.participant)) return;
      this.cursor = sequence;
      if (frame.body.kind === "media") {
        peer.pendingMedia = frame.body;
        void this.readMedia(peer);
      } else if (frame.body.kind === "restart" && frame.body.reset) {
        this.closeMesh(peer);
        peer.secureDeadline = Date.now() + GROUP_CALL_RECONNECT_MS;
        peer.mediaDirty = true;
        void this.createConnections();
      } else if (peer.mesh) peer.mesh.receive(frame.body, frame.epoch);
      else if (peer.pending.length < 100) peer.pending.push(routed);
    };
    socket.onclose = (event) => {
      if (!current()) return;
      clearTimeout(this.openDeadline);
      this.suspendMedia();
      if (event.code === 4409) {
        const terminal = ["moved", "removed", "timed_out", "left", "empty", "alone", "ended_for_everyone", "group_deleted", "lost_connection"] as const;
        const reason = terminal.find((entry) => entry === event.reason);
        this.exit(reason ?? "moved", this.room);
        return;
      }
      if (this.socketLostAt === null && this.connectedOnce) this.events.metric("reconnect");
      this.socketLostAt ??= Date.now();
      this.reconnectTimer = setTimeout(() => void this.reconnect(), Math.min(500 * 2 ** this.socketAttempt++, 5000));
      this.emit();
    };
    socket.onerror = () => { if (current()) { this.suspendMedia(); socket.close(); } };
  }

  private async reconnect() {
    if (!this.current) return;
    if (this.socketAttempt >= 3) {
      try {
        const status = await loadGroupCallStatus(this.room.conversationId, this.life.signal);
        if (!this.current) return;
        if (status.room) this.applyRoom(status.room);
        else {
          const ended = status.lastEnded?.id === this.room.id ? status.lastEnded : undefined;
          this.exit(ended?.endReason ?? "lost_connection", ended ?? this.room);
          return;
        }
      } catch (error) {
        if (this.current && error instanceof ApiError && error.status === 403) {
          this.exit("removed", this.room);
          return;
        }
      }
    }
    this.connect();
  }

  private send(peer: PeerSession, body: GroupSignalBody) {
    if (!this.current || peer.failed || this.peers.get(peer.participant.userId) !== peer) return;
    const frame = { type: "group-signal", version: GROUP_SIGNAL_VERSION, callId: this.room.id, epoch: this.room.epoch,
      from: this.self, to: peer.participant, body } satisfies GroupRoutedSignal;
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
      try { this.socket.send(JSON.stringify(frame)); return; } catch { this.suspendMedia(); this.socket.close(); }
    }
    if (body.kind !== "ice") this.signalQueue = this.signalQueue.filter((prior) =>
      !sameGroupCallPeer(prior.to, peer.participant) || prior.body.kind !== body.kind);
    if (this.signalQueue.length >= 150) {
      const ice = this.signalQueue.findIndex((entry) => entry.body.kind === "ice");
      this.signalQueue.splice(ice < 0 ? 0 : ice, 1);
    }
    this.signalQueue.push(frame);
  }

  private async distributeKeys() {
    if (!this.ready || !this.rawKey) return;
    const room = this.room;
    const call = { callId: room.id, epoch: room.epoch, sessionId: this.self.sessionId };
    const raw = this.rawKey;
    const now = Date.now();
    const peers = [...this.peers.values()].filter((peer) =>
      !peer.failed && !peer.grant?.sent && (peer.grant?.retryAt ?? 0) <= now);
    if (!peers.length) return;
    const key = this.localKey ? Promise.resolve(this.localKey.key) : importGroupCallKey(raw);
    await Promise.allSettled(peers.map(async (peer) => {
      const grant = peer.grant ??= { retryAt: 0 };
      // A stalled recipient must not block another recipient's grant or its
      // sender slot, even while an earlier request to that recipient is pending.
      grant.retryAt = Infinity;
      const active = () => this.current && this.ready && this.room.epoch === room.epoch && !peer.failed;
      try {
        const cryptoKey = await key;
        if (!active()) return;
        this.localKey ??= { epoch: room.epoch, key: cryptoKey };
        if (!grant.pending) {
          const to = peer.participant;
          const payload: GroupCallKey = { kind: "group_call_key", conversationId: room.conversationId,
            callId: room.id, epoch: room.epoch, from: this.self, to, key: toBase64Url(raw) };
          const id = await groupCallGrantId(room, this.self, to);
          if (!active()) return;
          grant.pending = { id, ...await encryptGroupCallControl(JSON.stringify(payload), to.userId, to.deviceId, {
            ...call, conversationId: room.conversationId,
          }) };
        }
        if (!active()) return;
        await api.post("/api/messages/send-direct-batch?callControl=1", { conversationId: room.conversationId, type: "system", messages: [grant.pending],
          groupCall: call,
        }, { signal: this.life.signal });
        if (!active()) return;
        grant.sent = true;
        peer.mesh?.setKeys(this.outboundKey(peer), peer.key);
        peer.mediaDirty = true;
      } finally {
        grant.retryAt = Date.now() + 2000;
      }
    }));
    if (this.rawKey === raw && [...this.peers.values()].every((peer) => peer.failed || peer.grant?.sent)) {
      raw.fill(0);
      this.rawKey = null;
    }
  }

  private outboundKey(peer: PeerSession): GroupFrameKey | null {
    return this.ready && peer.grant?.sent && this.localKey && this.rosterProofUntil > Date.now()
      ? { ...this.localKey, validUntil: this.rosterProofUntil } : null;
  }

  private refreshRosterProof() {
    this.rosterProofUntil = Date.now() + rosterProofMs;
    for (const peer of this.peers.values()) peer.mesh?.setKeys(this.outboundKey(peer), peer.key);
  }

  refreshKeys() {
    this.nextKeyReadAt = 0;
    void this.readKeys(true);
  }

  private async readKeys(sync: boolean) {
    const room = this.room;
    const peers = [...this.peers.values()].filter((peer) => !peer.key && !peer.failed);
    if (this.readingKeys || !peers.length || Date.now() < this.nextKeyReadAt) return;
    this.readingKeys = true;
    this.nextKeyReadAt = Date.now() + 5000;
    try {
      if (sync) await syncMessages({ force: true, callControl: true }).catch(() => undefined);
      await Promise.allSettled(peers.map(async (peer) => {
        const raw = await openGroupCallGrant(room, peer.participant, this.self);
        if (!raw) return;
        const key = await importGroupCallKey(raw);
        raw.fill(0);
        if (!this.current || room.epoch !== this.room.epoch || peer.failed) return;
        peer.key = { epoch: room.epoch, key };
        peer.mesh?.setKeys(this.outboundKey(peer), peer.key);
        await this.readMedia(peer);
      }));
    } finally { this.readingKeys = false; }
    this.emit();
  }

  private async readMedia(peer: PeerSession) {
    const item = peer.pendingMedia;
    const key = peer.key;
    const room = this.room;
    if (!item || !key || key.epoch !== room.epoch) return;
    try {
      const state = readMediaState(await decryptData(key.key, item.iv, item.ciphertext,
        mediaAAD(room.epoch, peer.participant, this.self, room.id)));
      if (!state || !this.current || item !== peer.pendingMedia || room.epoch !== this.room.epoch || peer.failed) return;
      if (!peer.media?.sharing && state.sharing) this.events.event({ userId: peer.participant.userId, kind: "sharing", at: Date.now() });
      peer.media = state;
      peer.pendingMedia = undefined;
      const owner = this.screenShareOwner();
      if (owner && owner !== this.self.userId && (this.tracks.screen || this.mediaJobs.screen)) {
        ++this.captureLife.screen;
        this.setTrack("screen", null);
      }
      this.updatePeerTracks(peer);
      this.updateVideoPolicy();
      this.emit();
    } catch { if (item === peer.pendingMedia) peer.pendingMedia = undefined; }
  }

  private async sendMedia(peer: PeerSession) {
    const room = this.room;
    const slot = this.outboundKey(peer);
    if (!slot || !this.ready || !peer.mediaDirty || peer.failed || peer.sendingMedia) return;
    peer.mediaDirty = false;
    peer.sendingMedia = true;
    try {
      const media = await encryptData(slot.key, encoder.encode(JSON.stringify(this.viewMedia(peer))),
        mediaAAD(room.epoch, this.self, peer.participant, room.id));
      if (this.current && room.epoch === this.room.epoch) this.send(peer, { kind: "media", ...media });
    } catch { peer.mediaDirty = true; } finally { peer.sendingMedia = false; }
  }

  private losePeer(peer: PeerSession) {
    if (peer.failed) return;
    if (this.awaitingSecureMedia(peer)) this.events.metric("key_wait");
    this.events.metric("peer_lost");
    this.closePeer(peer);
    this.events.event({ userId: peer.participant.userId, kind: "lost_connection", at: Date.now() });
    this.emit();
  }

  private async tick() {
    if (!this.current) return;
    const now = Date.now();
    const step = ++this.step;
    if (this.socketLostAt !== null && now - this.socketLostAt > GROUP_CALL_RECONNECT_MS) {
      this.exit("lost_connection", this.room);
      return;
    }
    if (this.ready && now >= this.rosterProofUntil) {
      this.suspendMedia();
      this.socket?.close();
      return;
    }
    if (this.ready && step % 10 === 0 && this.socket) {
      try { this.socket.send('{"type":"group-heartbeat","version":2}'); }
      catch { this.suspendMedia(); this.socket.close(); }
    }
    void this.createConnections();
    if (this.ready) void this.distributeKeys();
    void this.readKeys(true);
    for (const peer of this.peers.values()) {
      if (peer.failed) continue;
      if (this.ready && ((!peer.mesh || this.awaitingSecureMedia(peer)) && now >= peer.secureDeadline
        || (peer.mesh && !peer.mesh.recover(now, true)))) {
        this.losePeer(peer);
        continue;
      }
      void this.sendMedia(peer);
      if (peer.mesh && step % 2 === 0) {
        void peer.mesh.quality(now).then((quality) => {
          if (!this.current || peer.failed) return;
          peer.quality = quality;
          this.updatePeerTracks(peer);
          this.updateVideoPolicy();
          this.emit();
        }).catch(() => undefined);
      }
    }
    this.emit();
  }

  private measureSpeakers() {
    if (!this.current || !this.context || this.context.state !== "running") return;
    const now = Date.now();
    let changed = false;
    let strongest: { id: string; rms: number } | undefined;
    for (const [id, peer] of this.peers) {
      if (peer.failed || peer.media?.muted || !peer.mesh?.stream.getAudioTracks().length) {
        if (peer.speakingUntil) { peer.speakingUntil = 0; changed = true; }
        continue;
      }
      if (!peer.analyser) {
        peer.analyser = this.context.createAnalyser();
        peer.analyser.fftSize = 1024;
        peer.source = this.context.createMediaStreamSource(peer.mesh.stream);
        peer.source.connect(peer.analyser);
      }
      const data = new Float32Array(peer.analyser.fftSize);
      peer.analyser.getFloatTimeDomainData(data);
      peer.levels.push(data.reduce((sum, value) => sum + value * value, 0) / data.length);
      if (peer.levels.length > 3) peer.levels.shift();
      const rms = Math.sqrt(peer.levels.reduce((sum, value) => sum + value, 0) / peer.levels.length);
      if (peer.levels.length === 3 && rms >= 0.025) {
        if (peer.speakingUntil <= now) changed = true;
        peer.speakingUntil = now + 1500;
      } else if (peer.speakingUntil > 0 && peer.speakingUntil <= now) { peer.speakingUntil = 0; changed = true; }
      if (peer.speakingUntil > now && (!strongest || rms > strongest.rms)) strongest = { id, rms };
    }
    if (!this.speaker || (this.peers.get(this.speaker)?.speakingUntil ?? 0) <= now) {
      const next = strongest?.id ?? null;
      changed ||= next !== this.speaker;
      this.speaker = next;
    }
    if (changed) { this.updateVideoPolicy(); this.emit(); }
  }

  private awaitingSecureMedia(peer: PeerSession) {
    if (!peer.key) return true;
    const media = peer.media;
    const expected = media && (!media.muted || (this.room.type === "video" && this.receivesVideo(peer) && (!media.cameraOff || media.sharing)));
    return peer.mesh?.connection === "live" && (!media || !!expected && !peer.mesh.hasAuthenticatedMedia(this.room.epoch));
  }

  private screenShareOwner() {
    const ids = [...this.peers.values()].filter((peer) => !peer.failed && peer.media?.sharing)
      .map((peer) => peer.participant.userId);
    if (this.tracks.screen) ids.push(this.self.userId);
    // Give simultaneous requests the same winner without disclosing media state to signaling.
    return ids.sort()[0] ?? null;
  }

  private receivesVideo(peer: PeerSession) {
    if (this.backgrounded) return false;
    if (!this.videoPaused) return true;
    const sharer = this.screenShareOwner();
    const priority = (sharer !== this.self.userId ? sharer : null) ?? this.speaker ?? [...this.peers.values()].find((candidate) => !candidate.failed)?.participant.userId;
    return peer.participant.userId === priority;
  }

  private updateVideoPolicy() {
    const live = [...this.peers.values()].filter((peer) => !peer.failed && peer.mesh?.connection === "live");
    const paused = this.room.type === "video" && live.length > 1 && live.filter((peer) => peer.quality === "poor").length >= Math.ceil(live.length / 2);
    if (paused === this.videoPaused && !paused) return;
    this.videoPaused = paused;
    for (const peer of this.peers.values()) {
      const receiving = this.receivesVideo(peer);
      peer.mesh?.setReceivingVideo(receiving);
      if (peer.receivingVideo !== receiving) {
        peer.receivingVideo = receiving;
        peer.mediaDirty = true;
      }
    }
  }

  private updatePeerTracks(peer: PeerSession) {
    peer.mesh?.setReceivingVideo(this.receivesVideo(peer));
    peer.mesh?.replaceTracks(this.tracks, this.backgrounded || peer.media?.receivingVideo === false);
    const kbps = peer.quality === "poor" ? 180 : Math.max(240, Math.floor(1600 / Math.max(1, this.peers.size)));
    peer.mesh?.setVideoBudget(kbps);
  }

  private mediaChanged() {
    for (const peer of this.peers.values()) {
      peer.mediaDirty = true;
      this.updatePeerTracks(peer);
      void this.sendMedia(peer);
    }
    this.emit();
  }

  private setTrack(name: GroupTrackName, track: MediaStreamTrack | null) {
    if (!this.current) { track?.stop(); return; }
    const stream = name === "screen" ? this.localScreen : this.localStream;
    const previous = this.tracks[name];
    this.tracks[name] = track;
    if (previous) { stream.removeTrack(previous); previous.stop(); }
    if (track) {
      stream.addTrack(track);
      track.onended = () => {
        if (this.tracks[name] === track) this.setTrack(name, null);
      };
    }
    this.mediaChanged();
  }

  private async updateCameras() {
    const cameras = await listCallCameras(this.tracks.camera).catch(() => []);
    if (this.current) { this.cameras = cameras; this.emit(); }
  }

  private capture(name: GroupTrackName, acquire: () => Promise<MediaStream>) {
    const intent = ++this.captureLife[name];
    const current = () => this.current && this.captureLife[name] === intent;
    const job = (async () => {
      try {
        const stream = await acquire();
        const track = name === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
        for (const other of stream.getTracks()) if (other !== track || !current()) other.stop();
        if (!current()) return;
        if (!track) throw new Error("Missing captured track");
        if (name === "audio") track.enabled = !this.muted;
        this.mediaError = null;
        this.setTrack(name, track);
        if (name === "camera") await this.updateCameras();
      } catch {
        if (!current()) return;
        this.mediaError = name === "audio" ? "microphone" : name;
        this.emit();
      }
    })();
    this.mediaJobs[name] = job;
    return job.finally(() => { if (this.mediaJobs[name] === job) delete this.mediaJobs[name]; });
  }

  retryMicrophone() {
    if (!this.current || this.tracks.audio) return Promise.resolve();
    return this.mediaJobs.audio ?? this.capture("audio", () => captureUserMedia({ audio: true }));
  }

  toggleMute() {
    if (!this.tracks.audio) return;
    this.muted = !this.muted;
    this.tracks.audio.enabled = !this.muted;
    this.mediaChanged();
  }

  private acquireCamera() {
    return this.capture("camera", () => captureCallCamera(this.camera));
  }

  toggleCamera() {
    if (this.room.type !== "video" || this.backgrounded) return Promise.resolve();
    this.wantsCamera = !this.tracks.camera && !this.mediaJobs.camera;
    if (this.wantsCamera) return this.acquireCamera();
    ++this.captureLife.camera;
    this.setTrack("camera", null);
    return Promise.resolve();
  }

  selectCamera(cameraId: string) {
    const camera = this.cameras.find((option) => option.id === cameraId);
    if (!camera) return Promise.resolve();
    this.camera = camera;
    this.emit();
    if (this.wantsCamera && !this.backgrounded) return this.acquireCamera();
    return Promise.resolve();
  }

  toggleScreen() {
    if (this.room.type !== "video" || this.backgrounded) return Promise.resolve();
    if (!this.tracks.screen && !this.mediaJobs.screen) {
      if (this.screenShareOwner() || typeof navigator.mediaDevices?.getDisplayMedia !== "function") return Promise.resolve();
      return this.capture("screen", () => captureDisplayMedia({ video: true }));
    }
    ++this.captureLife.screen;
    this.setTrack("screen", null);
    return Promise.resolve();
  }

  private onVisibility = () => {
    if (platformName() !== "android") return;
    const hidden = document.visibilityState === "hidden";
    if (this.backgrounded === hidden) return;
    this.backgrounded = hidden;
    if (hidden) {
      ++this.captureLife.camera;
      ++this.captureLife.screen;
      this.setTrack("camera", null);
      this.setTrack("screen", null);
    } else if (this.wantsCamera) void this.acquireCamera();
    this.mediaChanged();
  };

  private exit(reason: GroupCallExitReason, room: GroupCallRoom) {
    this.stop();
    this.events.exit(reason, room);
  }

  stop() {
    if (!this.current) return;
    this.life.abort();
    this.ready = false;
    clearInterval(this.ticker);
    clearInterval(this.voiceTicker);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.openDeadline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.removeCameraWatcher();
    this.socket?.close();
    this.rawKey?.fill(0);
    this.rawKey = null;
    this.localKey = null;
    for (const track of Object.values(this.tracks)) track?.stop();
    for (const peer of this.peers.values()) this.closePeer(peer);
    this.peers.clear();
    void this.context?.close().catch(() => undefined);
  }
}
