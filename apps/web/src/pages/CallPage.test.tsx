import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CallPage from "./CallPage.js";
import { useCall } from "../features/calls/useCall.js";
vi.mock("../features/calls/useCall.js", () => ({ useCall: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
const end = vi.fn();
const mute = vi.fn();
const video = vi.fn();
const state = () => ({ stage: "connected", callType: "audio", conversationName: "Chat alias", peerName: "Mara Lindqvist", peerAvatarUrl: "/mara.png", isGroupCall: false, callDuration: 252, formatDuration: () => "04:12", remoteEntries: [], localStream: null, isMuted: false, isVideoOff: false, handleEnd: end, toggleMute: mute, handleToggleVideo: video });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  container = document.createElement("div"); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it("renders a full-window dark call and wires the microphone and end controls", async () => {
  vi.mocked(useCall).mockReturnValue(state() as never);
  await act(async () => root.render(<CallPage />));
  const layer = container.querySelector("section")!;
  expect(layer.dataset.theme).toBe("dark");
  expect(layer.className).toContain("h-dvh");
  expect(container.textContent).toContain("End-to-end encrypted");
  expect(container.querySelector('[aria-live="off"]')?.textContent).toBe("04:12");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Mute microphone"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="End call"]')!.click());
  expect(mute).toHaveBeenCalledOnce(); expect(end).toHaveBeenCalledOnce();
});
it("explains unsupported encryption and only offers return to chat", async () => {
  vi.mocked(useCall).mockReturnValue({ ...state(), stage: "ended", callUnsupported: true } as never);
  await act(async () => root.render(<CallPage />));
  expect(container.textContent).toContain("Encrypted calls aren't supported on this device");
  expect(container.textContent).not.toContain("End-to-end encrypted");
  expect(container.querySelector('[aria-label="Mute microphone"]')).toBeNull();
  await act(async () => container.querySelector("button")!.click());
  expect(end).toHaveBeenCalledOnce();
});
it("exposes camera and microphone toggles with their pressed state", async () => {
  vi.mocked(useCall).mockReturnValue({ ...state(), callType: "video", localStream: {} as MediaStream, isMuted: true, isVideoOff: true } as never);
  await act(async () => root.render(<CallPage />));
  const camera = container.querySelector<HTMLButtonElement>('[aria-label="Turn on camera"]')!;
  expect(camera.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('[aria-label="Unmute microphone"]')?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => camera.click()); expect(video).toHaveBeenCalledOnce();
});
it.each(["ringing", "connecting"])("R2-camera: disables the camera toggle while %s until capture is ready", async (stage) => {
  vi.mocked(useCall).mockReturnValue({ ...state(), stage, callType: "video", localStream: null } as never);
  await act(async () => root.render(<CallPage />));
  const camera = () => container.querySelector<HTMLButtonElement>('[aria-label="Turn off camera"]')!;
  expect(camera().disabled).toBe(true);
  await act(async () => camera().click());
  expect(video).not.toHaveBeenCalled();
  // Pre-capture mute intent remains usable, as required by the round-1 fix.
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Mute microphone"]')!.disabled).toBe(false);
  vi.mocked(useCall).mockReturnValue({ ...state(), stage: "connecting", callType: "video", localStream: {} as MediaStream } as never);
  await act(async () => root.render(<CallPage />));
  expect(camera().disabled).toBe(false);
  await act(async () => camera().click());
  expect(video).toHaveBeenCalledOnce();
});
