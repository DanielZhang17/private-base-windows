import { LocalizedError } from "../i18n/messages.js";
import { createPasskeyEnrollmentPayload } from "@e2ee-chat/shared";
import { signWithIdentityKey } from "./key-manager.js";
import type { AuthResponse, PasskeyProvisionBundle, PendingPasskeySetup } from "@e2ee-chat/shared";
import { api } from "../services/api.js";
import { createPasskeyHandoff, PASSKEY_HANDOFF_ORIGIN, startPasskeyHandoff } from "../platform/passkeyHandoff.js";

async function getNativePasskeyCode(bundleHash?: string, signal?: AbortSignal) {
  const { state, codeVerifier, codeChallenge } = await createPasskeyHandoff();
  const url = new URL("/native/passkey/sign-in", PASSKEY_HANDOFF_ORIGIN);
  url.search = new URLSearchParams({
    challenge: codeChallenge, state,
    ...(bundleHash ? { mode: "provision", bundleHash } : {}),
  }).toString();
  const controller = new AbortController();
  signal?.throwIfAborted();
  const cancel = () => controller.abort(signal?.reason);
  const timer = setTimeout(() => controller.abort(new LocalizedError("passkeySetup.browserTimeout")), 180_000);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const callback = await startPasskeyHandoff(url.href, controller.signal);
    return { code: callback.searchParams.get("code"), codeVerifier };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

async function redeemNativePasskey<T>(body: object, caller?: AbortSignal) {
  caller?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason);
  const timer = setTimeout(() => controller.abort(), 30_000);
  caller?.addEventListener("abort", cancel, { once: true });
  try { return await api.post<T>("/auth/passkey/handoff/redeem", body, { signal: controller.signal }); }
  finally { clearTimeout(timer); caller?.removeEventListener("abort", cancel); }
}

export async function signInWithNativePasskey(deviceId: string, handoff?: {
  signal: AbortSignal; onHandoff: (stage: "browser" | "redeeming") => void;
}): Promise<AuthResponse> {
  handoff?.onHandoff("browser");
  const code = await getNativePasskeyCode(undefined, handoff?.signal);
  handoff?.onHandoff("redeeming");
  return redeemNativePasskey<AuthResponse>({ ...code, deviceId }, handoff?.signal);
}

export async function authorizeNativePasskeyProvision(bundleHash: string, bundle: PasskeyProvisionBundle, setupId: string, signal?: AbortSignal) {
  const secrets = await getNativePasskeyCode(bundleHash, signal);
  return () => redeemNativePasskey<PendingPasskeySetup>({ ...secrets, bundle, setupId }, signal);
}

export async function addNativePasskey(friendlyName: string, deviceId: string): Promise<void> {
  const { state, codeVerifier, codeChallenge } = await createPasskeyHandoff();
  const { ticket } = await api.post<{ ticket: string }>("/api/passkeys/handoff/register-start", { codeChallenge });
  const url = new URL("/native/passkey/add", PASSKEY_HANDOFF_ORIGIN);
  url.search = new URLSearchParams({ ticket, state }).toString();
  const callback = await startPasskeyHandoff(url.href);
  const pendingId = callback.searchParams.get("registered");
  if (!pendingId) throw new Error("Missing pending passkey");
  const deviceSignature = await signWithIdentityKey(createPasskeyEnrollmentPayload(deviceId, { kind: "native", pendingId }));
  await api.post("/api/passkeys/handoff/register-complete", { pendingId, codeVerifier, friendlyName, deviceSignature });
}
