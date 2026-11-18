import { useSyncExternalStore } from "react";
import type { UnlockMethod } from "../../lib/device-key-vault.js";
import { notifyUnlockMethodsChanged, subscribeToUnlockMethodChanges } from "../../lib/unlock-method-changes.js";
import { NativeBiometricError, type BiometricUnlock } from "../../platform/biometric-unlock.js";
import { capabilities } from "../../platform/capabilities.js";

let unsupportedEnrollment: BiometricUnlock | undefined;

export function useNativeEnrollmentUnsupported(native?: BiometricUnlock): boolean {
  return useSyncExternalStore(subscribeToUnlockMethodChanges, () => !!native && native === unsupportedEnrollment);
}

export function reportUnsupportedNativeEnrollment(native: BiometricUnlock | undefined, error: unknown): boolean {
  if (!native || !(error instanceof NativeBiometricError) || error.code !== "unsupported") return false;
  unsupportedEnrollment = native;
  notifyUnlockMethodsChanged();
  return true;
}

export function unlockOfferFor(deviceId: string): "new" | "restore" | null {
  try {
    const pending = sessionStorage.getItem(`unlock-offer:${deviceId}`);
    return pending === "new" || pending === "restore" ? pending : null;
  } catch { return null; }
}

export function markUnlockOffer(deviceId: string, methods: UnlockMethod[], invalidated: boolean) {
  if (!invalidated && (!(capabilities.passkeys || capabilities.biometricUnlock) || methods.includes("passkey") || methods.includes("native"))) return;
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
