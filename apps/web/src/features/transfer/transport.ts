import { deriveHistoryTransferKeys, fromBase64Url, toBase64Url, type X25519KeyPair } from "@e2ee-chat/crypto";
import {
  HISTORY_TRANSFER_VERSION, historyTransferDeviceIdSchema, historyTransferSignalSchema,
  type HistoryTransferSignal, type HistoryTransferServerFrame,
} from "@e2ee-chat/shared";
import { resolveWsBaseUrl } from "../../services/api.js";
import { HistoryTransferStream, type HistoryTransferRole } from "./stream.js";
import { transferVersionError } from "./pairing.js";

const DATA_CHANNEL = `history-transfer-v${HISTORY_TRANSFER_VERSION}`;
const HEARTBEAT_MS = 5_000;
const CONNECTION_TIMEOUT_MS = 25_000;

interface Options {
  role: HistoryTransferRole;
  roomId: string;
  psk: string;
  deviceId: string;
  expectedPeerId?: string;
  keyPair: X25519KeyPair;
  stream: HistoryTransferStream;
  onRoom: (expiresAt: number) => void;
  onLease: (expiresAt: number) => void;
  onPeer: (deviceId: string, deviceName: string) => void | Promise<void>;
  onPause: () => void;
  onIceState: (moving: boolean) => void;
  onEnd: (reason: "cancelled" | "expired" | "access-revoked" | "rejected" | "failed" | ReturnType<typeof transferVersionError>) => void;
  onError: (reason?: ReturnType<typeof transferVersionError>) => void;
}

interface Attempt {
  id: string;
  pairingId: string;
  deviceId: string;
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  candidates: RTCIceCandidateInit[];
  keys?: Awaited<ReturnType<typeof deriveHistoryTransferKeys>>;
  timeout: ReturnType<typeof setTimeout>;
  reported?: boolean;
  restarting?: boolean;
  sendingDescription?: boolean;
  localCandidates: Extract<HistoryTransferSignal, { type: "ice" }>[];
}

export class HistoryTransferTransport {
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private attempt?: Attempt;
  private peerId?: string;
  private peerKey?: string;
  private pairingId?: string;

  constructor(private readonly options: Options) {}

  connect(token: string, iceServers: RTCIceServer[]): void {
    this.close();
    const { roomId, role, expectedPeerId } = this.options;
    const query = new URLSearchParams({ role });
    if (role === "sender" && expectedPeerId) query.set("receiver", expectedPeerId);
    const socket = new WebSocket(`${resolveWsBaseUrl()}/ws/history-transfer/${roomId}?${query}`, [`token.${token}`]);
    this.socket = socket;
    let lastPong = Date.now();
    let signals = Promise.resolve();
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket) return;
      if (Date.now() - lastPong > HEARTBEAT_MS * 3) {
        this.close();
        this.options.onPause();
      } else {
        this.signal({ type: "ping" });
      }
    }, HEARTBEAT_MS);
    socket.onerror = () => { if (this.socket === socket) socket.close(); };
    socket.onclose = ({ code }) => {
      if (this.socket !== socket) return;
      if (code === 4411) {
        void signals.then(() => { if (this.socket === socket) this.options.onEnd("version"); });
        return;
      }
      this.close();
      if (code === 4403) this.options.onEnd("access-revoked");
      else if (code === 4408) this.options.onEnd("expired");
      else if (code === 4409) this.options.onEnd("cancelled");
      else if (code === 4406) this.options.onEnd("rejected");
      else if (code === 4410) this.options.onEnd("failed");
      else this.options.onPause();
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      if (this.socket !== socket) return;
      try {
        const value = JSON.parse(event.data) as HistoryTransferServerFrame;
        if (value.type === "pong") { lastPong = Date.now(); return; }
        if (value.type === "cancel") { this.options.onEnd("cancelled"); return; }
        if (value.type === "reject") { this.options.onEnd("rejected"); return; }
        if (value.type === "abort") { this.options.onEnd("failed"); return; }
        signals = signals.then(async () => {
          if (this.socket === socket) await this.handle(socket, value, iceServers);
        }).catch(() => { if (this.socket === socket) this.options.onError(); });
      } catch {
        this.options.onError();
      }
    };
  }

  cancel(): boolean { return this.signal({ type: "cancel" }); }
  reject(): boolean { return this.signal({ type: "reject" }); }
  rejectVersion(): boolean { return this.signal({ type: "version-mismatch", v: HISTORY_TRANSFER_VERSION }); }
  abort(): boolean { return this.signal({ type: "abort" }); }

  reportPaired(): void {
    const attempt = this.attempt;
    if (attempt && !attempt.reported) attempt.reported = this.signal({ type: "paired", attempt: attempt.id });
  }

  close(): void {
    this.closeAttempt();
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
  }

  dispose(): void {
    this.close();
    this.options.psk = "";
  }

  pause(): void {
    this.closeAttempt();
    this.options.onPause();
  }

  private signal(frame: HistoryTransferSignal): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try { this.socket.send(JSON.stringify(frame)); return true; }
    catch { return false; }
  }

  private closeAttempt(): void {
    const attempt = this.attempt;
    this.attempt = undefined;
    if (!attempt) return;
    clearTimeout(attempt.timeout);
    this.options.stream.detach();
    attempt.channel?.close();
    attempt.keys?.toSender.fill(0);
    attempt.keys?.toReceiver.fill(0);
    attempt.pc.onicecandidate = attempt.pc.ondatachannel = attempt.pc.onconnectionstatechange = null;
    attempt.pc.close();
  }

  private async handle(socket: WebSocket, value: HistoryTransferServerFrame, iceServers: RTCIceServer[]): Promise<void> {
    if (value.type === "version-mismatch") { this.options.onEnd(transferVersionError(value.v)); return; }
    if (value.type === "room" || value.type === "lease") {
      if (!Number.isSafeInteger(value.expiresAt)) throw new Error("Invalid transfer expiry");
      if (value.type === "room") this.options.onRoom(value.expiresAt);
      else this.options.onLease(value.expiresAt);
      return;
    }
    if (value.type === "peer") {
      if (!historyTransferDeviceIdSchema.safeParse(value.deviceId).success) throw new Error("Invalid peer");
      await this.begin(value, iceServers);
      return;
    }
    const attempt = this.attempt;
    if (!attempt || !("attempt" in value) || attempt.id !== value.attempt) return;
    if (value.type === "peer-left") {
      this.pause();
      return;
    }
    const frame = historyTransferSignalSchema.parse(value);
    const { pc } = attempt;
    if (frame.type === "hello") {
      if (frame.v !== HISTORY_TRANSFER_VERSION) { this.options.onError(transferVersionError(frame.v)); return; }
      const publicKey = fromBase64Url(frame.publicKey);
      const { role, psk, roomId, keyPair, deviceId } = this.options;
      if (attempt.keys || publicKey.length !== 32 || toBase64Url(publicKey) !== frame.publicKey
        || (this.peerKey && frame.publicKey !== this.peerKey)) throw new Error("Peer key changed");
      const ownPublicKey = toBase64Url(keyPair.publicKey);
      const keys = await deriveHistoryTransferKeys(keyPair.privateKey, publicKey, {
        psk, roomId, pairingId: attempt.pairingId, linkId: attempt.id,
        receiverDeviceId: role === "receiver" ? deviceId : attempt.deviceId,
        senderDeviceId: role === "sender" ? deviceId : attempt.deviceId,
        receiverPublicKey: role === "receiver" ? ownPublicKey : frame.publicKey,
        senderPublicKey: role === "sender" ? ownPublicKey : frame.publicKey,
      });
      if (this.socket !== socket || this.attempt !== attempt) {
        keys.toSender.fill(0);
        keys.toReceiver.fill(0);
        return;
      }
      this.peerKey = frame.publicKey;
      attempt.keys = keys;
      this.attachChannel(attempt);
      return;
    }
    if (frame.type === "ice") {
      const { candidate, sdpMid, sdpMLineIndex } = frame;
      if (pc.remoteDescription) await pc.addIceCandidate({ candidate, sdpMid, sdpMLineIndex });
      else if (attempt.candidates.length < 64) attempt.candidates.push({ candidate, sdpMid, sdpMLineIndex });
      return;
    }
    if (frame.type === "description") {
      const expectedKind = this.options.role === "receiver" ? "offer" : "answer";
      if (!attempt.keys || frame.kind !== expectedKind || (!!pc.remoteDescription !== !!frame.restart)) throw new Error("Unexpected description");
      await pc.setRemoteDescription({ type: frame.kind, sdp: frame.sdp });
      for (const candidate of attempt.candidates.splice(0)) {
        if (this.attempt !== attempt) return;
        await pc.addIceCandidate(candidate);
      }
      if (this.attempt !== attempt || frame.kind !== "offer") return;
      await this.sendDescription(attempt, "answer", frame.restart);
    }
  }

  private async begin(peer: Extract<HistoryTransferServerFrame, { type: "peer" }>, iceServers: RTCIceServer[]): Promise<void> {
    this.closeAttempt();
    const { role, deviceId, expectedPeerId, keyPair } = this.options;
    if (peer.deviceId === deviceId || (expectedPeerId && expectedPeerId !== peer.deviceId)
      || (this.peerId && peer.deviceId !== this.peerId)
      || (this.pairingId && this.pairingId !== peer.pairingId)) throw new Error("Peer or pairing changed");
    this.peerId = peer.deviceId;
    this.pairingId = peer.pairingId;
    const pc = new RTCPeerConnection({ iceServers });
    const attempt: Attempt = {
      id: peer.attempt, pairingId: peer.pairingId, deviceId: peer.deviceId, pc, candidates: [], localCandidates: [],
      timeout: setTimeout(() => {
        if (this.attempt === attempt && attempt.channel?.readyState !== "open") this.pause();
      }, CONNECTION_TIMEOUT_MS),
    };
    this.attempt = attempt;
    await this.options.onPeer(peer.deviceId, peer.deviceName);
    if (this.attempt !== attempt) return;
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate?.candidate || this.attempt !== attempt) return;
      const { sdpMid, sdpMLineIndex } = candidate;
      const frame = { type: "ice" as const, attempt: attempt.id, candidate: candidate.candidate, sdpMid, sdpMLineIndex };
      if (attempt.sendingDescription) attempt.localCandidates.push(frame);
      else this.signal(frame);
    };
    pc.onconnectionstatechange = () => {
      if (this.attempt !== attempt) return;
      if (pc.connectionState === "failed") this.pause();
      if (pc.connectionState === "connected" && attempt.restarting) {
        attempt.restarting = false;
        this.options.onIceState(true);
      }
      if (pc.connectionState === "disconnected" && !attempt.restarting && this.options.stream.started) {
        attempt.restarting = true;
        this.options.onIceState(false);
        if (role === "sender") void this.sendDescription(attempt, "offer", true).catch(() => {
          if (this.attempt === attempt) this.pause();
        });
      }
    };
    pc.ondatachannel = ({ channel }) => {
      if (this.attempt !== attempt || role !== "receiver" || attempt.channel || channel.label !== DATA_CHANNEL
        || !channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
        channel.close();
        return;
      }
      attempt.channel = channel;
      this.attachChannel(attempt);
    };
    this.signal({ type: "hello", attempt: attempt.id, publicKey: toBase64Url(keyPair.publicKey), v: HISTORY_TRANSFER_VERSION });
    if (role === "sender") {
      attempt.channel = pc.createDataChannel(DATA_CHANNEL, { ordered: true });
      await this.sendDescription(attempt, "offer");
    }
  }

  private async sendDescription(attempt: Attempt, kind: "offer" | "answer", restart?: true): Promise<void> {
    const { pc } = attempt;
    attempt.sendingDescription = true;
    try {
      const description = kind === "offer" ? await pc.createOffer({ iceRestart: restart }) : await pc.createAnswer();
      await pc.setLocalDescription(description);
      if (this.attempt !== attempt) return;
      this.signal({ type: "description", attempt: attempt.id, kind, sdp: pc.localDescription!.sdp, restart });
      for (const candidate of attempt.localCandidates.splice(0)) this.signal(candidate);
    } finally {
      attempt.sendingDescription = false;
    }
  }

  private attachChannel(attempt: Attempt): void {
    const { channel, keys } = attempt;
    if (!channel || !keys) return;
    if (this.options.role === "receiver") this.options.stream.attach(channel, keys.toReceiver, keys.toSender, keys.checkCode);
    else this.options.stream.attach(channel, keys.toSender, keys.toReceiver, keys.checkCode);
  }
}
