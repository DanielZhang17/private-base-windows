import { GROUP_CALL_RECONNECT_MS, type GroupSignalBody } from "@e2ee-chat/shared";
import { attachGroupFrameTransform, createGroupFrameConnection } from "../../services/webrtc.js";
import type { GroupFrameKey } from "../../services/group-frame-transform.js";

export type GroupPeerConnection = "connecting" | "live" | "reconnecting" | "left";
export type GroupTrackName = "audio" | "camera" | "screen";
const trackNames: GroupTrackName[] = ["audio", "camera", "screen"];

export class GroupMeshPeer {
  readonly stream = new MediaStream();
  readonly screen = new MediaStream();
  readonly pc: RTCPeerConnection;
  private tracks = new Map<GroupTrackName, RTCRtpTransceiver>();
  private sending = new Map<GroupTrackName, ReturnType<typeof attachGroupFrameTransform>>();
  private receiving = new Map<GroupTrackName, ReturnType<typeof attachGroupFrameTransform>>();
  private remoteTracks = new Map<GroupTrackName, MediaStreamTrack>();
  private authenticated = new Map<GroupTrackName, number>();
  private sentTracks = new Map<GroupTrackName, MediaStreamTrack | null>();
  private queue = Promise.resolve();
  private offerId: string | undefined;
  private remoteOfferId: string | undefined;
  private candidates: { offerId: string; candidate: RTCIceCandidateInit }[] = [];
  private epoch = 0;
  private localKey: GroupFrameKey | null = null;
  private remoteKey: GroupFrameKey | null = null;
  private names: GroupTrackName[];
  private mids: string[] | undefined;
  private wantedTracks: Record<GroupTrackName, MediaStreamTrack | null> = { audio: null, camera: null, screen: null };
  private videoSuppressed = false;
  private receivingVideo = true;
  private closed = false;
  private everConnected = false;
  private recoveryAt: number | null = null;
  private retryAt = 0;
  private poorSince: number | null = null;
  private lastPackets = { lost: 0, received: 0 };

  constructor(private iceConfig: RTCConfiguration, video: boolean, private offerer: boolean,
    private send: (body: GroupSignalBody) => void, private changed: () => void,
    private currentIceConfig?: () => Promise<RTCConfiguration>) {
    this.pc = createGroupFrameConnection(iceConfig);
    this.names = video ? trackNames : trackNames.slice(0, 1);
    if (offerer) {
      try {
        for (const name of this.names) {
          this.protect(name, this.pc.addTransceiver(this.kind(name), { direction: "sendrecv" }));
        }
      } catch (error) {
        this.close();
        throw error;
      }
    }

    this.pc.ontrack = ({ transceiver, track }) => {
      if (this.closed) { track.stop(); return; }
      const index = this.mids?.indexOf(transceiver.mid ?? "") ?? -1;
      if (index < 0 || transceiver.receiver.track !== track) { track.stop(); this.close(); return; }
      const name = this.names[index];
      try {
        this.protect(name, transceiver);
        this.remoteTracks.set(name, track);
        this.publishTrack(name);
      } catch {
        track.stop();
        this.close();
      }
    };
    this.pc.onicecandidate = ({ candidate }) => {
      if (!this.closed && this.offerId && candidate) this.send({ kind: "ice", offerId: this.offerId, candidate: JSON.stringify(candidate.toJSON()) });
    };
    this.pc.onconnectionstatechange = () => this.connectedChanged();
    this.pc.oniceconnectionstatechange = () => this.connectedChanged();
  }

  private kind(name: GroupTrackName) {
    return name === "audio" ? "audio" : "video";
  }

  private protect(name: GroupTrackName, transceiver: RTCRtpTransceiver) {
    const prior = this.tracks.get(name);
    if ((prior && prior !== transceiver) || transceiver.receiver.track.kind !== this.kind(name)) {
      this.close();
      throw new Error("Unexpected group call transceiver");
    }
    if (prior) return;
    const sender = attachGroupFrameTransform(transceiver.sender, "sender", () => {});
    this.sending.set(name, sender);
    const receiver = attachGroupFrameTransform(transceiver.receiver, "receiver", (epoch) => {
      if (this.closed || epoch !== this.epoch) return;
      this.authenticated.set(name, epoch);
      this.publishTrack(name);
    });
    this.receiving.set(name, receiver);
    this.tracks.set(name, transceiver);
    sender.set(this.localKey);
    receiver.set(name === "audio" || this.receivingVideo ? this.remoteKey : null);
  }

  private readMids(sdp: string) {
    const sections = sdp.split(/(?:^|\r?\n)m=/).slice(1);
    if (sections.length !== this.names.length) return;
    const mids: string[] = [];
    for (const [index, section] of sections.entries()) {
      const [media, ...lines] = section.split(/\r?\n/);
      const mid = lines.find((line) => line.startsWith("a=mid:"))?.slice(6);
      if (!media.startsWith(`${this.kind(this.names[index])} `) || !mid || /\s/.test(mid) || mids.includes(mid)) return;
      mids.push(mid);
    }
    if (this.mids?.some((mid, index) => mid !== mids[index])) return;
    return mids;
  }

  private assertProtected(associated = false) {
    const transceivers = this.pc.getTransceivers();
    if (this.closed || transceivers.length !== this.names.length || this.names.some((name, index) => {
      const transceiver = this.tracks.get(name);
      return !transceiver || !transceivers.includes(transceiver) || !this.sending.has(name) || !this.receiving.has(name)
        || (associated && transceiver.mid !== this.mids?.[index]);
    })) {
      this.close();
      throw new Error("Group call cannot negotiate without protected transceivers");
    }
  }

  private publishTrack(name: GroupTrackName) {
    const track = this.remoteTracks.get(name);
    if (!track || this.authenticated.get(name) !== this.epoch) return;
    const stream = name === "screen" ? this.screen : this.stream;
    if (!stream.getTracks().includes(track)) stream.addTrack(track);
    this.changed();
  }

  get connection(): GroupPeerConnection {
    if (this.closed) return "left";
    if (this.pc.connectionState === "connected") return "live";
    return this.everConnected || this.recoveryAt !== null ? "reconnecting" : "connecting";
  }

  get secureMedia() {
    return this.authenticated.size > 0;
  }

  hasAuthenticatedMedia(epoch: number) {
    return [...this.authenticated.values()].includes(epoch);
  }

  private connectedChanged() {
    if (this.closed) return;
    const state = this.pc.connectionState;
    if (state === "connected") {
      this.everConnected = true;
      this.recoveryAt = null;
    } else if (state === "failed" || state === "disconnected" || this.pc.iceConnectionState === "failed" ||
      this.pc.iceConnectionState === "disconnected") {
      this.recoveryAt ??= Date.now();
    }
    this.changed();
  }

  setEpoch(epoch: number) {
    if (epoch === this.epoch) return;
    this.epoch = epoch;
    this.candidates = [];
    this.localKey = this.remoteKey = null;
    for (const transform of [...this.sending.values(), ...this.receiving.values()]) transform.set(null);
  }

  setKeys(local: GroupFrameKey | null, remote: GroupFrameKey | null) {
    this.localKey = local;
    for (const transform of this.sending.values()) transform.set(local);
    this.remoteKey = remote;
    for (const [name, transform] of this.receiving) transform.set(name === "audio" || this.receivingVideo ? remote : null);
  }

  setReceivingVideo(value: boolean) {
    if (value === this.receivingVideo) return;
    this.receivingVideo = value;
    for (const [name, transform] of this.receiving) if (name !== "audio") transform.set(value ? this.remoteKey : null);
  }

  replaceTracks(tracks: Record<GroupTrackName, MediaStreamTrack | null>, videoSuppressed: boolean) {
    this.wantedTracks = { ...tracks };
    this.videoSuppressed = videoSuppressed;
    void this.applyTracks();
  }

  private async applyTracks() {
    await Promise.all([...this.tracks].map(async ([name, transceiver]) => {
      const track = name !== "audio" && this.videoSuppressed ? null : this.wantedTracks[name];
      if (track === (this.sentTracks.get(name) ?? null)) return;
      this.sentTracks.set(name, track);
      try { await transceiver.sender.replaceTrack(track); }
      catch { if (this.sentTracks.get(name) === track) this.sentTracks.delete(name); }
    }));
  }

  setVideoBudget(kbps: number) {
    const sender = this.tracks.get("camera")?.sender;
    if (!sender?.track) return;
    const params = sender.getParameters();
    if (!params.encodings.length || params.encodings[0].maxBitrate === kbps * 1000) return;
    params.encodings[0].maxBitrate = kbps * 1000;
    void sender.setParameters(params).catch(() => undefined);
  }

  private async prepareIce(epoch: number) {
    const config = this.currentIceConfig ? await this.currentIceConfig() : this.iceConfig;
    if (this.closed || epoch !== this.epoch) return false;
    if (config !== this.iceConfig) {
      this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers: config.iceServers });
      this.iceConfig = config;
    }
    return true;
  }

  ensureOffer(restart = false) {
    if (!this.offerer || this.closed || (!restart && this.offerId)) return;
    this.run(async () => {
      if (!restart && this.offerId) return;
      const epoch = this.epoch;
      if (!await this.prepareIce(epoch)) return;
      if (this.pc.signalingState === "have-local-offer") {
        await this.pc.setLocalDescription({ type: "rollback" });
        if (!this.remoteOfferId) this.mids = undefined;
      }
      if (this.closed || epoch !== this.epoch || this.pc.signalingState !== "stable") return;
      this.assertProtected();
      const offer = await this.pc.createOffer({ iceRestart: restart });
      if (this.closed || epoch !== this.epoch) return;
      const mids = offer.sdp && this.readMids(offer.sdp);
      if (!mids) { this.close(); return; }
      this.mids = mids;
      this.assertProtected();
      this.offerId = crypto.randomUUID();
      await this.pc.setLocalDescription(offer);
      this.assertProtected(true);
      if (epoch === this.epoch && !this.closed) this.send({ kind: "offer", offerId: this.offerId, sdp: this.pc.localDescription!.sdp });
    });
  }

  receive(body: GroupSignalBody, epoch: number) {
    this.run(async () => {
      if (epoch !== this.epoch) return;
      if (body.kind === "restart") { this.ensureOffer(true); return; }
      if (body.kind === "ice") {
        const candidate: RTCIceCandidateInit = JSON.parse(body.candidate);
        if (body.offerId === this.remoteOfferId) await this.pc.addIceCandidate(candidate);
        else if (this.candidates.length < 64) this.candidates.push({ offerId: body.offerId, candidate });
        return;
      }
      if (body.kind === "media") return;
      const offer = body.kind === "offer";
      if (offer ? this.offerer : !this.offerer || body.offerId !== this.offerId || this.pc.signalingState !== "have-local-offer") return;
      if (offer && body.offerId === this.remoteOfferId) return;
      // Check the entire layout before applying remote SDP. Once negotiated,
      // a re-offer must keep the same MIDs and cannot add a bare transceiver.
      const mids = this.readMids(body.sdp);
      if (!mids) { this.close(); return; }
      if (offer && !await this.prepareIce(epoch)) return;
      if (this.mids) this.assertProtected(true);
      this.mids = mids;
      await this.pc.setRemoteDescription({ type: body.kind, sdp: body.sdp });
      if (this.closed) return;
      if (offer) {
        try {
          for (const transceiver of this.pc.getTransceivers()) {
            const name = this.names[mids.indexOf(transceiver.mid ?? "")];
            if (!name) throw new Error("Unexpected group call media section");
            this.protect(name, transceiver);
            transceiver.direction = "sendrecv";
          }
          this.assertProtected(true);
        } catch (error) {
          this.close();
          throw error;
        }
      } else this.assertProtected(true);
      this.remoteOfferId = body.offerId;
      const candidates = this.candidates.filter((c) => c.offerId === body.offerId);
      this.candidates = [];
      for (const { candidate } of candidates) await this.pc.addIceCandidate(candidate).catch(() => undefined);
      if (offer && epoch === this.epoch && !this.closed) {
        this.offerId = body.offerId;
        await this.applyTracks();
        if (epoch !== this.epoch || this.closed) return;
        this.assertProtected(true);
        const answer = await this.pc.createAnswer();
        if (!answer.sdp || !this.readMids(answer.sdp)) { this.close(); return; }
        this.assertProtected(true);
        await this.pc.setLocalDescription(answer);
        this.assertProtected(true);
        if (epoch === this.epoch && !this.closed) this.send({ kind: "answer", offerId: body.offerId, sdp: this.pc.localDescription!.sdp });
      }
    });
  }

  private run(action: () => Promise<void>) {
    this.queue = this.queue.then(async () => { if (!this.closed) await action(); }).catch(() => {
      if (!this.closed) this.recoveryAt ??= Date.now();
    });
  }

  recover(now: number, allowed: boolean) {
    if (this.closed) return false;
    if (!this.everConnected && !this.recoveryAt) this.recoveryAt = now;
    if (this.recoveryAt === null) return true;
    if (now - this.recoveryAt >= GROUP_CALL_RECONNECT_MS) return false;
    if (allowed && now - this.recoveryAt > 2500 && now >= this.retryAt) {
      this.retryAt = now + 8_000;
      if (this.offerer) this.ensureOffer(true);
      else this.send({ kind: "restart" });
    }
    return true;
  }

  async quality(now: number): Promise<"ok" | "poor"> {
    const stats = await this.pc.getStats();
    let rtt = 0, lost = 0, received = 0;
    stats.forEach((report) => {
      if (report.type === "candidate-pair" && report.nominated) rtt = Math.max(rtt, report.currentRoundTripTime ?? 0);
      if (report.type === "inbound-rtp") { lost += report.packetsLost ?? 0; received += report.packetsReceived ?? 0; }
    });
    const lostDelta = Math.max(0, lost - this.lastPackets.lost);
    const total = lostDelta + Math.max(0, received - this.lastPackets.received);
    this.lastPackets = { lost, received };
    this.poorSince = rtt > 0.6 || (total > 0 && lostDelta / total > 0.08) ? this.poorSince ?? now : null;
    return this.poorSince !== null && now - this.poorSince >= 5000 ? "poor" : "ok";
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pc.close();
    for (const transform of [...this.sending.values(), ...this.receiving.values()]) transform.close();
    for (const track of this.remoteTracks.values()) track.stop();
  }
}
