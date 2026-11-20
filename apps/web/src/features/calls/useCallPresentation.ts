import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

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
  const pointer = useRef<{ id: number; x: number; y: number; tile: DOMRect; bounds: DOMRect } | null>(null);
  const dragged = useRef(false);
  const movePreview = (x: number, y: number, bounds?: DOMRect) => {
    setCorner(`${y < (bounds ? bounds.top + bounds.height / 2 : window.innerHeight / 2) ? "top" : "bottom"}-${x < (bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2) ? "start" : "end"}`);
  };
  const cycleCorner = () => setCorner((current) => {
    const corners = ["bottom-end", "bottom-start", "top-start", "top-end"] as const;
    return corners[(corners.indexOf(current) + 1) % corners.length];
  });
  const finishDrag = (element: HTMLButtonElement) => {
    pointer.current = null;
    element.style.translate = "";
  };
  const previewControls = {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      const tile = event.currentTarget;
      const bounds = tile.parentElement?.getBoundingClientRect();
      if (event.button !== 0 || pointer.current || !bounds) return;
      dragged.current = false;
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, tile: tile.getBoundingClientRect(), bounds };
      tile.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const origin = pointer.current;
      if (origin?.id !== event.pointerId) return;
      const x = Math.max(origin.bounds.left - origin.tile.left, Math.min(event.clientX - origin.x, origin.bounds.right - origin.tile.right));
      const y = Math.max(origin.bounds.top - origin.tile.top, Math.min(event.clientY - origin.y, origin.bounds.bottom - origin.tile.bottom));
      event.currentTarget.style.translate = `${x}px ${y}px`;
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      const origin = pointer.current;
      if (origin?.id !== event.pointerId) return;
      finishDrag(event.currentTarget);
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 8) return;
      dragged.current = true;
      movePreview(event.clientX, event.clientY, origin.bounds);
      showControls();
    },
    onLostPointerCapture(event: PointerEvent<HTMLButtonElement>) { finishDrag(event.currentTarget); },
    onPointerCancel(event: PointerEvent<HTMLButtonElement>) { finishDrag(event.currentTarget); },
    onClick(event: { detail: number }) {
      if (!dragged.current || event.detail === 0) cycleCorner();
      dragged.current = false;
      showControls();
    },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      const [vertical, horizontal] = corner.split("-");
      switch (event.key) {
        case "ArrowUp": setCorner(`top-${horizontal as "start" | "end"}`); break;
        case "ArrowDown": setCorner(`bottom-${horizontal as "start" | "end"}`); break;
        case "ArrowLeft": setCorner(`${vertical as "top" | "bottom"}-start`); break;
        case "ArrowRight": setCorner(`${vertical as "top" | "bottom"}-end`); break;
        default: return;
      }
      event.preventDefault();
    },
  };
  return { controlsVisible, showControls, corner, movePreview, cycleCorner, previewControls };
}
