import { groupFrameTransform, type GroupFrameKey } from "./group-frame-transform.js";
/**
 * WebRTC service with E2EE via encoded transforms.
 * Supports legacy createEncodedStreams() and RTCRtpScriptTransform for Safari/iOS.
 */
import type { WSSignalFrame } from "@e2ee-chat/shared";
import { WSFrameType } from "@e2ee-chat/shared";
import { useAuthStore } from "../stores/authStore.js";
import { useCallStore } from "../stores/callStore.js";
import { api } from "./api.js";
import {
  E2EECallUnsupportedError,
  requireE2EECalling,
  supportsLegacyEncodedTransforms,
  supportsScriptEncodedTransforms,
} from "../platform/calls.js";

import { captureUserMedia } from "../platform/media.js";

export { E2EECallUnsupportedError, supportsE2EECalling } from "../platform/calls.js";
// Acquire call media only through these, so that ending a session can release every device.
export { captureDisplayMedia, captureUserMedia, stopAllCapturedTracks } from "../platform/media.js";

interface TurnCredentialsResponse {
  iceServers: RTCIceServer[];
}

interface LocalTrackSenders {
  audioSender: RTCRtpSender | null;
  videoSender: RTCRtpSender | null;
}

export interface CallFrameKey {
  cryptoKey: CryptoKey;
  rawKey: Uint8Array;
}

type EncodedFrame = RTCEncodedVideoFrame | RTCEncodedAudioFrame;

interface EncodedStreams {
  readable: ReadableStream<EncodedFrame>;
  writable: WritableStream<EncodedFrame>;
}

type EncodedStreamsCapable = (RTCRtpSender | RTCRtpReceiver) & {
  createEncodedStreams?: () =>
    | EncodedStreams
    | {
        readableStream: ReadableStream<EncodedFrame>;
        writableStream: WritableStream<EncodedFrame>;
      };
};

let callTransformWorker: Worker | null = null;
const senderTransforms = new WeakSet<RTCRtpSender>();
const receiverTransforms = new WeakSet<RTCRtpReceiver>();
const encryptedConnections = new WeakSet<RTCPeerConnection>();

function preferCallVideoCodecs(pc: RTCPeerConnection): void {
  if (typeof pc.getTransceivers !== "function") return;
  let codecs: RTCRtpCodec[];
  try {
    codecs = RTCRtpSender.getCapabilities?.("video")?.codecs ?? [];
  } catch {
    return;
  }
  // These packetizers can carry opaque frame payloads. Keep VP8 first for
  // older peers and avoid preferring codecs whose packetizers parse the payload.
  const matching = (mimeType: string) => codecs.filter((codec) => codec.mimeType.toLowerCase() === mimeType);
  const preferred = [...matching("video/vp8"), ...matching("video/vp9")];
  if (!preferred.length) return;
  // The browser associates these RTP repair capabilities with the kept codecs.
  preferred.push(...codecs.filter(({ mimeType }) => /^video\/(?:rtx|red|ulpfec|flexfec(?:-03)?)$/i.test(mimeType)));

  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.receiver.track.kind !== "video") continue;
    try {
      transceiver.setCodecPreferences?.(preferred);
    } catch {
      // Capability reporting and preference support vary. Leave the browser's
      // negotiation in place. The encoded transforms remain mandatory.
    }
  }
}

function asArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

function getEncodedStreams(target: EncodedStreamsCapable): EncodedStreams | null {
  if (typeof target.createEncodedStreams !== "function") {
    return null;
  }

  const streams = target.createEncodedStreams();
  if ("readable" in streams && "writable" in streams) {
    return streams;
  }

  return {
    readable: streams.readableStream,
    writable: streams.writableStream,
  };
}

function ensureCallTransformWorker(): Worker {
  if (!callTransformWorker) {
    callTransformWorker = new Worker(
      new URL("../workers/callTransformWorker.ts", import.meta.url),
      { type: "module" },
    );
  }
  return callTransformWorker;
}

/** The app-level call owner releases the worker only after media has stopped. */
export function disposeCallTransforms(): void {
  callTransformWorker?.terminate();
  callTransformWorker = null;
}

function pipeEncodedFrames(
  streams: EncodedStreams,
  transform: Transformer<EncodedFrame, EncodedFrame>,
  label: string,
): void {
  void streams.readable
    .pipeThrough(new TransformStream<EncodedFrame, EncodedFrame>(transform))
    .pipeTo(streams.writable)
    .catch((err) => {
      console.error(`${label} encoded transform failed`, err);
    });
}

function attachScriptTransform(
  target: RTCRtpSender | RTCRtpReceiver,
  kind: "sender" | "receiver",
  callKey: CallFrameKey,
): boolean {
  if (!supportsScriptEncodedTransforms() || !("transform" in target)) return false;
  target.transform = new RTCRtpScriptTransform(ensureCallTransformWorker(), {
    kind,
    rawKey: callKey.rawKey,
  });
  return true;
}

export function createGroupFrameConnection(config: RTCConfiguration): RTCPeerConnection {
  requireE2EECalling();
  const pc = supportsLegacyEncodedTransforms()
    ? new RTCPeerConnection({ ...config, encodedInsertableStreams: true } as RTCConfiguration)
    : new RTCPeerConnection(config);
  return pc;
}

export function attachGroupFrameTransform(
  target: RTCRtpSender | RTCRtpReceiver,
  mode: "sender" | "receiver",
  authenticated: (epoch: number) => void,
) {
  let key: GroupFrameKey | null = null;
  const streams = getEncodedStreams(target);
  if (streams) {
    const lifetime = new AbortController();
    void streams.readable.pipeThrough(groupFrameTransform(mode, () => key, authenticated))
      .pipeTo(streams.writable, { signal: lifetime.signal }).catch(() => undefined);
    return { set: (next: GroupFrameKey | null) => { key = next; }, close: () => { key = null; lifetime.abort(); } };
  }
  if (!supportsScriptEncodedTransforms() || !("transform" in target)) throw new E2EECallUnsupportedError();
  const channel = new MessageChannel();
  try {
    const transform = new RTCRtpScriptTransform(ensureCallTransformWorker(),
      { kind: "group", mode, port: channel.port2 }, [channel.port2]);
    target.transform = transform;
    if (target.transform !== transform) throw new E2EECallUnsupportedError();
  } catch (error) {
    channel.port1.close();
    channel.port2.close();
    throw error;
  }
  channel.port1.onmessage = (message: MessageEvent<number>) => authenticated(message.data);
  return { set: (next: GroupFrameKey | null) => channel.port1.postMessage(next), close: () => {
    channel.port1.postMessage(null);
    channel.port1.close();
  } };
}

function requireEncryptedConnection(pc: RTCPeerConnection): void {
  if (!encryptedConnections.has(pc)) {
    pc.close();
    throw new E2EECallUnsupportedError();
  }
  requireE2EECalling();
}

/** Fetch short-lived TURN credentials from the server. */
export async function fetchTurnCredentials(signal?: AbortSignal): Promise<TurnCredentialsResponse> {
  return api.get<TurnCredentialsResponse>("/api/calls/turn-credentials", signal);
}

/**
 * Derive a raw AES-128-GCM key for call frame encryption from the shared call secret.
 */
export async function deriveCallKey(rootKeyBytes: Uint8Array, callId: string): Promise<CallFrameKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    asArrayBufferView(rootKeyBytes),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const rawBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asArrayBufferView(new TextEncoder().encode(callId)),
      info: asArrayBufferView(new TextEncoder().encode("CallEncryption")),
    },
    baseKey,
    128,
  );
  const rawKey = new Uint8Array(rawBits);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asArrayBufferView(rawKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return { cryptoKey, rawKey };
}

/** Add encoded-frame E2EE transforms to a sender track. */
export function addSenderTransform(sender: RTCRtpSender, callKey: CallFrameKey): void {
  if (senderTransforms.has(sender)) return;

  const streams = getEncodedStreams(sender as EncodedStreamsCapable);
  if (streams) {
    pipeEncodedFrames(streams, {
      async transform(encodedFrame, controller) {
        const data = new Uint8Array(encodedFrame.data);

        try {
          // The call key is shared across tracks and both peers. A per-track counter
          // alone reuses GCM nonces; generate a fresh 96-bit IV for every frame.
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: asArrayBufferView(iv) },
            callKey.cryptoKey,
            asArrayBufferView(data),
          );
          const out = new Uint8Array(12 + encrypted.byteLength);
          out.set(iv, 0);
          out.set(new Uint8Array(encrypted), 12);
          encodedFrame.data = out.buffer;
        } catch {
          return;
        }

        controller.enqueue(encodedFrame);
      },
    }, "Sender");
    senderTransforms.add(sender);
    return;
  }

  if (attachScriptTransform(sender, "sender", callKey)) {
    senderTransforms.add(sender);
    return;
  }

  throw new E2EECallUnsupportedError();
}

/** Add encoded-frame E2EE transforms to a receiver track. */
export function addReceiverTransform(receiver: RTCRtpReceiver, callKey: CallFrameKey): void {
  if (receiverTransforms.has(receiver)) return;

  const streams = getEncodedStreams(receiver as EncodedStreamsCapable);
  if (streams) {
    pipeEncodedFrames(streams, {
      async transform(encodedFrame, controller) {
        const data = new Uint8Array(encodedFrame.data);
        if (data.length < 12) return;

        const iv = data.slice(0, 12);
        const ciphertext = data.slice(12);

        try {
          const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: asArrayBufferView(iv) },
            callKey.cryptoKey,
            asArrayBufferView(ciphertext),
          );
          encodedFrame.data = decrypted;
        } catch {
          return;
        }

        controller.enqueue(encodedFrame);
      },
    }, "Receiver");
    receiverTransforms.add(receiver);
    return;
  }

  if (attachScriptTransform(receiver, "receiver", callKey)) {
    receiverTransforms.add(receiver);
    return;
  }

  throw new E2EECallUnsupportedError();
}

/**
 * Create a fully-configured RTCPeerConnection with E2EE transforms applied to all tracks.
 */
export async function createPeerConnection(
  _callId: string,
  callKey: CallFrameKey,
  onRemoteStream: (stream: MediaStream) => void,
  isCurrent: () => boolean = () => true,
): Promise<RTCPeerConnection> {
  if (!isCurrent()) throw new DOMException("Call setup cancelled", "AbortError");
  requireE2EECalling();
  const turnCreds = await fetchTurnCredentials();
  if (!isCurrent()) throw new DOMException("Call setup cancelled", "AbortError");
  requireE2EECalling();
  const baseConfig: RTCConfiguration = {
    iceServers: turnCreds.iceServers,
  };
  const pc = supportsLegacyEncodedTransforms()
    ? new RTCPeerConnection({
        ...baseConfig,
        encodedInsertableStreams: true,
      } as RTCConfiguration & { encodedInsertableStreams: boolean })
    : new RTCPeerConnection(baseConfig);
  encryptedConnections.add(pc);

  let remoteStream: MediaStream | undefined;
  pc.ontrack = (event) => {
    if (!isCurrent()) { event.track.stop(); return; }
    try {
      addReceiverTransform(event.receiver, callKey);
      // Own one stream per peer, including Safari's streamless events. Never
      // publish event.streams: it may already contain an untransformed sibling.
      remoteStream ??= new MediaStream();
      if (!remoteStream.getTracks().includes(event.track)) remoteStream.addTrack(event.track);
      onRemoteStream(remoteStream);
    } catch (error) {
      // A broken/partial implementation must never expose an untransformed track.
      pc.close();
      event.track.stop();
      console.error("E2EE receiver transform unavailable", error);
    }
  };

  return pc;
}

/**
 * Attach local media tracks to a peer connection with E2EE sender transforms.
 */
export function attachLocalTracks(pc: RTCPeerConnection, stream: MediaStream, callKey: CallFrameKey, reserveVideo = false): LocalTrackSenders {
  requireEncryptedConnection(pc);
  // This helper is for initial setup, before SDP enables transmission. Later track
  // replacements must use an existing sender whose transform is already installed.
  if (pc.localDescription) {
    pc.close();
    throw new E2EECallUnsupportedError();
  }
  let audioSender: RTCRtpSender | null = null;
  let videoSender: RTCRtpSender | null = null;

  try {
    for (const track of stream.getTracks()) {
      // Hint the encoder for better compression — "motion" for camera, "speech" for mic
      if ("contentHint" in track) {
        track.contentHint = track.kind === "video" ? "motion" : "speech";
      }
      const sender = pc.addTrack(track, stream);
      addSenderTransform(sender, callKey);
      if (track.kind === "audio") {
        audioSender = sender;
      } else if (track.kind === "video") {
        videoSender = sender;
      }
    }
    if (reserveVideo && !videoSender) {
      videoSender = pc.addTransceiver("video", { direction: "sendrecv" }).sender;
      addSenderTransform(videoSender, callKey);
    }
  } catch {
    pc.close();
    stream.getTracks().forEach((track) => track.stop());
    throw new E2EECallUnsupportedError();
  }

  if (videoSender) preferCallVideoCodecs(pc);
  return { audioSender, videoSender };
}

/** Send a WebRTC signal frame via the active WebSocket for a call. */
export function sendSignal(ws: WebSocket, payload: WSSignalFrame["payload"]): void {
  ws.send(JSON.stringify({ type: WSFrameType.Signal, payload }));
}

/**
 * Initiate a call: fetch TURN creds, get media, create offer, send via signaling WS.
 */
export async function initiateCall(
  callId: string,
  callWs: WebSocket,
  callKey: CallFrameKey,
  callType: "audio" | "video",
): Promise<{ pc: RTCPeerConnection; localStream: MediaStream }> {
  requireE2EECalling();
  const localStream = await captureUserMedia({
    audio: true,
    video: callType === "video"
      ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
      : false,
  });

  const { setLocalStream, addRemoteStream } = useCallStore.getState();
  const { user } = useAuthStore.getState();
  setLocalStream(localStream);

  let pc: RTCPeerConnection | undefined;
  try {
    pc = await createPeerConnection(callId, callKey, (stream) => {
      addRemoteStream("remote", stream);
    });

    attachLocalTracks(pc, localStream, callKey);

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      sendSignal(callWs, {
        kind: "ice-candidate",
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        fromUserId: user?.id ?? "",
      });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(callWs, { kind: "offer", sdp: offer.sdp, fromUserId: user?.id ?? "" });

    return { pc, localStream };
  } catch (error) {
    pc?.close();
    localStream.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    throw error;
  }
}

/**
 * Accept an incoming call offer: create answer and send via signaling WS.
 */
export async function acceptCallOffer(
  pc: RTCPeerConnection,
  callWs: WebSocket,
  offerSdp: string,
  isCurrent: () => boolean = () => true,
  sendAnswer?: (sdp: string) => void,
): Promise<void> {
  if (!isCurrent()) return;
  requireEncryptedConnection(pc);
  if (pc.getSenders().some((sender) => sender.track && !senderTransforms.has(sender))) {
    pc.close();
    throw new E2EECallUnsupportedError();
  }
  const { user } = useAuthStore.getState();
  await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: offerSdp }));
  if (!isCurrent()) return;
  // An incoming offer can introduce a receive-only video transceiver.
  preferCallVideoCodecs(pc);
  const answer = await pc.createAnswer();
  if (!isCurrent()) return;
  await pc.setLocalDescription(answer);
  if (!isCurrent()) return;
  if (sendAnswer) sendAnswer(answer.sdp!);
  else sendSignal(callWs, { kind: "answer", sdp: answer.sdp, fromUserId: user?.id ?? "" });
}
