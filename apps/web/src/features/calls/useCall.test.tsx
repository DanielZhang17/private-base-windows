import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useIncomingCall } from "./useIncomingCall.js";
import { capabilities } from "../../platform/capabilities.js";
import { useCall } from "./useCall.js";
import { CallProvider } from "./CallProvider.js";
import { ToastProvider } from "../../ui/index.js";
import type { ReactNode } from "react";
import IncomingCallModal from "../../components/calls/IncomingCallModal.js";
import CallPage from "../../pages/CallPage.js";
import { useCallStore } from "../../stores/callStore.js";
import { useAuthStore } from "../../stores/authStore.js";
import { api } from "../../services/api.js";
import { acceptCallOffer, attachLocalTracks, createPeerConnection, supportsE2EECalling, disposeCallTransforms, sendSignal, deriveCallKey } from "../../services/webrtc.js";
import { WSFrameType } from "@e2ee-chat/shared";
import { E2EECallUnsupportedError } from "../../platform/calls.js";
import { clearAccountScopedState } from "../../platform/session.js";
import { registerNavigate } from "../../platform/navigation.js";
import { invoke } from "@tauri-apps/api/core";
import { getPendingCall } from "../../db/index.js";

vi.mock("../chat/useOutgoingQueue.js", () => ({ useOutgoingQueue: () => ({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "alice" }, accessToken: "token", refreshToken: null, logout: vi.fn() })) };
});
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() }, resolveWsBaseUrl: () => "wss://test", resolveApiUrl: (path: string) => path }));
vi.mock("../../db/index.js", () => ({ getPendingCall: vi.fn(async () => ({ callKey: "key", expiresAt: Date.now() + 60000 })), deletePendingCall: vi.fn(async () => {}) }));
vi.mock("../../lib/message-sync.js", () => ({ syncMessages: vi.fn() }));
vi.mock("@e2ee-chat/crypto", () => ({ fromBase64Url: () => new Uint8Array([1]) }));
vi.mock("../../services/webrtc.js", () => ({
  disposeCallTransforms: vi.fn(), deriveCallKey: vi.fn(async () => ({})), supportsE2EECalling: vi.fn(() => true), createPeerConnection: vi.fn(),
  attachLocalTracks: vi.fn(() => ({ audioSender: null, videoSender: null })), addSenderTransform: vi.fn(), acceptCallOffer: vi.fn(), sendSignal: vi.fn(),
}));
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useCall>;
let stream: MediaStream;
let stop: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
const sockets: Array<{ close: ReturnType<typeof vi.fn>; onmessage?: (event: { data: string }) => Promise<void>; onopen?: () => Promise<void> }> = [];
let mediaPlay: ReturnType<typeof vi.spyOn>;
let onRemote: (stream: MediaStream) => void;
function Harness({ children }: { children: ReactNode }) {
  return <MemoryRouter><ToastProvider><CallProvider enabled>{children}</CallProvider></ToastProvider></MemoryRouter>;
}
function Probe() { state = useCall(); return null; }
beforeEach(() => {
  vi.clearAllMocks();
  mediaPlay = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.mocked(deriveCallKey).mockReset().mockResolvedValue({} as never);
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
  useAuthStore.setState({ user: { id: "alice" }, device: { id: "device" }, sessionId: "session", authEpoch: 0 } as never);
  useCallStore.getState().clearAllCalls();
  useCallStore.getState().setOutgoingCall({ callId: "call", conversationId: "chat", callType: "audio", initiatorId: "alice" });
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "call", conversationId: "chat", type: "audio", status: "active", initiatorId: "alice" }
    : { id: "chat", members: [] }) as never);
  container = document.createElement("div"); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); clearAccountScopedState(); vi.useRealTimers(); mediaPlay.mockRestore(); vi.unstubAllGlobals(); });

it("reports unsupported E2EE as typed state before capturing any media", async () => {
  vi.mocked(supportsE2EECalling).mockReturnValue(false);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => root.render(<Harness><Probe /></Harness>));
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
  await act(async () => root.render(<Harness><Probe /></Harness>));
  expect(state.callUnsupported).toBe(true);
  expect(state.stage).toBe("ended");
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  log.mockRestore();
});

it("closes signaling, peer connections and captured audio on unmount", async () => {
  await act(async () => root.render(<Harness><Probe /></Harness>));
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
  const track = { kind, enabled: true, readyState: "live", stop: vi.fn() };
  track.stop.mockImplementation(() => { track.readyState = "ended"; });
  return track;
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

  await act(async () => root.render(<Harness><Probe /></Harness>));
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
  await act(async () => root.render(<Harness><Probe /></Harness>));
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
  await act(async () => root.render(<Harness><Probe /></Harness>));
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
  await act(async () => root.render(<Harness><CallPage /></Harness>));
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
  await act(async () => root.render(<Harness><Probe /></Harness>));
  await act(async () => root.unmount());
  await act(async () => resolve(stream));
  expect(stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  root = createRoot(container);
});

it("reports malformed signaling and releases media on terminal setup failure", async () => {
  await act(async () => root.render(<Harness><Probe /></Harness>));
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
  await act(async () => root.render(<Harness><Probe /></Harness>));
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
  await act(async () => root.render(<Harness><Probe /></Harness>));
  await act(async () => { useAuthStore.setState({ user: { id: "alice", displayName: "New name" } } as never); });
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  expect(stop).not.toHaveBeenCalled();
});

it("retains the elapsed duration when the call ends", async () => {
  await act(async () => root.render(<Harness><Probe /></Harness>));
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
  await act(async () => root.render(<Harness><Probe /></Harness>));
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
  await act(async () => root.render(<Harness><Probe /></Harness>));
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


function RouteProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output>{location.pathname}</output><button onClick={() => navigate("/chat/other")}>Other chat</button><Probe />
    <Routes><Route path="/call/:callId" element={<CallPage />} /><Route path="*" element={<input aria-label="Draft" defaultValue="A message during the call" />} /></Routes></>;
}
function RoutingHarness({ enabled = true }: { enabled?: boolean }) {
  return <MemoryRouter initialEntries={["/call/call"]}><ToastProvider><CallProvider enabled={enabled}><RouteProbe /></CallProvider></ToastProvider></MemoryRouter>;
}
async function connectAndMinimize() {
  await act(async () => root.render(<RoutingHarness />));
  await act(async () => onRemote(stream));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Minimise call"]')!.click());
}

it.each(["audio", "video"])("keeps %s media, signaling, transforms and audio mounted through minimize, chat navigation and expand", async (kind) => {
  if (kind === "video") configureVideoCall();
  const microphone = mediaTrack("audio");
  stream = new TestMediaStream([microphone]) as unknown as MediaStream;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream);
  const transform = {};
  const sender = { track: microphone, transform };
  vi.mocked(attachLocalTracks).mockReturnValue({ audioSender: sender as unknown as RTCRtpSender, videoSender: null });
  await act(async () => root.render(<RoutingHarness />));
  vi.useFakeTimers();
  await act(async () => onRemote(stream));
  const audio = container.querySelector("audio")!;
  expect(audio.srcObject).toBe(stream);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Minimise call"]')!.click());
  expect(container.querySelector("output")!.textContent).toBe("/chat/chat");
  expect(container.querySelector(".call-bubble")).not.toBeNull();
  expect(useCallStore.getState().isMinimized).toBe(true);
  const draft = container.querySelector("input")!;
  await act(async () => container.querySelector<HTMLButtonElement>("output + button")!.click());
  expect(container.querySelector("output")!.textContent).toBe("/chat/other");
  expect(container.querySelector("input")).toBe(draft);
  await act(async () => vi.advanceTimersByTime(2000));
  expect(state.callDuration).toBe(2);
  expect(container.querySelector(".call-bubble .tabular-nums")?.textContent).toBe("00:02");
  expect(container.querySelector('[aria-label^="Ongoing call"]')?.getAttribute("aria-label")).toContain("00:02");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Ongoing call"]')!.click());
  expect(container.querySelector("output")!.textContent).toBe("/call/call");
  expect(container.querySelector(".call-bubble")).toBeNull();
  expect(useCallStore.getState().isMinimized).toBe(false);
  expect(container.querySelector("audio")).toBe(audio);
  expect(audio.srcObject).toBe(stream);
  expect(close).not.toHaveBeenCalled();
  expect(microphone.stop).not.toHaveBeenCalled();
  expect(microphone.readyState).toBe("live");
  expect(sockets[0].close).not.toHaveBeenCalled();
  expect(disposeCallTransforms).not.toHaveBeenCalled();
  expect(attachLocalTracks).toHaveBeenCalledOnce();
  expect(createPeerConnection).toHaveBeenCalledOnce();
  expect(sender.transform).toBe(transform);
});

it("ends from the bubble immediately and keeps the current chat and draft", async () => {
  await connectAndMinimize();
  const draft = container.querySelector("input")!;
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="End call"]')!.click());
  expect(container.querySelector(".call-bubble")).toBeNull();
  expect(container.querySelector("output")!.textContent).toBe("/chat/chat");
  expect(container.querySelector("input")).toBe(draft);
  expect(stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(disposeCallTransforms).toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledWith("/api/calls/call/end");
  expect(document.body.textContent).toContain("Call ended");
});

it("removes the bubble on remote hangup, stops media and shows end feedback without leaving the current chat", async () => {
  await connectAndMinimize();
  const draft = container.querySelector("input")!;
  await act(async () => useCallStore.getState().updateCallStatus("call", "ended"));
  expect(container.querySelector(".call-bubble")).toBeNull();
  expect(stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(disposeCallTransforms).toHaveBeenCalled();
  expect(document.body.textContent).toContain("Call ended");
  vi.useFakeTimers();
  await act(async () => vi.advanceTimersByTime(3000));
  expect(container.querySelector("output")!.textContent).toBe("/chat/chat");
  expect(container.querySelector("input")).toBe(draft);
});

it.each(["lock", "sign-out"])("stops microphone, parked camera, screen and remote tracks when %s leaves the unlocked app", async () => {
  const microphone = mediaTrack("audio");
  const camera = mediaTrack("video");
  const screen = mediaTrack("video");
  const displayAudio = mediaTrack("audio");
  const remote = mediaTrack("audio");
  vi.stubGlobal("MediaStream", TestMediaStream);
  stream = new TestMediaStream([microphone, camera]) as unknown as MediaStream;
  vi.stubGlobal("navigator", { mediaDevices: {
    getUserMedia: vi.fn(async () => stream),
    getDisplayMedia: vi.fn(async () => new TestMediaStream([screen, displayAudio])),
  } });
  configureVideoCall();
  vi.mocked(attachLocalTracks).mockReturnValue({ audioSender: null, videoSender: { replaceTrack: vi.fn(async () => {}) } as unknown as RTCRtpSender });
  await act(async () => root.render(<RoutingHarness />));
  await act(async () => onRemote(new TestMediaStream([remote]) as unknown as MediaStream));
  await act(async () => state.toggleScreenShare());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Minimise call"]')!.click());
  await act(async () => root.render(<RoutingHarness enabled={false} />));
  for (const track of [microphone, camera, screen, displayAudio, remote]) expect(track.stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(sockets[0].close).toHaveBeenCalled();
  expect(disposeCallTransforms).toHaveBeenCalled();
  expect(useCallStore.getState().activeCallId).toBeNull();
  expect(container.querySelector("audio")).toBeNull();
  expect(container.querySelector(".call-bubble")).toBeNull();
});


it("starts a fresh call after hangup without inheriting terminal state or the previous timer", async () => {
  await connectAndMinimize();
  await act(async () => useCallStore.getState().updateCallStatus("call", "ended"));
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "next", conversationId: "other", type: "audio", status: "active", initiatorId: "alice" }
    : { id: "other", members: [] }) as never);
  const nextMicrophone = mediaTrack("audio");
  const nextStream = new TestMediaStream([nextMicrophone]) as unknown as MediaStream;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(nextStream);
  await act(async () => useCallStore.getState().setOutgoingCall({ callId: "next", conversationId: "other", callType: "audio", initiatorId: "alice" }));
  expect(state.stage).toBe("connecting");
  expect(state.callDuration).toBe(0);
  expect(useCallStore.getState().localStream).toBe(nextStream);
  expect(nextMicrophone.stop).not.toHaveBeenCalled();
  vi.useFakeTimers();
  await act(async () => onRemote(nextStream));
  await act(async () => vi.advanceTimersByTime(3500));
  expect(state.stage).toBe("connected");
  expect(useCallStore.getState().activeCallId).toBe("next");
  expect(nextMicrophone.stop).not.toHaveBeenCalled();
});

it.each(["screen", "camera"])("stops late %s capture after lock while the root provider remains mounted", async (kind) => {
  const microphone = mediaTrack("audio");
  const camera = mediaTrack("video");
  const lateTrack = mediaTrack("video");
  let resolve!: (stream: MediaStream) => void;
  const lateCapture = new Promise<MediaStream>((done) => { resolve = done; });
  vi.stubGlobal("MediaStream", TestMediaStream);
  stream = new TestMediaStream([microphone, camera]) as unknown as MediaStream;
  vi.stubGlobal("navigator", { mediaDevices: {
    getUserMedia: vi.fn(async () => stream), getDisplayMedia: vi.fn(() => lateCapture),
  } });
  configureVideoCall();
  const replaceTrack = vi.fn(async () => {});
  vi.mocked(attachLocalTracks).mockReturnValue({ audioSender: null, videoSender: { replaceTrack } as unknown as RTCRtpSender });
  await act(async () => root.render(<RoutingHarness />));
  if (kind === "camera") {
    await act(async () => state.handleToggleVideo());
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(lateCapture);
  }
  let pending!: Promise<void>;
  await act(async () => { pending = kind === "screen" ? state.toggleScreenShare() : state.handleToggleVideo(); });
  await act(async () => root.render(<RoutingHarness enabled={false} />));
  const replacementsAtLock = replaceTrack.mock.calls.length;
  await act(async () => { resolve(new TestMediaStream([lateTrack]) as unknown as MediaStream); await pending; });
  expect(lateTrack.stop).toHaveBeenCalled();
  expect(replaceTrack).toHaveBeenCalledTimes(replacementsAtLock);
  expect(useCallStore.getState().localStream).toBeNull();
});


it("keeps the full call's ended state and lets Back to chat leave immediately", async () => {
  await act(async () => root.render(<RoutingHarness />));
  await act(async () => onRemote(stream));
  await act(async () => useCallStore.getState().updateCallStatus("call", "ended"));
  expect(state.stage).toBe("ended");
  expect(container.querySelector("output")!.textContent).toBe("/call/call");
  const back = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Back to chat")!;
  await act(async () => back.click());
  expect(container.querySelector("output")!.textContent).toBe("/chat/chat");
});


it("does not resume a call from a stale call URL after reload", async () => {
  useCallStore.getState().clearAllCalls();
  await act(async () => root.render(<RoutingHarness />));
  expect(state.stage).toBe("ended");
  expect(api.get).not.toHaveBeenCalled();
  expect(createPeerConnection).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(container.querySelector(".call-bubble")).toBeNull();
  const back = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Back to chat")!;
  await act(async () => back.click());
  expect(container.querySelector("output")!.textContent).toBe("/");
});


it("leaves an incoming ringing/declined invitation to the modal without starting a call", async () => {
  useCallStore.getState().setIncomingCall({ callId: "invite", conversationId: "chat", callType: "audio", initiatorId: "bob", callerUserId: "bob" });
  await act(async () => root.render(<Harness><Probe /></Harness>));
  await act(async () => useCallStore.getState().updateCallStatus("invite", "declined"));
  expect(api.get).not.toHaveBeenCalled();
  expect(createPeerConnection).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(container.querySelector(".call-bubble")).toBeNull();
});

it("keeps an accepted incoming call alive when minimised and removes it on remote hangup", async () => {
  useCallStore.getState().setIncomingCall({ callId: "call", conversationId: "chat", callType: "audio", initiatorId: "bob", callerUserId: "bob", keyReady: true });
  useCallStore.getState().acceptLocalCall("call");
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "call", conversationId: "chat", type: "audio", status: "active", initiatorId: "bob" }
    : { id: "chat", members: [] }) as never);
  await connectAndMinimize();
  expect(container.querySelector(".call-bubble")).not.toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  await act(async () => useCallStore.getState().updateCallStatus("call", "ended"));
  expect(container.querySelector(".call-bubble")).toBeNull();
  expect(close).toHaveBeenCalled();
  expect(stop).toHaveBeenCalled();
});


it("retains the full call's elapsed end state and return timer when notification cleanup clears the store", async () => {
  await act(async () => root.render(<RoutingHarness />));
  vi.useFakeTimers();
  await act(async () => onRemote(stream));
  await act(async () => vi.advanceTimersByTime(2000));
  await act(async () => useCallStore.getState().updateCallStatus("call", "ended"));
  await act(async () => vi.advanceTimersByTime(1500));
  await act(async () => useCallStore.getState().clearCall("call"));
  expect(state.stage).toBe("ended");
  expect(state.callDuration).toBe(2);
  await act(async () => vi.advanceTimersByTime(1500));
  expect(container.querySelector("output")!.textContent).toBe("/chat/chat");
});


it.each([
  { label: "outgoing direct", type: "direct", initiatorId: "alice", name: "Custom chat name", groupAvatar: null, expectedName: "Mara", expectedAvatar: "r2://mara", callerName: "Alice", callerAvatar: "r2://alice" },
  { label: "incoming direct", type: "direct", initiatorId: "mara", name: null, groupAvatar: null, expectedName: "Mara", expectedAvatar: "r2://mara", callerName: "Mara", callerAvatar: "r2://mara" },
  { label: "outgoing group", type: "group", initiatorId: "alice", name: "Field team", groupAvatar: "r2://team", expectedName: "Field team", expectedAvatar: "r2://team", callerName: "Alice", callerAvatar: "r2://alice" },
  { label: "incoming group without avatar", type: "group", initiatorId: "mara", name: "Field team", groupAvatar: null, expectedName: "Field team", expectedAvatar: null, callerName: "Mara", callerAvatar: "r2://mara" },
])("shows the peer/group identity in both call views for $label, preserving caller metadata", async (test) => {
  if (test.initiatorId !== "alice") {
    useCallStore.getState().setIncomingCall({ callId: "call", conversationId: "chat", callType: "audio", initiatorId: test.initiatorId, callerUserId: test.initiatorId, keyReady: true });
    useCallStore.getState().acceptLocalCall("call");
  }
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "call", conversationId: "chat", type: "audio", status: "active", initiatorId: test.initiatorId }
    : { id: "chat", type: test.type, name: test.name, avatarUrl: test.groupAvatar, members: [
      { userId: "alice", user: { displayName: "Alice", avatarUrl: "r2://alice" } },
      { userId: "mara", user: { displayName: "Mara", avatarUrl: "r2://mara" } },
    ] }) as never);
  await act(async () => root.render(<RoutingHarness />));
  expect(state.peerName).toBe(test.expectedName);
  expect(state.peerAvatarUrl).toBe(test.expectedAvatar);
  expect(state.isGroupCall).toBe(test.type === "group");
  expect(useCallStore.getState().callerName).toBe(test.callerName);
  expect(useCallStore.getState().callerAvatarUrl).toBe(test.callerAvatar);
  const assertAvatar = () => {
    const avatar = container.querySelector(`[role="img"][aria-label="${test.expectedName}"]`)!;
    expect(avatar).not.toBeNull();
    if (test.expectedAvatar) expect(avatar.querySelector("img")?.getAttribute("src")).toBe(`/api/account/avatar/${test.expectedAvatar.slice(5)}`);
    else { expect(avatar.querySelector("img")).toBeNull(); expect(avatar.textContent).toBe("FT"); }
    if (test.type === "group") expect(avatar.firstElementChild?.className).toContain("rounded-[30%]");
  };
  expect(container.querySelector("h1")?.textContent).toBe(test.expectedName);
  expect(document.title).toContain(test.expectedName);
  assertAvatar();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Minimise call"]')!.click());
  assertAvatar();
  expect(container.querySelector('[aria-label^="Ongoing call"]')?.getAttribute("aria-label"))
    .toBe(`Ongoing call with ${test.expectedName}, 00:00. Return to call`);
});


let incoming: ReturnType<typeof useIncomingCall>;
function IncomingProbe() { incoming = useIncomingCall(); return null; }
function incomingCall() {
  useCallStore.getState().setIncomingCall({ callId: "call", conversationId: "chat", callType: "audio", initiatorId: "bob", callerUserId: "bob", keyReady: true });
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "call", conversationId: "chat", type: "audio", status: "active", initiatorId: "bob" }
    : { id: "chat", members: [] }) as never);
}

it.each(["another device", "another tab sharing the same browser's pending call key"])("P1 privacy: acceptance on %s dismisses the invite without local capture or signaling", async () => {
  incomingCall();
  await act(async () => root.render(<Harness><Probe /><IncomingProbe /></Harness>));
  expect(incoming.visible).toBe(true);
  // Both contexts receive the same authenticated call event and can recover its key.
  // Neither has run this tab's explicit Accept action.
  await act(async () => useCallStore.getState().updateCallStatus("call", "active"));
  expect(incoming.visible).toBe(false);
  expect(createPeerConnection).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(0);
  expect(sendSignal).not.toHaveBeenCalled();
  expect(container.querySelector(".call-bubble")).toBeNull();
});

it("P1 privacy: an active incoming call deep link does not confer local consent", async () => {
  incomingCall();
  useCallStore.getState().updateCallStatus("call", "active");
  await act(async () => root.render(<RoutingHarness />));
  expect(createPeerConnection).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(0);
  expect(sendSignal).not.toHaveBeenCalled();
});

it("P1 privacy: server hydration of outgoing metadata does not confer local Start consent", async () => {
  useCallStore.getState().clearAllCalls();
  useCallStore.getState().hydrateCall({ callId: "call", conversationId: "chat", callType: "audio", initiatorId: "alice", direction: "outgoing", status: "active", keyReady: true });
  await act(async () => root.render(<RoutingHarness />));
  expect(createPeerConnection).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(0);
});

it("P1 privacy: explicit local Accept still starts the encrypted incoming call", async () => {
  incomingCall();
  const support = vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  vi.mocked(api.post).mockResolvedValue({} as never);
  try {
    await act(async () => root.render(<Harness><Probe /><IncomingProbe /></Harness>));
    await act(async () => incoming.respond("accept"));
    expect(api.post).toHaveBeenCalledWith("/api/calls/call/accept");
    expect(createPeerConnection).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);
    expect(incoming.visible).toBe(false);
  } finally { support.mockRestore(); }
});

it.each(["resolve", "reject"])("P2 epoch: a stale ICE-restart %s from call A cannot signal for or end call B", async (outcome) => {
  let resolve!: (offer: RTCSessionDescriptionInit) => void;
  let reject!: (error: Error) => void;
  const restart = new Promise<RTCSessionDescriptionInit>((yes, no) => { resolve = yes; reject = no; });
  const pcA = { close: vi.fn(), connectionState: "failed", createOffer: vi.fn(() => restart), setLocalDescription: vi.fn(async () => {}), onconnectionstatechange: null as (() => void) | null };
  const pcB = { close: vi.fn(), connectionState: "new" };
  vi.mocked(api.post).mockResolvedValue({} as never);
  vi.mocked(createPeerConnection).mockReset().mockResolvedValueOnce(pcA as unknown as RTCPeerConnection).mockResolvedValueOnce(pcB as unknown as RTCPeerConnection);
  vi.stubGlobal("WebSocket", class {
    static OPEN = 1;
    readyState = 1;
    close = vi.fn();
    constructor() { sockets.push(this); }
  });
  await act(async () => root.render(<Harness><Probe /></Harness>));
  await act(async () => pcA.onconnectionstatechange!());
  expect(pcA.createOffer).toHaveBeenCalledWith({ iceRestart: true });
  await act(async () => state.handleEnd());
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "next", conversationId: "other", type: "audio", status: "active", initiatorId: "alice" }
    : { id: "other", members: [] }) as never);
  const microphoneB = mediaTrack("audio");
  const streamB = new TestMediaStream([microphoneB]) as unknown as MediaStream;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamB);
  await act(async () => useCallStore.getState().setOutgoingCall({ callId: "next", conversationId: "other", callType: "audio", initiatorId: "alice" }));
  expect(state.stage).toBe("connecting");
  await act(async () => {
    if (outcome === "reject") reject(new Error("Old restart failed"));
    else resolve({ type: "offer", sdp: "stale-offer" });
  });
  expect(state.stage).toBe("connecting");
  expect(state.error).toBeNull();
  expect(useCallStore.getState().localStream).toBe(streamB);
  expect(pcB.close).not.toHaveBeenCalled();
  expect(microphoneB.stop).not.toHaveBeenCalled();
  expect(pcA.setLocalDescription).not.toHaveBeenCalled();
  expect(sendSignal).not.toHaveBeenCalled();
});


it.each(["call metadata", "conversation metadata", "key derivation"])("P2 epoch: late %s cannot hydrate or capture over the next call", async (step) => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise<unknown>((done) => { resolve = done; });
  const infoA = { id: "call", conversationId: "chat", type: "audio", status: "active", initiatorId: "alice" };
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === "/api/calls/call") return (step === "call metadata" ? pending : infoA) as never;
    if (path === "/api/conversations/chat") return (step === "conversation metadata" ? pending : { id: "chat", members: [] }) as never;
    return (path.startsWith("/api/calls/")
      ? { id: "next", conversationId: "other", type: "audio", status: "active", initiatorId: "alice" }
      : { id: "other", members: [] }) as never;
  });
  if (step === "key derivation") vi.mocked(deriveCallKey).mockReturnValueOnce(pending as never);
  await act(async () => root.render(<Harness><Probe /></Harness>));
  expect(createPeerConnection).not.toHaveBeenCalled();
  const microphoneB = mediaTrack("audio");
  const streamB = new TestMediaStream([microphoneB]) as unknown as MediaStream;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamB);
  await act(async () => useCallStore.getState().setOutgoingCall({ callId: "next", conversationId: "other", callType: "audio", initiatorId: "alice" }));
  await act(async () => resolve(step === "call metadata" ? infoA : step === "conversation metadata" ? { id: "chat", members: [] } : {}));
  expect(useCallStore.getState().activeCallId).toBe("next");
  expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "next", reason: "started" });
  expect(useCallStore.getState().localStream).toBe(streamB);
  expect(createPeerConnection).toHaveBeenCalledOnce();
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  expect(microphoneB.stop).not.toHaveBeenCalled();
  expect(state.stage).toBe("connecting");
});

it("P2 epoch: late capture for A stops only A's tracks and cannot replace B's stream", async () => {
  let resolve!: (stream: MediaStream) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await act(async () => root.render(<Harness><Probe /></Harness>));
  const microphoneA = mediaTrack("audio");
  const microphoneB = mediaTrack("audio");
  const streamB = new TestMediaStream([microphoneB]) as unknown as MediaStream;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamB);
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "next", conversationId: "other", type: "audio", status: "active", initiatorId: "alice" }
    : { id: "other", members: [] }) as never);
  await act(async () => useCallStore.getState().setOutgoingCall({ callId: "next", conversationId: "other", callType: "audio", initiatorId: "alice" }));
  await act(async () => resolve(new TestMediaStream([microphoneA]) as unknown as MediaStream));
  expect(microphoneA.stop).toHaveBeenCalled();
  expect(microphoneB.stop).not.toHaveBeenCalled();
  expect(useCallStore.getState().localStream).toBe(streamB);
  expect(attachLocalTracks).toHaveBeenCalledOnce();
});

it("P1 privacy: an accepted notification during a local Accept request cannot start media until that local response succeeds", async () => {
  incomingCall();
  const support = vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  let resolve!: (value: never) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  try {
    await act(async () => root.render(<Harness><Probe /><IncomingProbe /></Harness>));
    let accepting!: Promise<void>;
    await act(async () => { accepting = incoming.respond("accept"); });
    await act(async () => useCallStore.getState().updateCallStatus("call", "active"));
    expect(incoming.visible).toBe(false);
    expect(createPeerConnection).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    await act(async () => { resolve({} as never); await accepting; });
    expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "call", reason: "accepted" });
    expect(createPeerConnection).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  } finally { support.mockRestore(); }
});

it("P1 privacy: a late Accept response after session teardown cannot restore consent or media", async () => {
  incomingCall();
  const support = vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  let resolve!: (value: never) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  try {
    await act(async () => root.render(<Harness><Probe /><IncomingProbe /></Harness>));
    let accepting!: Promise<void>;
    await act(async () => { accepting = incoming.respond("accept"); });
    await act(async () => clearAccountScopedState());
    await act(async () => { resolve({} as never); await accepting; });
    expect(useCallStore.getState().localCallOwnership).toBeNull();
    expect(useCallStore.getState().activeCallId).toBeNull();
    expect(createPeerConnection).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  } finally { support.mockRestore(); }
});


it.each(["device", "session"])("P2 epoch: a changed login %s cancels late capture before the provider's teardown render", async (identity) => {
  let resolve!: (stream: MediaStream) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await act(async () => root.render(<Harness><Probe /></Harness>));
  await act(async () => useAuthStore.setState((identity === "device" ? { device: { id: "different-device" } } : { sessionId: "different-session" }) as never));
  const microphone = mediaTrack("audio");
  await act(async () => resolve(new TestMediaStream([microphone]) as unknown as MediaStream));
  expect(microphone.stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(attachLocalTracks).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(0);
});


it("round 3: a cross-tab authEpoch change keeps this tab's duration and signaling running", async () => {
  const microphone = mediaTrack("audio");
  stream = new TestMediaStream([microphone]) as unknown as MediaStream;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream);
  const pc = { close, connectionState: "connected", createOffer: vi.fn(async () => ({ type: "offer", sdp: "restart" })), setLocalDescription: vi.fn(async () => {}), onconnectionstatechange: null as (() => void) | null };
  vi.mocked(createPeerConnection).mockImplementationOnce(async (_id, _key, remote) => { onRemote = remote; return pc as unknown as RTCPeerConnection; });
  vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 1; close = vi.fn(); constructor() { sockets.push(this); } });
  await act(async () => root.render(<Harness><Probe /></Harness>));
  vi.useFakeTimers();
  await act(async () => onRemote(stream));
  await act(async () => useAuthStore.setState({ authEpoch: 2 } as never));
  await act(async () => vi.advanceTimersByTime(2000));
  expect(state.callDuration).toBe(2);
  expect(state.stage).toBe("connected");
  expect(close).not.toHaveBeenCalled();
  expect(microphone.stop).not.toHaveBeenCalled();
  pc.connectionState = "failed";
  await act(async () => pc.onconnectionstatechange!());
  expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true });
  expect(sendSignal).toHaveBeenCalledWith(sockets[0], { kind: "offer", sdp: "restart", fromUserId: "alice" });
});

function InvitationNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output>{location.pathname}</output><button onClick={() => navigate("/settings")}>Settings</button><Probe />
    <Routes>
      <Route path="/chat/:id" element={<IncomingCallModal key="chat-modal" />} />
      <Route path="/settings" element={<IncomingCallModal key="settings-modal" />} />
      <Route path="/call/:callId" element={<CallPage />} />
    </Routes></>;
}
function InvitationNavigationHarness() {
  return <MemoryRouter initialEntries={["/chat/chat"]}><ToastProvider><CallProvider enabled><InvitationNavigation /></CallProvider></ToastProvider></MemoryRouter>;
}

it("round 3: a pending Accept survives chat-to-Settings modal remount and completes locally", async () => {
  incomingCall();
  const support = vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  let resolve!: (value: never) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  try {
    await act(async () => root.render(<InvitationNavigationHarness />));
    const accept = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Accept")!;
    await act(async () => accept.click());
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Settings")!.click());
    expect(container.querySelector("output")!.textContent).toBe("/settings");
    const remountedAccept = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Accept")!;
    expect(remountedAccept).not.toBe(accept);
    expect(remountedAccept.disabled).toBe(true);
    expect(remountedAccept.getAttribute("aria-busy")).toBe("true");
    await act(async () => useAuthStore.setState({ authEpoch: 3 } as never));
    await act(async () => resolve({} as never));
    expect(container.querySelector("output")!.textContent).toBe("/call/call");
    expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "call", reason: "accepted" });
    expect(createPeerConnection).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(api.post).toHaveBeenCalledOnce();
  } finally { support.mockRestore(); }
});

it("round 3: locking keys locally ends this tab's call", async () => {
  const { lockLocalCryptoState } = await import("../../lib/key-manager.js");
  await connectAndMinimize();
  await act(async () => lockLocalCryptoState());
  expect(stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(sockets[0].close).toHaveBeenCalled();
  expect(useCallStore.getState().localCallOwnership).toBeNull();
  expect(useCallStore.getState().activeCallId).toBeNull();
  expect(container.querySelector(".call-bubble")).toBeNull();
});


it.each(["end", "local lock", "sign-out"])("round 3: %s cancels a pending Accept even after modal navigation", async (reason) => {
  incomingCall();
  const support = vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  let resolve!: (value: never) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  try {
    await act(async () => root.render(<InvitationNavigationHarness />));
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Accept")!.click());
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Settings")!.click());
    const epoch = useCallStore.getState().localCallEpoch;
    if (reason === "local lock") {
      const { lockLocalCryptoState } = await import("../../lib/key-manager.js");
      await act(async () => lockLocalCryptoState());
    } else if (reason === "sign-out") {
      await act(async () => useAuthStore.setState({ user: null, sessionId: null } as never));
    } else await act(async () => useCallStore.getState().updateCallStatus("call", "ended"));
    await act(async () => resolve({} as never));
    expect(useCallStore.getState().localCallEpoch).toBeGreaterThan(epoch);
    expect(useCallStore.getState().localCallOwnership).toBeNull();
    expect(container.querySelector("output")!.textContent).toBe("/settings");
    expect(createPeerConnection).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  } finally { support.mockRestore(); }
});


it("round 4: Minimise uses the store conversation before call metadata has loaded", async () => {
  let resolve!: (value: never) => void;
  vi.mocked(api.get).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await act(async () => root.render(<RoutingHarness />));
  expect(state.localStream).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Minimise call"]')!.click());
  expect(container.querySelector("output")!.textContent).toBe("/chat/chat");
  expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "call", reason: "started" });
  expect(createPeerConnection).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  await act(async () => resolve({ id: "call", conversationId: "chat", type: "audio", status: "active", initiatorId: "alice" } as never));
  expect(container.querySelector("output")!.textContent).toBe("/chat/chat");
  expect(createPeerConnection).toHaveBeenCalledOnce();
});

it("keeps shared incoming controls and response errors on the native call route without acquiring media", async () => {
  incomingCall();
  const native = vi.spyOn(capabilities, "nativeCallNotifications", "get").mockReturnValue(true);
  const supported = vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  vi.mocked(api.post).mockRejectedValueOnce(new Error("Offline"));
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={["/call/call"]}><ToastProvider>
      <CallProvider enabled><CallPage /></CallProvider>
    </ToastProvider></MemoryRouter>));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const accept = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Accept")!;
    await act(async () => accept.click());
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain("Could not respond to call");
    expect(useCallStore.getState().localCallOwnership).toBeNull();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(createPeerConnection).not.toHaveBeenCalled();
  } finally { native.mockRestore(); supported.mockRestore(); }
});

async function startNativeAcceptPost() {
  incomingCall();
  const native = vi.spyOn(capabilities, "nativeCallNotifications", "get").mockReturnValue(true);
  const supported = vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  let hidden = false;
  const visibility = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const unregister = registerNavigate(vi.fn());
  vi.mocked(invoke).mockResolvedValueOnce([{ kind: "accept", id: "call" }]);
  vi.mocked(getPendingCall).mockResolvedValueOnce({ id: "call", direction: "incoming", conversationId: "chat", initiatorId: "bob", callType: "audio", callKey: "key", createdAt: Date.now(), expiresAt: Date.now() + 60000 });
  vi.mocked(api.get).mockImplementation(async (path) => (path.startsWith("/api/calls/")
    ? { id: "call", conversationId: "chat", type: "audio", status: useCallStore.getState().callStatus, initiatorId: "bob", createdAt: Date.now() }
    : { id: "chat", members: [] }) as never);
  let complete!: (value: never) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
  await act(async () => root.render(<Harness><Probe /></Harness>));
  expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/calls/call/accept");
  return {
    complete: () => complete({} as never),
    visibility: async (value: boolean) => { hidden = value; await act(async () => document.dispatchEvent(new Event("visibilitychange"))); },
    restore: () => { native.mockRestore(); supported.mockRestore(); visibility.mockRestore(); unregister(); },
  };
}
it("starts a locally accepted native call after backgrounding during POST and receiving accepted before its response", async () => {
  const accept = await startNativeAcceptPost();
  try {
    await accept.visibility(true);
    await act(async () => useCallStore.getState().updateCallStatus("call", "active"));
    await act(async () => accept.complete());
    expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "call", reason: "accepted" });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(createPeerConnection).not.toHaveBeenCalled();
    await accept.visibility(false);
    expect(createPeerConnection).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(useCallStore.getState().localStream).toBe(stream);
    expect(api.post).toHaveBeenCalledTimes(1);
  } finally { accept.restore(); }
});
it.each([false, true])("ends a native local acceptance that stays hidden beyond the ring window (POST complete=%s)", async (completed) => {
  vi.useFakeTimers();
  const accept = await startNativeAcceptPost();
  try {
    await accept.visibility(true);
    await act(async () => useCallStore.getState().updateCallStatus("call", "active"));
    if (completed) await act(async () => accept.complete());
    vi.mocked(api.post).mockResolvedValue({});
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(api.post).toHaveBeenCalledWith("/api/calls/call/end");
    expect(useCallStore.getState().localCallOwnership).toBeNull();
    expect(useCallStore.getState().activeCallId).toBeNull();
    if (!completed) await act(async () => accept.complete());
    await accept.visibility(false);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(createPeerConnection).not.toHaveBeenCalled();
  } finally { accept.restore(); }
});
it("defers native media acquisition if the app hides while encrypted peer creation is pending", async () => {
  const accept = await startNativeAcceptPost();
  let peerReady!: (value: RTCPeerConnection) => void;
  vi.mocked(createPeerConnection).mockReturnValueOnce(new Promise((resolve) => { peerReady = resolve; }));
  try {
    await act(async () => useCallStore.getState().updateCallStatus("call", "active"));
    await act(async () => accept.complete());
    expect(createPeerConnection).toHaveBeenCalledOnce();
    await accept.visibility(true);
    await act(async () => peerReady({ close, connectionState: "new" } as unknown as RTCPeerConnection));
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    await accept.visibility(false);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  } finally { accept.restore(); }
});
