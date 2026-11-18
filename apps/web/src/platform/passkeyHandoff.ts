import { isNative } from "./environment.js";
import { LocalizedError } from "../i18n/messages.js";

export const PASSKEY_HANDOFF_ORIGIN = "https://chat.718788.xyz";
let nativeHandoffPending: Promise<void> | undefined;

function waitForHandoffResult<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

export function waitForNativePasskeyHandoff(signal?: AbortSignal): Promise<void> | undefined {
  return nativeHandoffPending && waitForHandoffResult(nativeHandoffPending, signal);
}

// Tauri has no synchronous command discovery. Phase 2 launchers advertise this only
// when passkey_handoff_start is installed; older launchers therefore stay disabled.
declare global {
  interface Window {
    __PRIVATEBASE_NATIVE_CAPABILITIES__?: {
      passkeyHandoff?: boolean;
      passkeyProvisionHandoff?: boolean;
      androidBiometricKind?: "fingerprint" | "biometrics";
      biometricUnlock?: import("./biometric-unlock.js").BiometricUnlock;
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

export function supportsPasskeyProvisionHandoff(): boolean {
  return supportsPasskeyHandoff() && window.__PRIVATEBASE_NATIVE_CAPABILITIES__?.passkeyProvisionHandoff === true;
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function createPasskeyHandoff(): Promise<{ state: string; codeVerifier: string; codeChallenge: string }> {
  const state = encode(crypto.getRandomValues(new Uint8Array(32)));
  const codeVerifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))));
  return { state, codeVerifier, codeChallenge };
}

// Undefined denotes ordinary login or registration. Null denotes an invalid provision query.
export function getHandoffProvisionHash(params: URLSearchParams, signIn: boolean): string | null | undefined {
  if (!params.has("mode") && !params.has("bundleHash")) return undefined;
  const hash = params.get("bundleHash") ?? "";
  return signIn && params.get("mode") === "provision" && params.getAll("mode").length === 1 &&
    params.getAll("bundleHash").length === 1 && /^[A-Za-z0-9_-]{43}$/.test(hash) ? hash : null;
}

export async function startPasskeyHandoff(url: string, signal?: AbortSignal): Promise<URL> {
  if (!supportsPasskeyHandoff()) throw new LocalizedError("nativePasskeyUnsupported");
  const start = new URL(url);
  const state = start.searchParams.get("state");
  const valueKey = start.pathname.endsWith("/sign-in") ? "challenge" : "ticket";
  const value = start.searchParams.get(valueKey);
  const provisionHash = getHandoffProvisionHash(start.searchParams, valueKey === "challenge");
  if (start.origin !== PASSKEY_HANDOFF_ORIGIN || start.username || start.password || start.hash ||
      !["/native/passkey/sign-in", "/native/passkey/add"].includes(start.pathname) ||
      !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || start.searchParams.getAll("state").length !== 1 ||
      !value || !/^[A-Za-z0-9_-]{43}$/.test(value) || start.searchParams.getAll(valueKey).length !== 1 ||
      provisionHash === null ||
      [...start.searchParams.keys()].some(key => key !== "state" && key !== valueKey &&
        !(provisionHash && (key === "mode" || key === "bundleHash")))) {
    throw new LocalizedError("nativePasskeyInvalidRequest");
  }
  if (provisionHash && !supportsPasskeyProvisionHandoff()) throw new LocalizedError("nativePasskeyUnsupported");
  const { invoke } = await import("@tauri-apps/api/core");
  let callbackUrl: string;
  try {
    // Aborting the WebView waiter does not release the launcher. Let the old
    // callback or native timeout settle before invoking the command again.
    while (nativeHandoffPending) await waitForNativePasskeyHandoff(signal);
    signal?.throwIfAborted();
    if (!supportsPasskeyHandoff() || (provisionHash && !supportsPasskeyProvisionHandoff())) {
      throw new LocalizedError("nativePasskeyUnsupported");
    }
    const pending = invoke<string>("passkey_handoff_start", { url, callbackScheme: "privatebase" });
    nativeHandoffPending = pending.then(() => undefined, () => undefined).finally(() => {
      nativeHandoffPending = undefined;
    });
    callbackUrl = await waitForHandoffResult(pending, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof LocalizedError) throw error;
    if (error === "cancelled") throw new LocalizedError("nativePasskeyCancelled");
    if (error === "unsupported" || (typeof error === "string" && /command.*not found/i.test(error))) {
      const caps = window.__PRIVATEBASE_NATIVE_CAPABILITIES__;
      if (caps) {
        if (provisionHash) caps.passkeyProvisionHandoff = false;
        else caps.passkeyHandoff = false;
      }
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
