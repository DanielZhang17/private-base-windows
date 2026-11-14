import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCall } from "./useCall.js";
import CallPage from "../../pages/CallPage.js";
import { useCallStore } from "../../stores/callStore.js";
import { useAuthStore } from "../../stores/authStore.js";
import { api } from "../../services/api.js";
import { acceptCallOffer, attachLocalTracks, createPeerConnection, supportsE2EECalling } from "../../services/webrtc.js";
import { WSFrameType } from "@e2ee-chat/shared";
import { E2EECallUnsupportedError } from "../../platform/calls.js";
import { clearAccountScopedState } from "../../platform/session.js";
import { registerNavigate } from "../../platform/navigation.js";

vi.mock("../chat/useOutgoingQueue.js", () => ({ useOutgoingQueue: () => ({}) }));
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "alice" }, accessToken: "token", refreshToken: null, logout: vi.fn() })) };
});
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() }, resolveWsBaseUrl: () => "wss://test" }));
vi.mock("../../db/index.js", () => ({ getPendingCall: async () => ({ callKey: "key", expiresAt: Date.now() + 60000 }), deletePendingCall: vi.fn(async () => {}) }));
vi.mock("../../lib/message-sync.js", () => ({ syncMessages: vi.fn() }));
vi.mock("@e2ee-chat/crypto", () => ({ fromBase64Url: () => new Uint8Array([1]) }));
vi.mock("../../services/webrtc.js", () => ({
  deriveCallKey: async () => ({}), supportsE2EECalling: vi.fn(() => true), createPeerConnection: vi.fn(),
  attachLocalTracks: vi.fn(() => ({ audioSender: null, videoSender: null })), addSenderTransform: vi.fn(), acceptCallOffer: vi.fn(), sendSignal: vi.fn(),
}));
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useCall>;
let stream: MediaStream;
let stop: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
const sockets: Array<{ close: ReturnType<typeof vi.fn>; onmessage?: (event: { data: string }) => Promise<void>; onopen?: () => Promise<void> }> = [];
let onRemote: (stream: MediaStream) => void;
function Probe() { state = useCall(); return null; }
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(supportsE2EECalling).mockReturnValue(true);
  vi.mocked(attachLocalTracks).mockReturnValue({ audioSender: null, videoSender: null });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stop = vi.fn(); close = vi.fn();
  stream = { getTracks: () => [{ stop }], getVideoTracks: () => [] } as unknown as MediaStream;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  sockets.length = 0;
  vi.stubGlobal("WebSocket", class { close = vi.fn(); constructor() { sockets.push(this); } });
  vi.mocked(createPeerConnection).mockImplementation(async (_id, _key, remote) => {
    onRemote = remote;
    return { close, connectionState: "new" } as unknown as RTCPeerConnection;
  });
  useAuthStore.setState({ user: { id: "alice" } } as never);
  useCallStore.getState().clearCall();
  useCallStore.getState().setOutgoingCall({ callId: "call", conversationId: "chat", callType: "audio", initiatorId: "alice" });
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "call", conversationId: "chat", type: "audio", status: "active", initiatorId: "alice" }
    : { id: "chat", members: [] }) as never);
  container = document.createElement("div"); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); clearAccountScopedState(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("reports unsupported E2EE as typed state before capturing any media", async () => {
  vi.mocked(supportsE2EECalling).mockReturnValue(false);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  expect(state.callUnsupported).toBe(true);
  expect(state.error).toBe(new E2EECallUnsupportedError().message);
  expect(state.stage).toBe("ended");
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(createPeerConnection).not.toHaveBeenCalled();
  log.mockRestore();
});

it("preserves typed unsupported errors from the call service without capturing media", async () => {
  vi.mocked(createPeerConnection).mockRejectedValueOnce(new E2EECallUnsupportedError());
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  expect(state.callUnsupported).toBe(true);
  expect(state.stage).toBe("ended");
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  log.mockRestore();
});

it("closes signaling, peer connections and captured audio on unmount", async () => {
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  expect(useCallStore.getState().localStream).toBe(stream);
  await act(async () => root.unmount());
  expect(stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(sockets[0].close).toHaveBeenCalled();
  expect(useCallStore.getState().localStream).toBeNull();
  // afterEach may safely unmount a fresh, empty root.
  root = createRoot(container);
});

function mediaTrack(kind: "audio" | "video") {
  return { kind, enabled: true, stop: vi.fn() };
}

class TestMediaStream {
  constructor(private tracks: ReturnType<typeof mediaTrack>[]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
}

function configureVideoCall() {
  useCallStore.getState().setOutgoingCall({ callId: "call", conversationId: "chat", callType: "video", initiatorId: "alice" });
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "call", conversationId: "chat", type: "video", status: "active", initiatorId: "alice" }
    : { id: "chat", members: [] }) as never);
}

it.each(["audio", "video"] as const)("P1: applies ringing mute intent to every audio track before attaching %s media", async (callType) => {
  const microphones = [mediaTrack("audio"), mediaTrack("audio")];
  const camera = mediaTrack("video");
  const captured = new TestMediaStream(callType === "video" ? [camera, ...microphones] : microphones);
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(captured as unknown as MediaStream);
  useCallStore.getState().setOutgoingCall({ callId: "call", conversationId: "chat", callType, initiatorId: "alice" });
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "call", conversationId: "chat", type: callType, status: "ringing", initiatorId: "alice" }
    : { id: "chat", members: [] }) as never);
  const enabledAtAttachment: boolean[][] = [];
  const senders: Array<{ track: MediaStreamTrack }> = [];
  const addTrack = vi.fn((track: MediaStreamTrack, media: MediaStream) => {
    // Even the first attachment (a video track in the video case) must see all
    // microphone tracks muted, before the peer can expose any of this media.
    enabledAtAttachment.push(media.getAudioTracks().map((audio) => audio.enabled));
    const sender = { track };
    senders.push(sender);
    return sender;
  });
  vi.mocked(createPeerConnection).mockResolvedValueOnce({ close, addTrack } as unknown as RTCPeerConnection);
  vi.mocked(attachLocalTracks).mockImplementation((pc, media) => {
    media.getTracks().forEach((track) => pc.addTrack(track, media));
    return { audioSender: null, videoSender: null };
  });

  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  expect(state.stage).toBe("ringing");
  expect(state.localStream).toBeNull();
  await act(async () => state.toggleMute());
  await act(async () => useCallStore.getState().updateCallStatus("call", "active"));

  expect(addTrack).toHaveBeenCalledTimes(captured.getTracks().length);
  expect(enabledAtAttachment).toEqual(captured.getTracks().map(() => [false, false]));
  expect(senders.filter((sender) => sender.track.kind === "audio").map((sender) => sender.track.enabled)).toEqual([false, false]);
  expect(camera.enabled).toBe(true);
});

it("P1: applies the latest mute intent when an outstanding capture resolves", async () => {
  const microphone = mediaTrack("audio");
  const captured = new TestMediaStream([microphone]);
  let resolveCapture!: (stream: MediaStream) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(new Promise((resolve) => { resolveCapture = resolve; }));
  const enabledAtAttachment: boolean[][] = [];
  vi.mocked(attachLocalTracks).mockImplementation((_pc, media) => {
    enabledAtAttachment.push(media.getAudioTracks().map((audio) => audio.enabled));
    return { audioSender: null, videoSender: null };
  });
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  await act(async () => state.toggleMute());
  await act(async () => resolveCapture(captured as unknown as MediaStream));
  expect(enabledAtAttachment).toEqual([[false]]);
  expect(microphone.enabled).toBe(false);
});

it("P1: preserves mute across screen and camera replacements, including newly acquired audio", async () => {
  vi.stubGlobal("MediaStream", TestMediaStream);
  const microphones = [mediaTrack("audio"), mediaTrack("audio")];
  const camera = mediaTrack("video");
  const screen = mediaTrack("video");
  const displayAudio = mediaTrack("audio");
  const restartedCamera = mediaTrack("video");
  const cameraAudio = mediaTrack("audio");
  const captured = new TestMediaStream([camera, ...microphones]);
  vi.stubGlobal("navigator", { mediaDevices: {
    getUserMedia: vi.fn(async () => captured),
    getDisplayMedia: vi.fn(async () => new TestMediaStream([screen, displayAudio])),
  } });
  configureVideoCall();
  const enabledAtReplacement: boolean[][] = [];
  const replaceTrack = vi.fn(async () => {
    enabledAtReplacement.push(microphones.map((track) => track.enabled));
  });
  vi.mocked(attachLocalTracks).mockReturnValue({ audioSender: null, videoSender: { replaceTrack } as unknown as RTCRtpSender });
  // Mute before the asynchronous call metadata/capture work starts.
  useCallStore.getState().toggleMute();
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  await act(async () => { await state.toggleScreenShare(); });
  expect(displayAudio.enabled).toBe(false);
  await act(async () => { await state.handleToggleVideo(); });
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(new TestMediaStream([restartedCamera, cameraAudio]) as unknown as MediaStream);
  await act(async () => { await state.handleToggleVideo(); });
  expect(cameraAudio.enabled).toBe(false);
  await act(async () => { await state.toggleScreenShare(); });

  expect(enabledAtReplacement).toEqual([[false, false], [false, false]]);
  expect(useCallStore.getState().localStream!.getAudioTracks().map((track) => track.enabled)).toEqual([false, false]);
  await act(async () => state.toggleMute());
  expect(microphones.map((track) => track.enabled)).toEqual([true, true]);
});

it("P2: retains the screen-sharing preview stream when the camera is turned off and on", async () => {
  vi.stubGlobal("MediaStream", TestMediaStream);
  const microphone = mediaTrack("audio");
  const camera = mediaTrack("video");
  const screen = mediaTrack("video");
  vi.stubGlobal("navigator", { mediaDevices: {
    getUserMedia: vi.fn(async () => new TestMediaStream([microphone, camera])),
    getDisplayMedia: vi.fn(async () => new TestMediaStream([screen])),
  } });
  configureVideoCall();
  const replaceTrack = vi.fn(async () => {});
  vi.mocked(attachLocalTracks).mockReturnValue({ audioSender: null, videoSender: { replaceTrack } as unknown as RTCRtpSender });
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const preview = () => container.querySelector<HTMLVideoElement>('video[aria-label="Your video"]')!;
  await act(async () => root.render(<MemoryRouter><CallPage /></MemoryRouter>));
  expect(preview().srcObject).toBe(useCallStore.getState().localStream);
  await act(async () => button("Share screen").click());
  await act(async () => button("Turn off camera").click());
  const sharedStream = useCallStore.getState().localStream;
  expect(sharedStream!.getVideoTracks()).toEqual([screen]);
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(new TestMediaStream([mediaTrack("video")]) as unknown as MediaStream);
  await act(async () => button("Turn on camera").click());
  expect(useCallStore.getState().localStream).toBe(sharedStream);
  expect(preview()).not.toBeNull();
  expect(preview().srcObject).toBe(sharedStream);
});

it("stops capture that resolves after leaving the call", async () => {
  let resolve!: (stream: MediaStream) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(new Promise((r) => { resolve = r; }));
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  await act(async () => root.unmount());
  await act(async () => resolve(stream));
  expect(stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  root = createRoot(container);
});

it("reports malformed signaling and releases media on terminal setup failure", async () => {
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  await act(async () => { await sockets[0].onmessage!({ data: "invalid json" }); });
  expect(state.stage).toBe("ended");
  expect(state.error).toBeTruthy();
  expect(stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});

it.each(["offer", "answer"])("exposes typed unsupported %s signaling failures and stops capture", async (direction) => {
  if (direction === "offer") {
    vi.mocked(createPeerConnection).mockResolvedValueOnce({ close, createOffer: vi.fn().mockRejectedValue(new E2EECallUnsupportedError()) } as unknown as RTCPeerConnection);
  } else {
    vi.mocked(acceptCallOffer).mockRejectedValueOnce(new E2EECallUnsupportedError());
  }
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  await act(async () => {
    if (direction === "offer") await sockets[0].onopen!();
    else await sockets[0].onmessage!({ data: JSON.stringify({ type: WSFrameType.Signal, payload: { kind: "offer", sdp: "offer" } }) });
  });
  expect(state.callUnsupported).toBe(true);
  expect(state.stage).toBe("ended");
  expect(stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});

it("does not restart capture when the user's profile changes", async () => {
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  await act(async () => { useAuthStore.setState({ user: { id: "alice", displayName: "New name" } } as never); });
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  expect(stop).not.toHaveBeenCalled();
});

it("retains the elapsed duration when the call ends", async () => {
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  vi.useFakeTimers();
  await act(async () => onRemote(stream));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(state.callDuration).toBe(2);
  await act(async () => useCallStore.getState().updateCallStatus("call", "ended"));
  expect(state.stage).toBe("ended");
  expect(state.callDuration).toBe(2);
});

it("ends local capture immediately even if the end-call request never resolves", async () => {
  vi.mocked(api.post).mockReturnValue(new Promise(() => {}));
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  await act(async () => { state.handleEnd(); state.handleEnd(); });
  expect(stop).toHaveBeenCalled();
  expect(useCallStore.getState().localStream).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(1);
});

it.each(["unmount", "session expiry", "camera restart"])("stops all acquired tracks during screen share on %s", async (cleanup) => {
  const audio = { kind: "audio", stop: vi.fn() };
  const camera = { kind: "video", stop: vi.fn() };
  const screen = { kind: "video", stop: vi.fn() };
  const extraDisplayTrack = { kind: "audio", stop: vi.fn() };
  const restartedCamera = { kind: "video", stop: vi.fn() };
  class TestStream {
    constructor(private tracks: Array<{ kind: string; stop: () => void }>) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
  }
  vi.stubGlobal("MediaStream", TestStream);
  vi.stubGlobal("navigator", { mediaDevices: {
    getUserMedia: vi.fn(async () => new TestStream([audio, camera])),
    getDisplayMedia: vi.fn(async () => new TestStream([screen, extraDisplayTrack])),
  } });
  useCallStore.getState().setOutgoingCall({ callId: "call", conversationId: "chat", callType: "video", initiatorId: "alice" });
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "call", conversationId: "chat", type: "video", status: "active", initiatorId: "alice" }
    : { id: "chat", members: [] }) as never);
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  await act(async () => { await state.toggleScreenShare(); });
  expect(state.isSharingScreen).toBe(true);
  expect(useCallStore.getState().localStream!.getVideoTracks()).toEqual([screen]);
  expect(camera.stop).not.toHaveBeenCalled();
  if (cleanup === "camera restart") {
    await act(async () => { await state.handleToggleVideo(); });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(new TestStream([restartedCamera]) as unknown as MediaStream);
    await act(async () => { await state.handleToggleVideo(); });
    expect(restartedCamera.stop).not.toHaveBeenCalled();
  }
  if (cleanup === "session expiry") {
    const { api: realApi } = await vi.importActual<typeof import("../../services/api.js")>("../../services/api.js");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Expired" }), { status: 401 })));
    const atNavigation = vi.fn(() => {
      for (const track of [audio, camera, screen, extraDisplayTrack]) expect(track.stop).toHaveBeenCalled();
    });
    const unregister = registerNavigate(atNavigation);
    try {
      await act(async () => { await expect(realApi.get("/api/data")).rejects.toMatchObject({ status: 401 }); });
      expect(atNavigation).toHaveBeenCalledWith("/login");
    } finally {
      unregister();
    }
  } else if (cleanup !== "unmount") {
    await act(async () => {
      // Expiry cleanup must release parked tracks synchronously, before React unmounts.
      clearAccountScopedState();
      for (const track of [audio, camera, screen, extraDisplayTrack]) expect(track.stop).toHaveBeenCalled();
      if (cleanup === "camera restart") expect(restartedCamera.stop).toHaveBeenCalled();
    });
  }
  await act(async () => root.unmount());
  for (const track of [audio, camera, screen, extraDisplayTrack]) expect(track.stop).toHaveBeenCalled();
  root = createRoot(container);
});
