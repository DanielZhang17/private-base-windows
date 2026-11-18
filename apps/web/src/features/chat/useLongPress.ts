import { useCallback, useLayoutEffect, useRef, type MouseEvent, type PointerEvent } from "react";

const HOLD_MS = 500;
const TOLERANCE = 8;

export function useLongPress(menuOpen: boolean) {
  const press = useRef<{ id: number; x: number; y: number; timer?: ReturnType<typeof setTimeout>; onEnd?: () => void } | null>(null);
  const openingTouch = useRef(false);
  const suppressMouseUntil = useRef(0);
  const guarded = () => openingTouch.current || Date.now() < suppressMouseUntil.current;

  const cancel = useCallback(() => {
    const current = press.current;
    if (!current) return;
    press.current = null;
    clearTimeout(current.timer);
    current.onEnd?.();
    window.removeEventListener("scroll", cancel, true);
  }, []);
  useLayoutEffect(() => cancel, [cancel]);

  useLayoutEffect(() => {
    if (!menuOpen || !openingTouch.current) return;
    // A phone sheet can replace the original target before the finger lifts.
    // Capture release and its compatibility mouse events, including on the scrim.
    const stop = (event: Event) => {
      if (!guarded()) return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    const release = (event: Event) => {
      if (!guarded()) return;
      stop(event);
      openingTouch.current = false;
      suppressMouseUntil.current = Date.now() + 400;
      cancel();
    };
    const reset = () => {
      openingTouch.current = false;
      suppressMouseUntil.current = 0;
    };
    document.addEventListener("pointerup", release, true);
    document.addEventListener("touchend", release, { capture: true, passive: false });
    for (const type of ["mousedown", "mouseup", "click", "contextmenu"]) document.addEventListener(type, stop, true);
    for (const type of ["pointerdown", "touchstart", "keydown"]) document.addEventListener(type, reset, true);
    return () => {
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("touchend", release, true);
      for (const type of ["mousedown", "mouseup", "click", "contextmenu"]) document.removeEventListener(type, stop, true);
      for (const type of ["pointerdown", "touchstart", "keydown"]) document.removeEventListener(type, reset, true);
    };
  }, [menuOpen]);

  const begin = (event: PointerEvent, onHold?: () => void, onEnd?: () => void) => {
    cancel();
    openingTouch.current = false;
    suppressMouseUntil.current = 0;
    const { clientX: x, clientY: y, pointerId: id } = event;
    const timer = event.pointerType === "touch" && onHold ? setTimeout(() => {
      openingTouch.current = true;
      cancel();
      onHold();
      try { navigator.vibrate?.(10); } catch { /* Haptics are optional. */ }
    }, HOLD_MS) : undefined;
    press.current = { id, x, y, timer, onEnd };
    window.addEventListener("scroll", cancel, { capture: true, passive: true });
  };

  const matches = (event: PointerEvent) => {
    const start = press.current;
    return !!start && start.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) < TOLERANCE;
  };

  return {
    begin, cancel,
    move(event: PointerEvent) { if (!matches(event)) cancel(); },
    release(event: PointerEvent) {
      const valid = matches(event) && !guarded();
      cancel();
      return valid;
    },
    contextMenu(touch = false) {
      if (guarded()) return false;
      openingTouch.current = touch || press.current?.timer !== undefined;
      cancel();
      return true;
    },
    captureClick(event: MouseEvent) {
      if (guarded()) { event.preventDefault(); event.stopPropagation(); }
    },
  };
}
