import type { UnlockMethod } from "../../lib/device-key-vault.js";
import { capabilities } from "../../platform/capabilities.js";
import { canEnrollNativeUnlock, canProbeNativeUnlock } from "../../platform/biometric-unlock.js";

export function unlockOfferFor(deviceId: string): "new" | "restore" | null {
  try {
    const pending = sessionStorage.getItem(`unlock-offer:${deviceId}`);
    return pending === "new" || pending === "restore" ? pending : null;
  } catch { return null; }
}

export function markUnlockOffer(deviceId: string, methods: UnlockMethod[], invalidated: boolean) {
  if (!invalidated && (!(capabilities.passkeys || canEnrollNativeUnlock() || canProbeNativeUnlock()) ||
    methods.includes("passkey") || methods.includes("native"))) return;
  try {
    if (invalidated || !localStorage.getItem(`unlock-offer-seen:${deviceId}`)) {
      sessionStorage.setItem(`unlock-offer:${deviceId}`, invalidated ? "restore" : "new");
    }
  } catch { /* Optional offer. */ }
}

export function dismissUnlockOffer(deviceId: string) {
  try {
    sessionStorage.removeItem(`unlock-offer:${deviceId}`);
    localStorage.setItem(`unlock-offer-seen:${deviceId}`, "1");
  } catch { /* Optional offer. */ }
}
