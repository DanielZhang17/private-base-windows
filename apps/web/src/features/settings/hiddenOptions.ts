import { useSyncExternalStore } from "react";
import { capabilities } from "../../platform/capabilities.js";
import { isNative, platformName } from "../../platform/environment.js";
import { getCaptureProtection, setCaptureProtection } from "../../platform/capture-protection.js";
import { queryClient } from "../../lib/query-client.js";

/**
 * On Android the "block screenshots" switch is hidden and protection stays on. Tapping "Private Base" at the
 * bottom of Settings seven times reveals the switch on that device (like Android's developer options).
 * Other platforms keep the switch visible.
 */
const KEY = "pb.captureToggleUnlocked";
const listeners = new Set<() => void>();
let sessionUnlocked = false;

function read() {
  try { return window.localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function unlockCaptureToggle() {
  try { window.localStorage.setItem(KEY, "1"); } catch { /* storage unavailable: reveal for this session only */ }
  sessionUnlocked = true;
  listeners.forEach((listener) => listener());
}

export function useCaptureToggleUnlocked() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => sessionUnlocked || read(),
    () => false,
  );
}

/** True where the switch is hidden behind the tap gesture (the Android app). */
export function captureToggleGated() {
  return isNative() && platformName() === "android" && !!capabilities.captureProtection;
}

/** Whether the switch should be hidden right now. */
export function useCaptureToggleHidden() {
  const unlocked = useCaptureToggleUnlocked();
  return captureToggleGated() && !unlocked;
}

/**
 * While the switch is hidden, protection must be on before any chat is shown (an older build may have turned it
 * off). The check runs once per app session; chats stay covered until it settles. A failure or a slow native bridge
 * never leaves protection off silently: the cover asks the user to retry or to continue knowingly without it.
 */
export type CaptureGuardState = "pending" | "on" | "failed" | "bypassed";
export const CAPTURE_GUARD_TIMEOUT_MS = 3000;
let guard: CaptureGuardState = "pending";
let guardRun: Promise<void> | null = null;
const guardListeners = new Set<() => void>();
function setGuard(next: CaptureGuardState) { guard = next; guardListeners.forEach((listener) => listener()); }

export function ensureHiddenCaptureProtection(timeoutMs = CAPTURE_GUARD_TIMEOUT_MS): Promise<void> {
  if (guardRun) return guardRun;
  setGuard("pending");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("capture protection timed out")), timeoutMs); });
  const restore = (async () => {
    if (await getCaptureProtection() !== true) await setCaptureProtection(true);
    // Keep the Privacy switch (if revealed later) in step with the real state.
    queryClient.setQueryData(["capture-protection"], true);
  })();
  guardRun = Promise.race([restore, timeout])
    .then(() => setGuard("on"), () => setGuard("failed"))
    .finally(() => { clearTimeout(timer); guardRun = null; });
  return guardRun;
}

/** The user chose to see their chats although protection could not be confirmed (this session only). */
export function bypassCaptureGuard() { setGuard("bypassed"); }

export function useCaptureGuard() {
  return useSyncExternalStore(
    (listener) => { guardListeners.add(listener); return () => guardListeners.delete(listener); },
    () => guard,
    () => guard,
  );
}

/** Test-only: forget this session's check. */
export function resetCaptureGuardForTests() { guard = "pending"; guardRun = null; sessionUnlocked = false; }

/** Counts taps on the Settings footer; seven quick taps reveal the switch. Returns a tap handler. */
export function createSecretTapCounter(onUnlock: () => void, needed = 7, windowMs = 3000) {
  let taps: number[] = [];
  return () => {
    const now = Date.now();
    taps = [...taps.filter((at) => now - at < windowMs), now];
    if (taps.length >= needed) { taps = []; onUnlock(); }
  };
}
