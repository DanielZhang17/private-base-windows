import { useEffect, useRef } from "react";
import { useCallPlayback } from "./CallPlaybackContext.js";

export function useMediaElement<T extends HTMLMediaElement>(stream: MediaStream | null, play = false) {
  const ref = useRef<T>(null);
  const updateBlocked = useCallPlayback()?.updateBlocked;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let cancelled = false;
    let pending = false;
    let blocked = false;
    let playing = false;
    const clearBlocked = () => { blocked = false; updateBlocked?.(element, null); };
    const onPlaying = () => { playing = true; clearBlocked(); };
    element.srcObject = stream;
    const start = async (interaction = false) => {
      if (cancelled || pending || (blocked && !interaction) || !play || !stream || element.srcObject !== stream) return;
      pending = true;
      playing = false;
      try {
        // Call synchronously in the click handler to retain browser user activation.
        await element.play();
        if (!cancelled) clearBlocked();
      } catch {
        if (!cancelled && !playing) { blocked = true; updateBlocked?.(element, resume); }
      } finally { pending = false; }
    };
    const resume = () => { if (blocked) void start(true); };
    const ready = () => { void start(); };
    if (play && stream) {
      element.addEventListener("loadedmetadata", ready);
      element.addEventListener("playing", onPlaying);
      stream.addEventListener?.("addtrack", ready);
    }
    ready();
    return () => {
      cancelled = true;
      clearBlocked();
      element.removeEventListener("loadedmetadata", ready);
      element.removeEventListener("playing", onPlaying);
      stream?.removeEventListener?.("addtrack", ready);
      element.srcObject = null;
    };
  }, [stream, play, updateBlocked]);
  return { ref };
}
