import { useState } from "react";

/** "Earlier messages stay on your other devices" can be closed; remembered per linked device in this browser. */
const key = (deviceId: string) => `pb.historyGuidanceDismissed:${deviceId}`;

function stored(deviceId: string) {
  try { return window.localStorage.getItem(key(deviceId)) === "1"; } catch { return false; }
}

export function useHistoryGuidanceDismissal(deviceId: string | undefined) {
  // Covers storage that is unavailable (private mode): the notice stays closed for this session.
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const dismissed = !!deviceId && (closed.has(deviceId) || stored(deviceId));
  const dismiss = () => {
    if (!deviceId) return;
    setClosed((current) => new Set(current).add(deviceId));
    try { window.localStorage.setItem(key(deviceId), "1"); } catch { /* session only */ }
  };
  return { dismissed, dismiss };
}
