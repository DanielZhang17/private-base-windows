import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { clampZoom, classifyTap, distance, DOUBLE_TAP_MS, fitMedia, INITIAL_ZOOM, midpoint, TAP_SLOP, zoomAt, type Point, type Size, type Tap, type Zoom } from "./media-gestures.js";

export function useMediaGestures(onClose: () => void) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const media = fitMedia(natural, viewport);
  const [zoom, setZoom] = useState(INITIAL_ZOOM);
  const current = useRef(zoom);
  const [swipe, setSwipe] = useState(0);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef({ start: { x: 0, y: 0 }, time: 0, movement: 0, pinched: false, swipe: 0 });
  const previousTap = useRef<Tap | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  function update(next: Zoom) { current.current = next; setZoom(next); }
  function cancelTap() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }
  function interruptTap() { cancelTap(); previousTap.current = null; }
  const focal = (point: Point): Point => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: point.x - rect.left - rect.width / 2, y: point.y - rect.top - rect.height / 2 };
  };

  useEffect(() => {
    const stage = stageRef.current!;
    const resize = () => {
      const rect = stage.getBoundingClientRect();
      setViewport({ width: rect.width, height: rect.height });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    return () => { observer.disconnect(); cancelTap(); };
  }, []);

  useEffect(() => {
    update(clampZoom(current.current, media, viewport));
  }, [media.width, media.height, viewport.width, viewport.height]);

  // A native listener is needed: React's delegated wheel listener is passive.
  useEffect(() => {
    const stage = stageRef.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      interruptTap();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1);
      update(zoomAt(current.current, current.current.scale * Math.exp(-delta * 0.002), focal({ x: event.clientX, y: event.clientY }), media, viewport));
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, [media.width, media.height, viewport.width, viewport.height]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const point = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = { start: point, time: Date.now(), movement: 0, pinched: false, swipe: 0 };
      setDragging(true);
      // A second tap may be held or dragged; the first must not close underneath it.
      cancelTap();
    } else {
      gesture.current.pinched = true;
      interruptTap();
      gesture.current.swipe = 0;
      setSwipe(0);
    }
    pointers.current.set(event.pointerId, point);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const before = pointers.current.get(event.pointerId);
    if (!before) return;
    const point = { x: event.clientX, y: event.clientY };
    const oldPoints = [...pointers.current.values()];
    pointers.current.set(event.pointerId, point);
    const points = [...pointers.current.values()];
    gesture.current.movement = Math.max(gesture.current.movement, distance(point, gesture.current.start));
    if (gesture.current.movement > TAP_SLOP) interruptTap();
    if (points.length === 2) {
      const oldMid = midpoint(oldPoints[0], oldPoints[1]);
      const mid = midpoint(points[0], points[1]);
      const oldDistance = distance(oldPoints[0], oldPoints[1]);
      if (oldDistance > 0) {
        const next = zoomAt(current.current, current.current.scale * distance(points[0], points[1]) / oldDistance, focal(oldMid), media, viewport);
        update(clampZoom({ ...next, x: next.x + mid.x - oldMid.x, y: next.y + mid.y - oldMid.y }, media, viewport));
      }
    } else if (points.length === 1 && current.current.scale > 1) {
      update(clampZoom({ ...current.current, x: current.current.x + point.x - before.x, y: current.current.y + point.y - before.y }, media, viewport));
    } else if (!gesture.current.pinched && event.pointerType === "touch" && window.matchMedia("(max-width: 639px)").matches) {
      const dx = point.x - gesture.current.start.x;
      const dy = point.y - gesture.current.start.y;
      gesture.current.swipe = dy > Math.abs(dx) ? dy : 0;
      setSwipe(gesture.current.swipe);
    }
  }

  function finish(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (cancelled) { gesture.current.pinched = true; interruptTap(); }
    if (pointers.current.size) return;
    setDragging(false);
    const state = gesture.current;
    setSwipe(0);
    if (!cancelled && !state.pinched && state.swipe >= Math.min(120, viewport.height * 0.2)) {
      interruptTap();
      closeRef.current();
      return;
    }
    const tap: Tap = { x: event.clientX, y: event.clientY, time: Date.now(), scale: current.current.scale };
    const movement = Math.max(state.movement, distance(tap, state.start));
    const kind = classifyTap(tap, previousTap.current, movement, tap.time - state.time, state.pinched);
    if (kind === "none") return;
    cancelTap();
    if (kind === "double") {
      update(previousTap.current!.scale > 1 ? INITIAL_ZOOM : zoomAt(current.current, 2.5, focal(tap), media, viewport));
      previousTap.current = null;
    } else {
      previousTap.current = tap;
      if (tap.scale > 1) update(INITIAL_ZOOM);
      else timer.current = setTimeout(() => { timer.current = null; previousTap.current = null; closeRef.current(); }, DOUBLE_TAP_MS);
    }
  }

  return {
    stageRef, media, zoom, swipe, dragging, setNatural,
    toggleZoom: () => { interruptTap(); update(current.current.scale > 1 ? INITIAL_ZOOM : zoomAt(current.current, 2.5, { x: 0, y: 0 }, media, viewport)); },
    pointerHandlers: { onPointerDown, onPointerMove, onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => finish(event), onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => finish(event, true), onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => finish(event, true) },
  };
}
