import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GroupMeshPeer } from "./group-mesh-peer.js";
import type { GroupFrameKey } from "../../services/group-frame-transform.js";

vi.mock("../../platform/calls.js", async (load) => ({
  ...await load<typeof import("../../platform/calls.js")>(),
  requireE2EECalling: () => {},
  supportsLegacyEncodedTransforms: () => true,
}));

class Track {
  stop = vi.fn();
  constructor(readonly kind: string) {}
}
class Stream {
  tracks: Track[] = [];
  addTrack(track: Track) { this.tracks.push(track); }
  getTracks() { return this.tracks; }
}
class Endpoint {
  track: Track | null;
  protected = false;
  output: Uint8Array[] = [];
  private input!: ReadableStreamDefaultController<{ data: ArrayBuffer }>;
  constructor(track: Track | null) { this.track = track; }
  createEncodedStreams() {
    expect(this.protected).toBe(false);
    this.protected = true;
    return {
      readable: new ReadableStream<{ data: ArrayBuffer }>({ start: (input) => { this.input = input; } }),
      writable: new WritableStream<{ data: ArrayBuffer }>({
        write: ({ data }) => { this.output.push(new Uint8Array(data)); },
      }),
    };
  }
  async replaceTrack(track: Track) {
    expect(this.protected).toBe(true);
    this.track = track;
  }
  frame(bytes: Uint8Array) {
    expect(this.protected).toBe(true);
    this.input.enqueue({ data: Uint8Array.from(bytes).buffer });
  }
}
class Transceiver {
  mid: string | null = null;
  direction = "recvonly";
  sender = new Endpoint(null);
  receiver: Endpoint;
  constructor(readonly kind: string) { this.receiver = new Endpoint(new Track(kind)); }
}
const sections = ["audio", "video", "video"];
const sdp = (video: boolean) => ["v=0", ...sections.slice(0, video ? 3 : 1)
  .flatMap((kind, index) => [`m=${kind} 9 UDP/TLS/RTP/SAVPF 96`, `a=mid:${index}`]), ""].join("\r\n");
const allProtected = (transceivers: Transceiver[]) => {
  expect(transceivers.length).toBeGreaterThan(0);
  expect(transceivers.every((t) => t.sender.protected && t.receiver.protected)).toBe(true);
};

class Connection {
  transceivers: Transceiver[] = [];
  signalingState: RTCSignalingState = "stable";
  connectionState = "new";
  iceConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  ontrack?: (event: { transceiver: Transceiver; track: Track }) => void;
  constructor(private config: RTCConfiguration) {}
  getConfiguration() { return this.config; }
  setConfiguration(config: RTCConfiguration) { this.config = config; }
  remoteApplications = 0;
  iceRestarts = 0;
  getTransceivers() { return this.transceivers; }
  addTransceiver(kind: string) {
    const t = new Transceiver(kind);
    t.direction = "sendrecv";
    this.transceivers.push(t);
    return t;
  }
  async createOffer({ iceRestart }: { iceRestart: boolean }) {
    allProtected(this.transceivers);
    this.iceRestarts += Number(iceRestart);
    return { type: "offer", sdp: sdp(this.transceivers.length === 3) };
  }
  async createAnswer() {
    allProtected(this.transceivers);
    expect(this.transceivers.every((t) => t.sender.track?.kind === t.kind && t.direction === "sendrecv")).toBe(true);
    return { type: "answer", sdp: this.remoteDescription!.sdp };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    allProtected(this.transceivers);
    this.localDescription = description;
    this.transceivers.forEach((t, index) => { t.mid = String(index); });
    this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteApplications++;
    if (this.remoteDescription || description.type === "answer") allProtected(this.transceivers);
    if (description.type === "offer" && !this.remoteDescription) {
      // Model the browser creating transceivers for the remote media sections,
      // even when the answerer has unused, unassociated local transceivers.
      for (const line of description.sdp!.split("\r\n").filter((line) => line.startsWith("m="))) {
        const transceiver = new Transceiver(line.split(" ")[0].slice(2));
        transceiver.mid = String(this.transceivers.length);
        this.transceivers.push(transceiver);
        this.ontrack?.({ transceiver, track: transceiver.receiver.track! });
      }
    } else if (description.type === "answer" && !this.remoteDescription) {
      for (const transceiver of this.transceivers) this.ontrack?.({ transceiver, track: transceiver.receiver.track! });
    }
    this.remoteDescription = description;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }
  close() { this.connectionState = "closed"; }
  encodedFrames() {
    expect(this.connectionState).not.toBe("closed");
    expect(this.localDescription && this.remoteDescription).toBeTruthy();
    allProtected(this.transceivers);
    return this.transceivers;
  }
}

const connections: GroupMeshPeer[] = [];
function peer(video: boolean, offerer: boolean, config: RTCConfiguration = {}, refresh?: () => Promise<RTCConfiguration>) {
  const send = vi.fn<ConstructorParameters<typeof GroupMeshPeer>[3]>();
  const mesh = new GroupMeshPeer(config, video, offerer, send, vi.fn(), refresh);
  const pc = mesh.pc as unknown as Connection;
  const track = (kind: string) => new Track(kind) as unknown as MediaStreamTrack;
  mesh.setEpoch(1);
  mesh.replaceTracks({ audio: track("audio"), camera: track("video"), screen: track("video") }, false);
  connections.push(mesh);
  return { pc, mesh, send };
}
const key = async (epoch: number): Promise<GroupFrameKey> => ({
  epoch, key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
});

beforeEach(() => {
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("RTCPeerConnection", Connection);
});
afterEach(() => {
  for (const mesh of connections.splice(0)) mesh.close();
  vi.unstubAllGlobals();
});

it.each(["video startup", "audio late join"] as const)("protects every negotiated sender and receiver on both sides during %s and ICE restart", async (scenario) => {
  const video = scenario === "video startup";
  const offerer = peer(video, true);
  const answerer = peer(video, false);
  expect(answerer.pc.transceivers).toHaveLength(0);
  const exchange = async (restart: boolean) => {
    offerer.mesh.ensureOffer(restart);
    await vi.waitFor(() => expect(offerer.send).toHaveBeenCalledTimes(restart ? 2 : 1));
    const offer = offerer.send.mock.lastCall![0];
    answerer.mesh.receive(offer, 1);
    await vi.waitFor(() => expect(answerer.send).toHaveBeenCalledTimes(restart ? 2 : 1));
    offerer.mesh.receive(answerer.send.mock.lastCall![0], 1);
    await vi.waitFor(() => expect(offerer.pc.remoteApplications).toBe(restart ? 2 : 1));
    expect(answerer.pc.encodedFrames()).toHaveLength(video ? 3 : 1);
    expect(offerer.pc.encodedFrames()).toHaveLength(video ? 3 : 1);
  };
  await exchange(false);
  const left = await key(1);
  const right = await key(1);
  offerer.mesh.setKeys(left, right);
  answerer.mesh.setKeys(right, left);
  const plaintext = new TextEncoder().encode("protected frame");
  const plaintextBytes = Array.from(plaintext);
  expect(answerer.mesh.stream.getTracks()).toHaveLength(0);
  expect(offerer.mesh.stream.getTracks()).toHaveLength(0);
  for (const [sender, receiver] of [[offerer, answerer], [answerer, offerer]]) {
    for (const [index, sending] of sender.pc.encodedFrames().entries()) {
      const receiving = receiver.pc.encodedFrames()[index].receiver;
      receiving.frame(plaintext);
      sending.sender.frame(plaintext);
      await vi.waitFor(() => expect(sending.sender.output).toHaveLength(1));
      const ciphertext = sending.sender.output[0];
      expect(Array.from(ciphertext)).not.toEqual(plaintextBytes);
      expect(receiving.output).toHaveLength(0);
      receiving.frame(ciphertext);
      await vi.waitFor(() => expect(receiving.output.map((value) => Array.from(value))).toEqual([plaintextBytes]));
    }
    expect(receiver.mesh.stream.getTracks()).toHaveLength(video ? 2 : 1);
    expect(receiver.mesh.screen.getTracks()).toHaveLength(video ? 1 : 0);
  }
  await exchange(true);
  expect(offerer.pc.iceRestarts).toBe(1);
});

it("rejects extra media sections in a re-offer before applying SDP", async () => {
  const answerer = peer(false, false);
  answerer.mesh.receive({ kind: "offer", offerId: "first", sdp: sdp(false) }, 1);
  await vi.waitFor(() => expect(answerer.send).toHaveBeenCalledTimes(1));
  answerer.mesh.receive({ kind: "offer", offerId: "extra", sdp: sdp(true) }, 1);
  await vi.waitFor(() => expect(answerer.pc.connectionState).toBe("closed"));
  expect(answerer.pc.remoteApplications).toBe(1);
  expect(answerer.send).toHaveBeenCalledTimes(1);
});

it("closes before answering if the browser cannot attach either transform", async () => {
  const answerer = peer(false, false);
  const attach = vi.spyOn(Endpoint.prototype, "createEncodedStreams");
  attach.mockImplementationOnce(() => { throw new Error("unsupported transform"); });
  try {
    answerer.mesh.receive({ kind: "offer", offerId: "broken", sdp: sdp(false) }, 1);
    await vi.waitFor(() => expect(answerer.pc.connectionState).toBe("closed"));
    expect(answerer.pc.localDescription).toBeNull();
    expect(answerer.send).not.toHaveBeenCalled();
  } finally { attach.mockRestore(); }
});

it("uses STUN fallback and renewed TURN on both sides of a protected ICE restart", async () => {
  const original = { iceServers: [{ urls: "turn:relay.invalid", username: "original", credential: "test" }] };
  const fallback = { iceServers: [{ urls: "stun:stun.invalid" }] };
  const refreshed = { iceServers: [{ urls: "turn:relay.invalid", username: "renewed", credential: "test" }] };
  const refresh = vi.fn(async (): Promise<RTCConfiguration> => original);
  const offerer = peer(false, true, original, refresh);
  const answerer = peer(false, false, original, refresh);
  offerer.mesh.ensureOffer();
  await vi.waitFor(() => expect(offerer.send).toHaveBeenCalledOnce());
  answerer.mesh.receive(offerer.send.mock.lastCall![0], 1);
  await vi.waitFor(() => expect(answerer.send).toHaveBeenCalledOnce());
  offerer.mesh.receive(answerer.send.mock.lastCall![0], 1);
  await vi.waitFor(() => expect(offerer.pc.signalingState).toBe("stable"));

  let expected: RTCConfiguration;
  const create = offerer.pc.createOffer.bind(offerer.pc);
  vi.spyOn(offerer.pc, "createOffer").mockImplementation((options) => {
    expect(options.iceRestart).toBe(true);
    expect(offerer.pc.getConfiguration().iceServers).toEqual(expected.iceServers);
    return create(options);
  });
  const apply = answerer.pc.setRemoteDescription.bind(answerer.pc);
  vi.spyOn(answerer.pc, "setRemoteDescription").mockImplementation((description) => {
    expect(answerer.pc.getConfiguration().iceServers).toEqual(expected.iceServers);
    return apply(description);
  });
  for (const [index, config] of [fallback, refreshed].entries()) {
    expected = config;
    refresh.mockResolvedValue(config);
    offerer.mesh.ensureOffer(true);
    await vi.waitFor(() => expect(offerer.send).toHaveBeenCalledTimes(index + 2));
    answerer.mesh.receive(offerer.send.mock.lastCall![0], 1);
    await vi.waitFor(() => expect(answerer.send).toHaveBeenCalledTimes(index + 2));
    offerer.mesh.receive(answerer.send.mock.lastCall![0], 1);
    await vi.waitFor(() => expect(offerer.pc.signalingState).toBe("stable"));
  }
  expect(offerer.pc.iceRestarts).toBe(2);
});
