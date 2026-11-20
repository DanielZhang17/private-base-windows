/**
 * Every camera, microphone and screen track the app acquires goes through these helpers, so
 * ending a session can release the devices even for tracks no store or stream references any
 * more (for example the camera track parked aside while the screen is shared).
 */
const capturedTracks = new Set<MediaStreamTrack>();

function register(stream: MediaStream): MediaStream {
  for (const track of capturedTracks) {
    if (track.readyState === "ended") capturedTracks.delete(track);
  }
  for (const track of stream.getTracks()) capturedTracks.add(track);
  return stream;
}

export async function captureUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return register(await navigator.mediaDevices.getUserMedia(constraints));
}

export interface CallCamera {
  id: string;
  label: string;
  facingMode?: "user" | "environment";
}

export const callCameraConstraints: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

export async function listCallCameras(track?: MediaStreamTrack | null): Promise<CallCamera[]> {
  const devices = await navigator.mediaDevices?.enumerateDevices?.() ?? [];
  const cameras = new Map(devices.filter((device) => device.kind === "videoinput" && device.deviceId)
    .map(({ deviceId, label }) => [deviceId, { id: deviceId, label }]));
  const facing = track?.getSettings?.().facingMode;
  if (cameras.size < 2 && (facing === "user" || facing === "environment")) {
    // Some mobile WebViews expose only the active camera ID.
    return [
      { id: "facing:user", label: "", facingMode: "user" },
      { id: "facing:environment", label: "", facingMode: "environment" },
    ];
  }
  return [...cameras.values()];
}

export function captureCallCamera(camera?: CallCamera): Promise<MediaStream> {
  return captureUserMedia({
    audio: false,
    video: {
      ...callCameraConstraints,
      ...(camera?.facingMode ? { facingMode: { exact: camera.facingMode } }
        : camera ? { deviceId: { exact: camera.id } } : {}),
    },
  });
}

export function watchCallCameras(onChange: () => void): () => void {
  const devices = navigator.mediaDevices;
  devices?.addEventListener?.("devicechange", onChange);
  return () => devices?.removeEventListener?.("devicechange", onChange);
}

export async function captureDisplayMedia(constraints?: DisplayMediaStreamOptions): Promise<MediaStream> {
  return register(await navigator.mediaDevices.getDisplayMedia(constraints));
}

/** Stop every track acquired through the helpers above. Stopping a track twice is harmless. */
export function stopAllCapturedTracks(): void {
  const tracks = [...capturedTracks];
  capturedTracks.clear();
  for (const track of tracks) {
    try {
      track.stop();
    } catch (error) {
      console.error("Failed to stop a captured track", error);
    }
  }
}
