import { useEffect, useRef } from "react";
import { useAuthStore } from "../../stores/authStore.js";
import { getUnlockGeneration, keysLoaded, runPostUnlockKeyMaintenance } from "../../lib/key-manager.js";

/** Delay before each retry of a failed run; the last one repeats until a run succeeds. */
export const KEY_MAINTENANCE_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 5 * 60_000];

/**
 * Runs post-unlock key maintenance (publish the pre-key bundle, top up one-time pre-keys) once
 * per unlock of THIS tab, and keeps retrying with backoff while it fails and the app stays
 * unlocked. Coming back online or back to the tab retries immediately.
 *
 * A run is identified by the login (`sessionId`), the device and this tab's unlock generation.
 * `authEpoch` is deliberately not part of it: it is persisted and bumped by every tab (e.g. on
 * idle lock), so it would re-run maintenance in all open tabs whenever any one of them locks.
 */
export function useKeyMaintenance(unlocked: boolean): void {
  const sessionId = useAuthStore((state) => state.sessionId);
  const deviceId = useAuthStore((state) => state.device?.id);
  const completedRun = useRef<string | null>(null);

  useEffect(() => {
    if (!unlocked || !deviceId || !keysLoaded() || !useAuthStore.getState().accessToken) return;
    const runId = `${sessionId}:${deviceId}:${getUnlockGeneration()}`;
    if (completedRun.current === runId) return;

    let cancelled = false;
    let running = false;
    let failures = 0;
    let retryTimer: number | null = null;

    const run = async () => {
      if (cancelled || running || completedRun.current === runId) return;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      running = true;
      try {
        await runPostUnlockKeyMaintenance();
        completedRun.current = runId;
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to maintain device keys", error);
        const delay = KEY_MAINTENANCE_RETRY_DELAYS_MS[Math.min(failures, KEY_MAINTENANCE_RETRY_DELAYS_MS.length - 1)];
        failures++;
        retryTimer = window.setTimeout(() => void run(), delay);
      } finally {
        running = false;
      }
    };
    const retryNow = () => void run();
    const retryWhenVisible = () => {
      if (document.visibilityState === "visible") void run();
    };

    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", retryWhenVisible);
    void run();

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", retryWhenVisible);
    };
  }, [unlocked, sessionId, deviceId]);
}
