import { useEffect, useSyncExternalStore } from "react";

/**
 * Full-window call surfaces (the group call screen, the phone-sized incoming call) cover the app.
 * While any is shown, the app underneath must be inert so focus and screen readers stay on the visible surface.
 */
let count = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function useObscuringSurface(active: boolean) {
  useEffect(() => {
    if (!active) return;
    count += 1; emit();
    // Remember where focus was, and restore it when the surface goes away (if that element still exists).
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      count -= 1; emit();
      requestAnimationFrame(() => { if (previous?.isConnected && !document.querySelector("[data-obscuring-surface]")) previous.focus(); });
    };
  }, [active]);
}

export function useAppObscured() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => count > 0,
    () => false,
  );
}
