import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getByRole } from "@testing-library/dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCall } from "../../features/calls/useCall.js";
import CallBubble from "./CallBubble.js";

vi.mock("../../features/calls/useCall.js", () => ({ useCall: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
const restore = vi.fn();
const end = vi.fn();
const mute = vi.fn();
const remote = new EventTarget() as MediaStream;
let play: ReturnType<typeof vi.spyOn>;
const state = () => ({ callType: "audio", conversationName: "Chat alias", callerAvatarUrl: "/caller.png", peerName: "Mara", peerAvatarUrl: null, isGroupCall: false, callDuration: 192,
  formatDuration: () => "03:12", remoteEntries: [["remote", remote]], isMuted: false,
  restoreCall: restore, handleEnd: end, toggleMute: mute });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.mocked(useCall).mockReturnValue(state() as never);
  container = document.createElement("div"); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("renders the voice avatar, tabular duration and complete accessible return name", async () => {
  await act(async () => root.render(<CallBubble />));
  const expand = getByRole(container, "button", { name: "Ongoing call with Mara, 03:12. Return to call" });
  expect(expand.tabIndex).toBe(0);
  expect(expand.textContent).toContain("Mara");
  expect(container.querySelector(".tabular-nums")?.textContent).toBe("03:12");
  expect(container.querySelector("video")).toBeNull();
  await act(async () => expand.click());
  expect(restore).toHaveBeenCalledOnce();
});
it("renders muted remote video and leaves audio to the persistent provider", async () => {
  vi.mocked(useCall).mockReturnValue({ ...state(), callType: "video" } as never);
  await act(async () => root.render(<CallBubble />));
  const video = container.querySelector("video")!;
  expect(video.muted).toBe(true);
  expect(video.srcObject).toBe(remote);
  expect(video.autoplay).toBe(true);
  expect(video.playsInline).toBe(true);
  expect(play).toHaveBeenCalledOnce();
  expect(play.mock.contexts).toContain(video);
  expect(container.querySelector("audio")).toBeNull();
});
it("offers independent mute and end controls with accessible state", async () => {
  vi.mocked(useCall).mockReturnValue({ ...state(), isMuted: true } as never);
  await act(async () => root.render(<CallBubble />));
  const microphone = getByRole(container, "button", { name: "Unmute microphone" });
  expect(microphone.getAttribute("aria-pressed")).toBe("true");
  await act(async () => microphone.click());
  await act(async () => getByRole(container, "button", { name: "End call" }).click());
  expect(mute).toHaveBeenCalledOnce();
  expect(end).toHaveBeenCalledOnce();
  expect(restore).not.toHaveBeenCalled();
});


it("attaches and plays a remote stream that arrives after the video bubble mounts", async () => {
  vi.mocked(useCall).mockReturnValue({ ...state(), callType: "video", remoteEntries: [] } as never);
  await act(async () => root.render(<CallBubble />));
  const video = container.querySelector("video")!;
  expect(video.srcObject).toBeNull();
  expect(play).not.toHaveBeenCalled();
  vi.mocked(useCall).mockReturnValue({ ...state(), callType: "video" } as never);
  await act(async () => root.render(<CallBubble />));
  expect(container.querySelector("video")).toBe(video);
  expect(video.srcObject).toBe(remote);
  expect(video.muted && video.playsInline && video.autoplay).toBe(true);
  expect(play).toHaveBeenCalledOnce();
  await act(async () => remote.dispatchEvent(new Event("addtrack")));
  expect(play).toHaveBeenCalledTimes(2);
});

it("retries playback on loaded metadata after an initial play rejection", async () => {
  play.mockRejectedValueOnce(new DOMException("Media not ready", "AbortError"));
  vi.mocked(useCall).mockReturnValue({ ...state(), callType: "video" } as never);
  await act(async () => root.render(<CallBubble />));
  const video = container.querySelector("video")!;
  await act(async () => video.dispatchEvent(new Event("loadedmetadata")));
  expect(play).toHaveBeenCalledTimes(2);
  expect(video.srcObject).toBe(remote);
});
