import { useEffect, useRef } from "react";

export function useMediaElement<T extends HTMLMediaElement>(stream: MediaStream | null) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) element.srcObject = stream;
    return () => { if (element) element.srcObject = null; };
  }, [stream]);
  return ref;
}
