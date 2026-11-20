import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getByRole, queryByRole } from "@testing-library/dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCall } from "../../features/calls/useCall.js";
import CallBubble from "./CallBubble.js";
import { CallPlaybackProvider } from "../../features/calls/CallPlaybackContext.js";

vi.mock("../../features/calls/useCall.js", () => ({ useCall: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
const restore = vi.fn();
const end = vi.fn();
const mute = vi.fn();
const cameraOff = vi.fn();
const stopSharing = vi.fn();
const remote = new EventTarget() as MediaStream;
let play: ReturnType<typeof vi.spyOn>;
const state = () => ({ callType: "audio", conversationName: "Chat alias", callerAvatarUrl: "/caller.png", peerName: "Mara", peerAvatarUrl: null, isGroupCall: false, callDuration: 192,
  formatDuration: () => "03:12", remoteEntries: [["remote", remote]], isMuted: false,
  isVideoOff: false, isSharingScreen: false, restoreCall: restore, handleEnd: end, toggleMute: mute,
  handleToggleVideo: cameraOff, toggleScreenShare: stopSharing });
const render = () => act(async () => root.render(<CallPlaybackProvider><CallBubble /></CallPlaybackProvider>));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.mocked(useCall).mockReturnValue(state() as never);
  container = document.createElement("div"); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("renders the voice avatar, tabular duration and complete accessible return name", async () => {
  await render();
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
  await render();
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
  await render();
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
  await render();
  const video = container.querySelector("video")!;
  expect(video.srcObject).toBeNull();
  expect(play).not.toHaveBeenCalled();
  vi.mocked(useCall).mockReturnValue({ ...state(), callType: "video" } as never);
  await render();
  expect(container.querySelector("video")).toBe(video);
  expect(video.srcObject).toBe(remote);
  expect(video.muted && video.playsInline && video.autoplay).toBe(true);
  expect(play).toHaveBeenCalledOnce();
  await act(async () => remote.dispatchEvent(new Event("addtrack")));
  expect(play).toHaveBeenCalledTimes(2);
});

it("offers video recovery without expanding the bubble or retrying automatically", async () => {
  play.mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError"));
  vi.mocked(useCall).mockReturnValue({ ...state(), callType: "video" } as never);
  await render();
  const video = container.querySelector("video")!;
  const recovery = getByRole(container, "button", { name: "Tap to play" });
  expect(recovery.tabIndex).toBe(0);
  expect(recovery.querySelector('[data-icon="play"]')).not.toBeNull();
  expect(recovery.textContent).toBe("");
  expect(container.querySelectorAll("[data-call-playback-recovery]")).toHaveLength(1);
  expect(recovery.closest('[aria-label^="Ongoing call"]')).toBeNull();
  await act(async () => video.dispatchEvent(new Event("loadedmetadata")));
  await act(async () => remote.dispatchEvent(new Event("addtrack")));
  expect(play).toHaveBeenCalledOnce();
  await act(async () => recovery.click());
  expect(play).toHaveBeenCalledTimes(2);
  expect(queryByRole(container, "button", { name: "Tap to play" })).toBeNull();
  expect(video.srcObject).toBe(remote);
  expect(restore).not.toHaveBeenCalled();
});

it("wraps 44px actions in a zoomed bubble with End call before recovery and mute", async () => {
  vi.stubGlobal("innerWidth", 360);
  vi.stubGlobal("innerHeight", 640);
  vi.stubGlobal("visualViewport", Object.assign(new EventTarget(), {
    width: 90, height: 160, offsetLeft: 0, offsetTop: 0,
  }));
  // jsdom does not calculate layout. These bounds represent the 4× visual viewport minus the 16px gutters.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(16, 16, 58, 128));
  play.mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError"));
  vi.mocked(useCall).mockReturnValue({ ...state(), callType: "video", isSharingScreen: true, videoBusy: true } as never);
  await render();

  const actions = container.querySelector<HTMLElement>(".call-bubble-actions")!;
  const endCall = getByRole(actions, "button", { name: "End call" });
  const recovery = getByRole(actions, "button", { name: "Tap to play" });
  const microphone = getByRole(actions, "button", { name: "Mute microphone" });
  const turnOffCamera = getByRole(actions, "button", { name: "Turn off camera" });
  const stopDisplay = getByRole(actions, "button", { name: "Stop sharing screen" });
  expect(actions.closest(".call-bubble")?.parentElement?.style.width).toBe("58px");
  expect([...actions.children]).toEqual([endCall, recovery, microphone, turnOffCamera, stopDisplay]);
  expect([...actions.classList]).toEqual(expect.arrayContaining(["flex-wrap", "content-start", "overflow-y-auto", "gap-2", "p-1"]));
  for (const button of [endCall, recovery, microphone, turnOffCamera, stopDisplay]) {
    expect(button.tabIndex).toBe(0);
    expect(button.classList.contains("size-11")).toBe(true);
  }
  await act(async () => endCall.click());
  expect(end).toHaveBeenCalledOnce();
  await act(async () => recovery.click());
  expect(play).toHaveBeenCalledTimes(2);
  await act(async () => turnOffCamera.click());
  await act(async () => stopDisplay.click());
  expect(cameraOff).toHaveBeenCalledOnce();
  expect(stopSharing).toHaveBeenCalledOnce();
  expect(restore).not.toHaveBeenCalled();
});
