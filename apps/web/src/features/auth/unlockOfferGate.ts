import { useEffect, useSyncExternalStore } from "react";

/**
 * The unlock offer is a modal, so it must never compete with something that needs the user's attention.
 * Security alerts, setup receipts, transfer progress and setup guidance hold it while they are shown;
 * the offer only opens on the chat list or a chat after the user has been at rest for a moment.
 */
export const UNLOCK_OFFER_IDLE_MS = 1500;

let holds = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Keeps the unlock offer closed while `active` (e.g. a security alert or setup step is on screen). */
export function useHoldUnlockOffer(active: boolean) {
  useEffect(() => {
    if (!active) return;
    holds += 1; emit();
    return () => { holds -= 1; emit(); };
  }, [active]);
}

export function useUnlockOfferHeld() {
  return useSyncExternalStore(subscribe, () => holds > 0, () => false);
}

/** The offer may open only on the chat list or inside a chat. */
export function unlockOfferRoute(pathname: string) {
  return pathname === "/" || pathname.startsWith("/chat/");
}
