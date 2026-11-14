import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilities } from "./capabilities.js";
import { E2EECallUnsupportedError, supportsE2EECalling } from "./calls.js";
import {
  acceptCallOffer, addReceiverTransform, addSenderTransform, attachLocalTracks,
  createPeerConnection, deriveCallKey, initiateCall,
} from "../services/webrtc.js";
import { api } from "../services/api.js";

vi.mock("../services/api.js", () => ({ api: { get: vi.fn() } }));
vi.mock("../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ user: { id: "me" } }) } }));
vi.mock("../stores/callStore.js", () => ({ useCallStore: { getState: () => ({ setLocalStream: vi.fn(), addRemoteStream: vi.fn() }) } }));

const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>("node:crypto");
type Frame = RTCEncodedAudioFrame;

function framePipeline(data?: ArrayBuffer) {
  const output: ArrayBuffer[] = [];
  let complete!: () => void;
  const done = new Promise<void>((resolve) => { complete = resolve; });
  return {
    output, done,
    readable: new ReadableStream<Frame>({ start(controller) {
      if (data) controller.enqueue({ data } as Frame);
      controller.close();
    } }),
    writable: new WritableStream<Frame>({ write(frame) { output.push(frame.data); }, close: complete }),
  };
}

class LegacySender {
  track: MediaStreamTrack | null = null;
  pipeline = framePipeline();
  createEncodedStreams = vi.fn(() => this.pipeline);
}
// Feature detection is on the prototype, just as in a WebView.
Object.defineProperty(LegacySender.prototype, "createEncodedStreams", { configurable: true, value() {} });
class LegacyReceiver extends LegacySender {}
class ScriptSender { transform: unknown = null; track: MediaStreamTrack | null = null; }
Object.defineProperty(ScriptSender.prototype, "transform", { value: null, writable: true });
class ScriptReceiver extends ScriptSender {}

let Sender: new () => LegacySender | ScriptSender;
class Peer {
  static instances: Peer[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  senders: (LegacySender | ScriptSender)[] = [];
  ontrack?: (event: RTCTrackEvent) => void;
  close = vi.fn();
  getTransceivers = () => [];
  getSenders = () => this.senders;
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "encrypted-offer" }));
  createAnswer = vi.fn(async () => ({ type: "answer", sdp: "encrypted-answer" }));
  setLocalDescription = vi.fn(async (sdp) => { this.localDescription = sdp; });
  setRemoteDescription = vi.fn(async () => {});
  addTrack = vi.fn((track: MediaStreamTrack) => {
    const sender = new Sender();
    sender.track = track;
    this.senders.push(sender);
    return sender;
  });
  constructor(public config: RTCConfiguration & { encodedInsertableStreams?: boolean }) { Peer.instances.push(this); }
}

const getUserMedia = vi.fn();
const socket = { send: vi.fn() };
let callKey: Awaited<ReturnType<typeof deriveCallKey>>;
const track = () => ({ kind: "audio", stop: vi.fn() }) as unknown as MediaStreamTrack;
const media = (tracks: MediaStreamTrack[]) => ({ getTracks: () => tracks }) as MediaStream;
const asPc = (pc: Peer) => pc as unknown as RTCPeerConnection;

function legacy() {
  Sender = LegacySender;
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("RTCRtpSender", LegacySender);
  vi.stubGlobal("RTCRtpReceiver", LegacyReceiver);
}
function script() {
  Sender = ScriptSender;
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("RTCRtpSender", ScriptSender);
  vi.stubGlobal("RTCRtpReceiver", ScriptReceiver);
  vi.stubGlobal("Worker", vi.fn());
  vi.stubGlobal("RTCRtpScriptTransform", vi.fn());
}

beforeEach(async () => {
  vi.clearAllMocks();
  Peer.instances = [];
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("RTCSessionDescription", class { constructor(public init: unknown) {} });
  vi.stubGlobal("RTCPeerConnection", undefined);
  vi.stubGlobal("RTCRtpSender", undefined);
  vi.stubGlobal("RTCRtpReceiver", undefined);
  vi.stubGlobal("RTCRtpScriptTransform", undefined);
  vi.mocked(api.get).mockResolvedValue({ iceServers: [] });
  callKey = await deriveCallKey(new Uint8Array(32), "test-call");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("E2EE call capability and setup", () => {
  it("blocks every setup entry point before capture, TURN, SDP or signaling when transforms are unavailable", async () => {
    const pc = new Peer({});
    expect(capabilities.e2eeCalls).toBe(false);
    await expect(initiateCall("call", socket as unknown as WebSocket, callKey, "audio")).rejects.toBeInstanceOf(E2EECallUnsupportedError);
    await expect(createPeerConnection("call", callKey, vi.fn())).rejects.toBeInstanceOf(E2EECallUnsupportedError);
    await expect(acceptCallOffer(asPc(pc), socket as unknown as WebSocket, "offer")).rejects.toBeInstanceOf(E2EECallUnsupportedError);
    expect(() => attachLocalTracks(asPc(pc), media([track()]), callKey)).toThrow(E2EECallUnsupportedError);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
    expect(pc.addTrack).not.toHaveBeenCalled();
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(pc.createAnswer).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("requires matching sender and receiver support, a worker for WebKit and Web Crypto", () => {
    legacy();
    expect(supportsE2EECalling()).toBe(true);
    vi.stubGlobal("RTCRtpReceiver", class {});
    expect(supportsE2EECalling()).toBe(false);
    script();
    expect(capabilities.e2eeCalls).toBe(true);
    vi.stubGlobal("Worker", undefined);
    expect(supportsE2EECalling()).toBe(false);
    script();
    vi.stubGlobal("RTCRtpReceiver", class {});
    expect(supportsE2EECalling()).toBe(false);
    legacy();
    vi.stubGlobal("crypto", {});
    expect(supportsE2EECalling()).toBe(false);
  });

  it("enables Chromium's encodedInsertableStreams option before attaching or negotiating", async () => {
    legacy();
    const localTrack = track();
    getUserMedia.mockResolvedValue(media([localTrack]));
    const { pc } = await initiateCall("call", socket as unknown as WebSocket, callKey, "audio");
    const peer = Peer.instances[0];
    expect(peer.config.encodedInsertableStreams).toBe(true);
    expect((peer.senders[0] as LegacySender).createEncodedStreams).toHaveBeenCalledTimes(1);
    expect(peer.createOffer).toHaveBeenCalledTimes(1);
    expect(pc.localDescription?.sdp).toBe("encrypted-offer");
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it("attaches WebKit script transforms in a worker for sending and receiving", async () => {
    script();
    const onRemote = vi.fn();
    const pc = await createPeerConnection("call", callKey, onRemote);
    const peer = Peer.instances[0];
    attachLocalTracks(pc, media([track()]), callKey);
    expect(peer.config.encodedInsertableStreams).toBeUndefined();
    expect(RTCRtpScriptTransform).toHaveBeenCalledWith(expect.anything(), { kind: "sender", rawKey: callKey.rawKey });
    const receiver = new ScriptReceiver();
    const remoteStream = media([]);
    peer.ontrack!({ receiver, track: track(), streams: [remoteStream] } as unknown as RTCTrackEvent);
    expect(RTCRtpScriptTransform).toHaveBeenLastCalledWith(expect.anything(), { kind: "receiver", rawKey: callKey.rawKey });
    expect(onRemote).toHaveBeenCalledWith(remoteStream);
    await acceptCallOffer(pc, socket as unknown as WebSocket, "encrypted-offer");
    expect(peer.createAnswer).toHaveBeenCalledTimes(1);
  });

  it.each(["legacy", "script"])("closes and stops capture before any signaling when %s transform setup throws", async (mode) => {
    if (mode === "legacy") {
      legacy();
      Sender = class extends LegacySender { createEncodedStreams = vi.fn(() => { throw new Error("Unavailable"); }); };
    } else {
      script();
      vi.stubGlobal("RTCRtpScriptTransform", vi.fn(() => { throw new Error("Unavailable"); }));
    }
    const localTrack = track();
    getUserMedia.mockResolvedValue(media([localTrack]));
    await expect(initiateCall("call", socket as unknown as WebSocket, callKey, "audio")).rejects.toBeInstanceOf(E2EECallUnsupportedError);
    expect(Peer.instances[0].close).toHaveBeenCalled();
    expect(localTrack.stop).toHaveBeenCalled();
    expect(Peer.instances[0].createOffer).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("refuses to answer with a track attached outside the encrypted setup path", async () => {
    legacy();
    const pc = await createPeerConnection("call", callKey, vi.fn());
    const peer = Peer.instances[0];
    peer.addTrack(track());
    await expect(acceptCallOffer(pc, socket as unknown as WebSocket, "offer")).rejects.toBeInstanceOf(E2EECallUnsupportedError);
    expect(peer.close).toHaveBeenCalled();
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(peer.createAnswer).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("refuses to add a new untransformed track to an already negotiated connection", async () => {
    legacy();
    const pc = await createPeerConnection("call", callKey, vi.fn());
    const peer = Peer.instances[0];
    peer.localDescription = { type: "offer" };
    expect(() => attachLocalTracks(pc, media([track()]), callKey)).toThrow(E2EECallUnsupportedError);
    expect(peer.addTrack).not.toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
  });

  it("closes without exposing a remote stream when its receiver lacks transforms", async () => {
    legacy();
    const onRemote = vi.fn();
    await createPeerConnection("call", callKey, onRemote);
    const peer = Peer.instances[0];
    const remoteTrack = track();
    vi.spyOn(console, "error").mockImplementation(() => {});
    peer.ontrack!({ receiver: {}, track: remoteTrack, streams: [media([])] } as unknown as RTCTrackEvent);
    expect(peer.close).toHaveBeenCalled();
    expect(remoteTrack.stop).toHaveBeenCalled();
    expect(onRemote).not.toHaveBeenCalled();
  });
});

describe("encoded frame encryption", () => {
  it("encrypts and decrypts frames and uses different nonces for separate tracks", async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4]).buffer;
    const senders = [new LegacySender(), new LegacySender()];
    for (const sender of senders) {
      sender.pipeline = framePipeline(plaintext.slice(0));
      addSenderTransform(sender as unknown as RTCRtpSender, callKey);
      await sender.pipeline.done;
    }
    const first = new Uint8Array(senders[0].pipeline.output[0]);
    const second = new Uint8Array(senders[1].pipeline.output[0]);
    expect(first.byteLength).toBe(12 + plaintext.byteLength + 16);
    expect(first.slice(0, 12)).not.toEqual(second.slice(0, 12));
    const receiver = new LegacyReceiver();
    receiver.pipeline = framePipeline(first.buffer);
    addReceiverTransform(receiver as unknown as RTCRtpReceiver, callKey);
    await receiver.pipeline.done;
    expect(new Uint8Array(receiver.pipeline.output[0])).toEqual(new Uint8Array(plaintext));
  });

  it("drops frames on encryption errors and rejects plaintext/malformed inbound frames", async () => {
    const sender = new LegacySender();
    sender.pipeline = framePipeline(new Uint8Array([1, 2, 3]).buffer);
    vi.spyOn(crypto.subtle, "encrypt").mockRejectedValue(new Error("Encryption failed"));
    addSenderTransform(sender as unknown as RTCRtpSender, callKey);
    await sender.pipeline.done;
    expect(sender.pipeline.output).toHaveLength(0);
    for (const data of [new Uint8Array(3).buffer, new Uint8Array(40).buffer]) {
      const receiver = new LegacyReceiver();
      receiver.pipeline = framePipeline(data);
      addReceiverTransform(receiver as unknown as RTCRtpReceiver, callKey);
      await receiver.pipeline.done;
      expect(receiver.pipeline.output).toHaveLength(0);
    }
  });
});
