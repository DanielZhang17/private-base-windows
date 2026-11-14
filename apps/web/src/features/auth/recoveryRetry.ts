export const RECOVERY_RETRY_KEY = "e2ee-recovery-retry";
export interface RecoveryRetry {
  linkRequestId: string;
  challengeNonce: string;
  mode: "recovery" | "approved_link";
  deviceName: string;
  expiresAt: number;
  username: string;
}
export function clearRecoveryRetry() {
  sessionStorage.removeItem(RECOVERY_RETRY_KEY);
}
export function readRecoveryRetry(): RecoveryRetry | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(RECOVERY_RETRY_KEY) ?? "null");
    if (value && ["linkRequestId", "challengeNonce", "deviceName", "username"].every((key) => typeof value[key] === "string" && value[key])
      && (value.mode === "recovery" || value.mode === "approved_link") && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now()) {
      return { linkRequestId: value.linkRequestId, challengeNonce: value.challengeNonce, mode: value.mode, deviceName: value.deviceName, expiresAt: value.expiresAt, username: value.username };
    }
    clearRecoveryRetry();
  } catch {
    // An unreadable/disabled session store cannot supply a retry.
  }
  return null;
}
export function saveRecoveryRetry(value: RecoveryRetry) {
  sessionStorage.setItem(RECOVERY_RETRY_KEY, JSON.stringify({ linkRequestId: value.linkRequestId, challengeNonce: value.challengeNonce, mode: value.mode, deviceName: value.deviceName, expiresAt: value.expiresAt, username: value.username }));
}
