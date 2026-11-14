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

function requireEncryptedConnection(pc: RTCPeerConnection): void {
  if (!encryptedConnections.has(pc)) {
    pc.close();
    throw new E2EECallUnsupportedError();
  }
  requireE2EECalling();
}

/** Fetch short-lived TURN credentials from the server. */
export async function fetchTurnCredentials(): Promise<TurnCredentialsResponse> {
  return api.get<TurnCredentialsResponse>("/api/calls/turn-credentials");
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
): Promise<RTCPeerConnection> {
  requireE2EECalling();
  const turnCreds = await fetchTurnCredentials();
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

  pc.ontrack = (event) => {
    try {
      addReceiverTransform(event.receiver, callKey);
      if (event.streams[0]) onRemoteStream(event.streams[0]);
    } catch (error) {
      // A broken/partial implementation must never expose an untransformed track.
      pc.close();
      event.track.stop();
      console.error("E2EE receiver transform unavailable", error);
    }
  };

  // Prefer HEVC > VP9 > H.264 for video (better compression at same quality)
  try {
    for (const transceiver of pc.getTransceivers()) {
      if (transceiver.receiver.track.kind === "video" && typeof transceiver.setCodecPreferences === "function") {
        const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
        const hevc = codecs.filter((c) => c.mimeType === "video/H265");
        const vp9 = codecs.filter((c) => c.mimeType === "video/VP9");
        const h264 = codecs.filter((c) => c.mimeType === "video/H264");
        const rest = codecs.filter((c) =>
          c.mimeType !== "video/H265" && c.mimeType !== "video/VP9" && c.mimeType !== "video/H264",
        );
        transceiver.setCodecPreferences([...hevc, ...vp9, ...h264, ...rest]);
      }
    }
  } catch {
    // Codec preference is best-effort; not all browsers support it
  }

  return pc;
}

/**
 * Attach local media tracks to a peer connection with E2EE sender transforms.
 */
export function attachLocalTracks(pc: RTCPeerConnection, stream: MediaStream, callKey: CallFrameKey): LocalTrackSenders {
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
  } catch {
    pc.close();
    stream.getTracks().forEach((track) => track.stop());
    throw new E2EECallUnsupportedError();
  }

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
): Promise<void> {
  requireEncryptedConnection(pc);
  if (pc.getSenders().some((sender) => sender.track && !senderTransforms.has(sender))) {
    pc.close();
    throw new E2EECallUnsupportedError();
  }
  const { user } = useAuthStore.getState();
  await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: offerSdp }));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal(callWs, { kind: "answer", sdp: answer.sdp, fromUserId: user?.id ?? "" });
}
