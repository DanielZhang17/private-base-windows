import { useEffect, useRef } from "react";

export function useMediaElement<T extends HTMLMediaElement>(stream: MediaStream | null, play = false) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    const start = () => {
      if (!play || !stream || element.srcObject !== stream) return;
      try { void element.play()?.catch(() => undefined); } catch { /* Playback may be unavailable in a WebView. */ }
    };
    start();
    if (play && stream) {
      element.addEventListener("loadedmetadata", start);
      stream.addEventListener?.("addtrack", start);
    }
    return () => {
      element.removeEventListener("loadedmetadata", start);
      stream?.removeEventListener?.("addtrack", start);
      element.srcObject = null;
    };
  }, [stream, play]);
  return ref;
}
