import { useEffect, useRef, useState } from "react";

/** Only view state: idle controls and the local video's corner. */
export function useCallPresentation(video: boolean, connected: boolean) {
  const [controlsVisible, setControlsVisible] = useState(true);
  const [corner, setCorner] = useState<"top-start" | "top-end" | "bottom-start" | "bottom-end">("bottom-end");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showControls = () => {
    setControlsVisible(true);
    if (timer.current) clearTimeout(timer.current);
    if (video && connected && window.matchMedia?.("(max-width: 639px) and (pointer: coarse)").matches) {
      timer.current = setTimeout(() => setControlsVisible(false), 4000);
    }
  };
  useEffect(() => {
    showControls();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [video, connected]);
  const movePreview = (x: number, y: number) => setCorner(`${y < window.innerHeight / 2 ? "top" : "bottom"}-${x < window.innerWidth / 2 ? "start" : "end"}`);
  const cycleCorner = () => setCorner((current) => {
    const corners = ["bottom-end", "bottom-start", "top-start", "top-end"] as const;
    return corners[(corners.indexOf(current) + 1) % corners.length];
  });
  return { controlsVisible, showControls, corner, movePreview, cycleCorner };
}
