import { fromBase64Url, toBase64Url } from "@e2ee-chat/crypto";
import { useSyncExternalStore } from "react";
import { getLocale } from "../i18n/index.js";
import { capabilities } from "./capabilities.js";
import { isNative, platformName } from "./environment.js";
import { assertNotAborted, withNativeDeadline } from "./native-wait.js";

export type BiometricUnlock = "touchid" | "faceid" | "windows-hello" | "android-biometric";

type BiometricFailureCode = "cancelled" | "lockout" | "invalidated" | "unsupported" | "unavailable" | "failed";

export class NativeBiometricError extends Error {
  constructor(readonly code: BiometricFailureCode) { super(code); this.name = "NativeBiometricError"; }
}

export function isUnlockPromptCancelled(error: unknown): boolean {
  return (error as Error | undefined)?.name === "NotAllowedError" ||
    (error instanceof NativeBiometricError && error.code === "cancelled");
}

const nativeFlags = () => typeof window === "undefined" ? undefined : window.__PRIVATEBASE_NATIVE_CAPABILITIES__;
type NativeFlags = ReturnType<typeof nativeFlags>;

export function canProbeNativeUnlock(): boolean {
  const flags = nativeFlags();
  return isNative() && (flags?.biometricUnlockProbe === true || flags?.androidBiometricProbe === true);
}

export function canRemoveNativeUnlock(): boolean {
  const flags = nativeFlags();
  return !!capabilities.biometricUnlock || canProbeNativeUnlock() ||
    (isNative() && (flags?.biometricUnlockRemove === true || flags?.biometricUnlockCleanup === true));
}

export function hasNativeWebLocks(): boolean {
  return typeof globalThis.navigator?.locks?.request === "function";
}

export function hasExclusiveNativeDocument(): boolean {
  const flags = nativeFlags();
  return isNative() && (flags?.biometricUnlockSingleDocument === true || flags?.androidBiometricProbe === true);
}

let probe: {
  flags: NativeFlags;
  inFlight?: Promise<void>;
  result?: BiometricUnlock | null;
  lastKind?: BiometricUnlock;
  fingerprint?: boolean;
  failed?: boolean;
} | undefined;
let unsupportedEnrollment: { flags: NativeFlags; kind: BiometricUnlock } | undefined;
let revision = 0;
const listeners = new Set<() => void>();

const currentProbe = () => probe?.flags === nativeFlags() ? probe : undefined;

function publishCapability() {
  revision++;
  for (const listener of listeners) listener();
}

function subscribeCapability(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function nativeUnlockStatus() {
  const current = currentProbe();
  const available = current?.result === undefined ? capabilities.biometricUnlock : current.result ?? undefined;
  const kind = available ?? current?.lastKind ?? capabilities.biometricUnlock;
  const unsupported = !!kind && unsupportedEnrollment?.flags === nativeFlags() && unsupportedEnrollment?.kind === kind;
  return { available, kind, unsupported, probePending: canProbeNativeUnlock() && current?.result === undefined, probeFailed: !!current?.failed };
}

export function useNativeUnlockStatus() {
  useSyncExternalStore(subscribeCapability, () => revision);
  return nativeUnlockStatus();
}

export function nativeUnlockLabel(): BiometricUnlock | undefined {
  const kind = nativeUnlockStatus().kind;
  if (kind) return kind;
  const hint = isNative() ? nativeFlags()?.biometricUnlockKind : undefined;
  if (hint === "touchid" || hint === "faceid" || hint === "windows-hello" || hint === "android-biometric") return hint;
  switch (platformName()) {
    case "macos": return "touchid";
    case "windows": return "windows-hello";
    case "android": return "android-biometric";
  }
  if (canProbeNativeUnlock() && nativeFlags()?.androidBiometricProbe) return "android-biometric";
}

export function nativeUnlockUsesFingerprint(): boolean {
  return currentProbe()?.fingerprint ?? nativeFlags()?.androidBiometricKind === "fingerprint";
}

export function canUseNativeUnlock(): boolean {
  return !!nativeUnlockStatus().available || canProbeNativeUnlock();
}

export function canEnrollNativeUnlock(): boolean {
  const { available, unsupported } = nativeUnlockStatus();
  return !!available && !unsupported && (hasNativeWebLocks() || hasExclusiveNativeDocument());
}

export function isNativeEnrollmentUnsupported(error: unknown): boolean {
  return error instanceof NativeBiometricError && error.code === "unsupported";
}

export function refreshNativeUnlockCapability({ afterPending = false } = {}): Promise<void> {
  if (!canProbeNativeUnlock()) return Promise.resolve();
  const current = currentProbe() ?? (probe = { flags: nativeFlags() });
  if (afterPending && current.inFlight) return current.inFlight.then(() => refreshNativeUnlockCapability());
  return current.inFlight ??= invokeNative<unknown>("biometric_unlock_probe").then(value => {
    current.failed = false;
    switch (value) {
      case "fingerprint": case "biometric": case "android-biometric": current.result = "android-biometric"; break;
      case "touchid": case "faceid": case "windows-hello": current.result = value; break;
      case null: current.result = null; break;
      default: throw new NativeBiometricError("failed");
    }
    if (current.result) {
      current.lastKind = current.result;
      current.fingerprint = value === "fingerprint" ? true : value === "biometric" ? false : undefined;
    }
  }).catch(error => {
    current.result = null;
    current.failed = !(error instanceof NativeBiometricError && error.code === "unsupported");
  }).finally(() => {
    current.inFlight = undefined;
    if (currentProbe() === current) publishCapability();
  });
}

const biometricDeadlines = {
  biometric_unlock_probe: 1500,
  biometric_unlock_enroll: 60_000,
  biometric_unlock: 60_000,
  biometric_unlock_remove: 8_000,
};

async function invokeNative<T>(
  command: keyof typeof biometricDeadlines, args?: Record<string, string>, caller?: AbortSignal,
): Promise<T> {
  try {
    return await withNativeDeadline(biometricDeadlines[command], async signal => {
      const { invoke } = await import("@tauri-apps/api/core");
      assertNotAborted(signal);
      return invoke<T>(command, args);
    }, caller);
  }
  catch (error) {
    assertNotAborted(caller);
    const code = typeof error === "string" ? error : (error as { code?: unknown })?.code;
    throw new NativeBiometricError(code === "cancelled" || code === "lockout" || code === "invalidated" || code === "unsupported" ? code : "failed");
  }
}

function promptArguments(vaultId: string): Record<string, string> {
  return platformName() === "macos" ? { vaultId, locale: getLocale() } : { vaultId };
}

export const biometricUnlock = {
  enroll: async (vaultId: string, key: Uint8Array, signal?: AbortSignal): Promise<void> => {
    const { available } = nativeUnlockStatus();
    if (!available || !canEnrollNativeUnlock()) throw new NativeBiometricError(available ? "unsupported" : "unavailable");
    const flags = nativeFlags();
    try { await invokeNative<void>("biometric_unlock_enroll", { ...promptArguments(vaultId), key: toBase64Url(key) }, signal); }
    catch (error) {
      if (isNativeEnrollmentUnsupported(error) && flags === nativeFlags()) {
        unsupportedEnrollment = { flags, kind: available };
        publishCapability();
      }
      throw error;
    }
  },
  unlock: async (vaultId: string, signal?: AbortSignal): Promise<Uint8Array> => {
    if (!canUseNativeUnlock()) throw new NativeBiometricError("unavailable");
    // The saved slot can be tried while the optional capability probe is still pending.
    const key = fromBase64Url(await invokeNative<string>("biometric_unlock", promptArguments(vaultId), signal));
    if (key.byteLength !== 32) throw new Error("Invalid biometric key");
    return key;
  },
  remove: async (vaultId: string, signal?: AbortSignal): Promise<void> => {
    if (!canRemoveNativeUnlock()) throw new NativeBiometricError("unavailable");
    await invokeNative<void>("biometric_unlock_remove", { vaultId }, signal);
  },
};
