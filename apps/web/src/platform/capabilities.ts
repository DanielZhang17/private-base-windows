import type { BiometricUnlock } from "./biometric-unlock.js";
import { supportsPasskeyHandoff, supportsPasskeyProvisionHandoff } from "./passkeyHandoff.js";
import { isNative, platformName } from "./environment.js";
import { supportsE2EECalling } from "./calls.js";
import { historyTransferEnabled } from "../features/transfer/flag.js";

// Getters keep feature detection current, including after browser API initialization.
export const capabilities = {
  historyTransfer: historyTransferEnabled,
  get autoUpdate(): "desktop" | "android" | undefined {
    if (!isNative()) return undefined;
    const value = window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.autoUpdate;
    return value === "desktop" || value === "android" ? value : undefined;
  },
  get otaUi(): boolean {
    return isNative() && window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.otaUi === true;
  },
  get otaUiAvailable(): boolean {
    return this.otaUi || (isNative() && window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.otaUi === "read-only");
  },
  /** Writable desktop OTA launches can restart into a staged UI bundle. */
  get otaUiRestart(): boolean {
    return this.otaUi && window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.otaUiRestart === true;
  },
  get captureProtection(): "full" | "recording" | "best-effort" | undefined {
    if (!isNative()) return undefined;
    const value = window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.captureProtection;
    return value === "full" || value === "recording" || value === "best-effort" ? value : undefined;
  },
  get backgroundConnection(): boolean {
    return isNative() && platformName() === "android" &&
      window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.backgroundConnection === true;
  },
  get nativeCallNotifications(): boolean {
    return isNative() && platformName() === "android" &&
      window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.nativeCallNotifications === true;
  },
  get fileOpen(): boolean {
    return isNative() && window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.fileOpen === true;
  },
  get fileSave(): "dialog" | "downloads" | "share" | undefined {
    if (!isNative()) return undefined;
    const value = window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.fileSave;
    return value === "dialog" || value === "downloads" || value === "share" ? value : undefined;
  },
  get saveFile(): boolean {
    if (this.fileSave) return true;
    const platform = platformName();
    return platform !== "ios" && platform !== "android";
  },
  get passkeys(): boolean {
    return !isNative() && typeof window !== "undefined" &&
      typeof window.PublicKeyCredential !== "undefined" &&
      typeof navigator.credentials?.create === "function" &&
      typeof navigator.credentials?.get === "function";
  },
  get biometricUnlock(): BiometricUnlock | undefined {
    if (!isNative()) return undefined;
    const value = window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.biometricUnlock;
    return value === "touchid" || value === "faceid" || value === "windows-hello" || value === "android-biometric"
      ? value : undefined;
  },
  get nativePasskeyProvisioning(): boolean {
    return supportsPasskeyProvisionHandoff();
  },
  get nativePasskeys(): boolean {
    return supportsPasskeyHandoff();
  },
  get systemNotifications(): boolean {
    return isNative() || typeof Notification !== "undefined";
  },
  get e2eeCalls(): boolean {
    return supportsE2EECalling();
  },
};
