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
