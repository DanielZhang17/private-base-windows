import { isNative } from "./environment.js";
import { LocalizedError } from "../i18n/messages.js";

export const PASSKEY_HANDOFF_ORIGIN = "https://chat.718788.xyz";

// Tauri has no synchronous command discovery. Phase 2 launchers advertise this only
// when passkey_handoff_start is installed; older launchers therefore stay disabled.
declare global {
  interface Window {
    __PRIVATEBASE_NATIVE_CAPABILITIES__?: {
      passkeyHandoff?: boolean;
      autoUpdate?: "desktop" | "android";
      fileOpen?: boolean;
      fileSave?: "dialog" | "downloads" | "share";
      backgroundConnection?: boolean;
      nativeCallNotifications?: boolean;
      captureProtection?: "full" | "recording" | "best-effort";
    };
  }
}
export function supportsPasskeyHandoff(): boolean {
  return isNative() && window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.passkeyHandoff === true;
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function createPasskeyHandoff(): Promise<{ state: string; codeVerifier: string; codeChallenge: string }> {
  const state = encode(crypto.getRandomValues(new Uint8Array(32)));
  const codeVerifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))));
  return { state, codeVerifier, codeChallenge };
}

export async function startPasskeyHandoff(url: string): Promise<URL> {
  if (!supportsPasskeyHandoff()) throw new LocalizedError("nativePasskeyUnsupported");
  const start = new URL(url);
  const state = start.searchParams.get("state");
  const valueKey = start.pathname.endsWith("/sign-in") ? "challenge" : "ticket";
  const value = start.searchParams.get(valueKey);
  if (start.origin !== PASSKEY_HANDOFF_ORIGIN || start.username || start.password || start.hash ||
      !["/native/passkey/sign-in", "/native/passkey/add"].includes(start.pathname) ||
      !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || start.searchParams.getAll("state").length !== 1 ||
      !value || !/^[A-Za-z0-9_-]{43}$/.test(value) || start.searchParams.getAll(valueKey).length !== 1 ||
      [...start.searchParams.keys()].some(key => key !== "state" && key !== valueKey)) {
    throw new LocalizedError("nativePasskeyInvalidRequest");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  let callbackUrl: string;
  try {
    callbackUrl = await invoke<string>("passkey_handoff_start", { url, callbackScheme: "privatebase" });
  } catch (error) {
    if (error === "cancelled") throw new LocalizedError("nativePasskeyCancelled");
    if (error === "unsupported" || (typeof error === "string" && /command.*not found/i.test(error))) {
      if (window.__PRIVATEBASE_NATIVE_CAPABILITIES__) window.__PRIVATEBASE_NATIVE_CAPABILITIES__.passkeyHandoff = false;
      throw new LocalizedError("nativePasskeyUnsupported");
    }
    // Do not surface native errors which might contain URLs or secrets.
    throw new LocalizedError("nativePasskeyFailed");
  }
  let callback: URL;
  try { callback = new URL(callbackUrl); } catch { throw new LocalizedError("nativePasskeyInvalidResponse"); }
  const resultKey = start.pathname.endsWith("/sign-in") ? "code" : "registered";
  if (callback.protocol !== "privatebase:" || callback.host !== "passkey" || callback.pathname !== "" ||
      callback.username || callback.password || callback.hash || callback.searchParams.get("state") !== state ||
      callback.searchParams.getAll("state").length !== 1 || callback.searchParams.getAll(resultKey).length !== 1 ||
      !callback.searchParams.get(resultKey) || [...callback.searchParams.keys()].some(key => key !== "state" && key !== resultKey)) {
    throw new LocalizedError("nativePasskeyInvalidResponse");
  }
  return callback;
}
