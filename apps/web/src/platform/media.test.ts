import { afterEach, expect, it, vi } from "vitest";
import { captureCallCamera, listCallCameras, stopAllCapturedTracks, watchCallCameras } from "./media.js";

afterEach(() => { stopAllCapturedTracks(); vi.unstubAllGlobals(); });

it("lists unique camera IDs and requests only the exact selected video device", async () => {
  const stop = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
  vi.stubGlobal("navigator", { mediaDevices: {
    getUserMedia,
    enumerateDevices: async () => [
      { kind: "audioinput", deviceId: "mic" },
      { kind: "videoinput", deviceId: "" },
      { kind: "videoinput", deviceId: "one", label: "" },
      { kind: "videoinput", deviceId: "two", label: "USB" },
      { kind: "videoinput", deviceId: "two", label: "USB" },
    ],
  } });
  const cameras = await listCallCameras();
  expect(cameras).toEqual([{ id: "one", label: "" }, { id: "two", label: "USB" }]);
  await captureCallCamera(cameras[1]);
  expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: expect.objectContaining({ deviceId: { exact: "two" } }) });
  stopAllCapturedTracks();
  expect(stop).toHaveBeenCalledOnce();
});

it("supports facing-mode selection when a WebView exposes only the active camera", async () => {
  const denied = new DOMException("Denied", "NotAllowedError");
  const getUserMedia = vi.fn().mockRejectedValue(denied);
  vi.stubGlobal("navigator", { mediaDevices: {
    getUserMedia, enumerateDevices: async () => [{ kind: "videoinput", deviceId: "one", label: "" }],
  } });
  const frontTrack = { getSettings: () => ({ facingMode: "user" }) } as MediaStreamTrack;
  const cameras = await listCallCameras(frontTrack);
  expect(cameras.map((camera) => camera.facingMode)).toEqual(["user", "environment"]);
  await expect(captureCallCamera(cameras[1])).rejects.toBe(denied);
  expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: expect.objectContaining({ facingMode: { exact: "environment" } }) });
});

it("releases its device-change listener when the call ends", () => {
  const devices = new EventTarget();
  vi.stubGlobal("navigator", { mediaDevices: devices });
  const changed = vi.fn();
  const unsubscribe = watchCallCameras(changed);
  devices.dispatchEvent(new Event("devicechange"));
  unsubscribe();
  devices.dispatchEvent(new Event("devicechange"));
  expect(changed).toHaveBeenCalledOnce();
});
