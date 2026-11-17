import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getByRole, queryByRole } from "@testing-library/dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VideoGrid from "./VideoGrid.js";
import CallPlaybackRecovery from "./CallPlaybackRecovery.js";
import { CallPlaybackProvider } from "../../features/calls/CallPlaybackContext.js";
import { useMediaElement } from "../../features/calls/useMediaElement.js";

let root: Root;
let container: HTMLDivElement;
let stream: MediaStream;
let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  stream = new EventTarget() as MediaStream;
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<CallPlaybackProvider>
  <VideoGrid streams={new Map([["remote", stream]])} />
  <CallPlaybackRecovery />
</CallPlaybackProvider>));

it("explicitly plays the assigned remote video while leaving audio to the persistent owner", async () => {
  await render();
  const video = container.querySelector("video")!;
  expect(video.srcObject).toBe(stream);
  expect(video.muted && video.autoplay && video.playsInline).toBe(true);
  expect(play).toHaveBeenCalledOnce();
  expect(play.mock.contexts[0]).toBe(video);
  expect(container.querySelector("audio")).toBeNull();
});

it("waits for an accessible user gesture after rejection, including a failed recovery", async () => {
  play.mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError"));
  await render();
  const video = container.querySelector("video")!;
  const recovery = getByRole(container, "button", { name: "Tap to play" });
  expect(recovery.tabIndex).toBe(0);
  await act(async () => {
    video.dispatchEvent(new Event("loadedmetadata"));
    stream.dispatchEvent(new Event("addtrack"));
  });
  await render();
  expect(play).toHaveBeenCalledOnce();
  play.mockRejectedValueOnce(new Error("Still blocked"));
  await act(async () => recovery.click());
  expect(play).toHaveBeenCalledTimes(2);
  expect(getByRole(container, "button", { name: "Tap to play" })).toBe(recovery);
  await act(async () => video.dispatchEvent(new Event("loadedmetadata")));
  expect(play).toHaveBeenCalledTimes(2);
  await act(async () => recovery.click());
  expect(play).toHaveBeenCalledTimes(3);
  expect(queryByRole(container, "button", { name: "Tap to play" })).toBeNull();
});

it("ignores a stale playback rejection and detaches streams and listeners on replacement/unmount", async () => {
  let reject!: (reason: Error) => void;
  play.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
  await render();
  const video = container.querySelector("video")!;
  const oldStream = stream;
  await act(async () => {
    video.dispatchEvent(new Event("loadedmetadata"));
    stream.dispatchEvent(new Event("addtrack"));
  });
  expect(play).toHaveBeenCalledOnce();
  stream = new EventTarget() as MediaStream;
  await render();
  expect(video.srcObject).toBe(stream);
  await act(async () => reject(new Error("Old stream blocked")));
  expect(queryByRole(container, "button", { name: "Tap to play" })).toBeNull();
  await act(async () => oldStream.dispatchEvent(new Event("addtrack")));
  expect(play).toHaveBeenCalledTimes(2);
  await act(async () => root.render(null));
  expect(video.srcObject).toBeNull();
  await act(async () => {
    video.dispatchEvent(new Event("loadedmetadata"));
    stream.dispatchEvent(new Event("addtrack"));
  });
  expect(play).toHaveBeenCalledTimes(2);
});

function RemoteAudio() {
  const { ref } = useMediaElement<HTMLAudioElement>(stream, true);
  return <audio ref={ref} autoPlay />;
}

it("uses one gesture for the persistent audio owner and every blocked remote video", async () => {
  let gesture = false;
  play.mockImplementation(() => gesture ? Promise.resolve() : Promise.reject(new DOMException("Gesture required", "NotAllowedError")));
  await act(async () => root.render(<CallPlaybackProvider>
    <RemoteAudio />
    <VideoGrid streams={new Map([["one", stream], ["two", new EventTarget() as MediaStream]])} />
    <CallPlaybackRecovery />
  </CallPlaybackProvider>));
  const media = [...container.querySelectorAll("audio, video")];
  expect(media).toHaveLength(3);
  expect(play).toHaveBeenCalledTimes(3);
  const recovery = getByRole(container, "button", { name: "Tap to play" });
  expect(container.querySelectorAll("button")).toHaveLength(1);
  await act(async () => {
    gesture = true;
    recovery.click();
    recovery.click(); // A second click while play promises are pending must not double-play.
    gesture = false;
    expect(play.mock.contexts.slice(3)).toHaveLength(3);
    expect(new Set(play.mock.contexts.slice(3))).toEqual(new Set(media));
  });
  expect(container.querySelector("button")).toBeNull();
});

it("clears on playing even with a pending recovery promise and ignores its later rejection", async () => {
  play.mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError"));
  await render();
  let reject!: (error: Error) => void;
  play.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
  await act(async () => getByRole(container, "button", { name: "Tap to play" }).click());
  await act(async () => container.querySelector("video")!.dispatchEvent(new Event("playing")));
  expect(container.querySelector("button")).toBeNull();
  await act(async () => reject(new Error("Stale play failure")));
  expect(container.querySelector("button")).toBeNull();
  expect(play).toHaveBeenCalledTimes(2);
});

it("changes to the sound-only control after video starts and removes blocked entries on unmount", async () => {
  play.mockRejectedValue(new DOMException("Gesture required", "NotAllowedError"));
  await act(async () => root.render(<CallPlaybackProvider>
    <RemoteAudio /><VideoGrid streams={new Map([["remote", stream]])} /><CallPlaybackRecovery />
  </CallPlaybackProvider>));
  expect(getByRole(container, "button", { name: "Tap to play" })).toBeDefined();
  await act(async () => container.querySelector("video")!.dispatchEvent(new Event("playing")));
  const sound = getByRole(container, "button", { name: "Tap to turn on sound" });
  expect(sound.querySelector('[data-icon="speaker"]')).not.toBeNull();
  expect(container.querySelectorAll("button")).toHaveLength(1);
  await act(async () => root.render(<CallPlaybackProvider><CallPlaybackRecovery /></CallPlaybackProvider>));
  expect(container.querySelector("button")).toBeNull();
  expect(play).toHaveBeenCalledTimes(2);
});
