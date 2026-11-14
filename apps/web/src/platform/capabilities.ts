import { isNative, platformName } from "./environment.js";
import { supportsE2EECalling } from "./calls.js";

// Getters keep feature detection current, including after browser API initialization.
export const capabilities = {
  get saveFile(): boolean {
    const platform = platformName();
    return platform !== "ios" && platform !== "android";
  },
  get passkeys(): boolean {
    return !isNative() && typeof window !== "undefined" &&
      typeof window.PublicKeyCredential !== "undefined" &&
      typeof navigator.credentials?.create === "function" &&
      typeof navigator.credentials?.get === "function";
  },
  get systemNotifications(): boolean {
    return isNative() || typeof Notification !== "undefined";
  },
  get e2eeCalls(): boolean {
    return supportsE2EECalling();
  },
};
