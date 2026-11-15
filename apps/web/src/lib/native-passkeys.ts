import type { AuthResponse } from "@e2ee-chat/shared";
import { api } from "../services/api.js";
import { createPasskeyHandoff, PASSKEY_HANDOFF_ORIGIN, startPasskeyHandoff } from "../platform/passkeyHandoff.js";

export async function signInWithNativePasskey(deviceId: string): Promise<AuthResponse> {
  const { state, codeVerifier, codeChallenge } = await createPasskeyHandoff();
  const url = new URL("/native/passkey/sign-in", PASSKEY_HANDOFF_ORIGIN);
  url.search = new URLSearchParams({ challenge: codeChallenge, state }).toString();
  const callback = await startPasskeyHandoff(url.href);
  return api.post<AuthResponse>("/auth/passkey/handoff/redeem", { code: callback.searchParams.get("code"), codeVerifier, deviceId });
}

export async function addNativePasskey(friendlyName: string): Promise<void> {
  const { state, codeVerifier, codeChallenge } = await createPasskeyHandoff();
  const { ticket } = await api.post<{ ticket: string }>("/api/passkeys/handoff/register-start", { codeChallenge });
  const url = new URL("/native/passkey/add", PASSKEY_HANDOFF_ORIGIN);
  url.search = new URLSearchParams({ ticket, state }).toString();
  const callback = await startPasskeyHandoff(url.href);
  await api.post("/api/passkeys/handoff/register-complete", { pendingId: callback.searchParams.get("registered"), codeVerifier, friendlyName });
}
