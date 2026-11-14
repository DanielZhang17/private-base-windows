/**
 * WebAuthn browser helpers for passkey registration and authentication.
 * Uses the native Web Authentication API (navigator.credentials).
 */

import type {
  PasskeyRegistrationOptionsResponse,
  PasskeyLoginOptionsResponse,
} from "@e2ee-chat/shared";
import { capabilities } from "../platform/capabilities.js";

export class PasskeyUnsupportedError extends Error {
  readonly code = "PASSKEY_UNSUPPORTED";

  constructor() {
    super("Passkeys are unavailable in this app. Use a supported web browser on chat.718788.xyz to sign in with a passkey.");
    this.name = "PasskeyUnsupportedError";
  }
}

function requirePasskeys(): void {
  if (!capabilities.passkeys) throw new PasskeyUnsupportedError();
}

function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const padded = b64 + "=".repeat(pad);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Convert Uint8Array to a plain ArrayBuffer (avoids TS SharedArrayBuffer mismatch). */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

export function isWebAuthnSupported(): boolean {
  return capabilities.passkeys;
}

export async function isPasskeyAutofillAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  try {
    return await PublicKeyCredential.isConditionalMediationAvailable?.() ?? false;
  } catch {
    return false;
  }
}

/**
 * Call navigator.credentials.create() using server-provided options.
 * Returns a JSON-serializable credential response.
 */
export async function createPasskeyCredential(
  serverOptions: PasskeyRegistrationOptionsResponse["options"],
): Promise<{
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
  authenticatorAttachment?: string;
}> {
  requirePasskeys();
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: toBuffer(base64urlToBytes(serverOptions.challenge)),
    rp: serverOptions.rp,
    user: {
      id: toBuffer(base64urlToBytes(serverOptions.user.id)),
      name: serverOptions.user.name,
      displayName: serverOptions.user.displayName,
    },
    pubKeyCredParams: serverOptions.pubKeyCredParams,
    timeout: serverOptions.timeout,
    attestation: serverOptions.attestation as AttestationConveyancePreference,
    authenticatorSelection: {
      residentKey: serverOptions.authenticatorSelection.residentKey as ResidentKeyRequirement,
      userVerification: serverOptions.authenticatorSelection.userVerification as UserVerificationRequirement,
    },
    excludeCredentials: serverOptions.excludeCredentials.map((c) => ({
      id: toBuffer(base64urlToBytes(c.id)),
      type: c.type,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
  };

  const credential = await navigator.credentials.create({ publicKey }) as PublicKeyCredential;
  if (!credential) throw new Error("Passkey creation cancelled");

  const attestationResponse = credential.response as AuthenticatorAttestationResponse;

  return {
    id: credential.id,
    rawId: bytesToBase64url(new Uint8Array(credential.rawId)),
    type: "public-key",
    response: {
      clientDataJSON: bytesToBase64url(new Uint8Array(attestationResponse.clientDataJSON)),
      attestationObject: bytesToBase64url(new Uint8Array(attestationResponse.attestationObject)),
      transports: attestationResponse.getTransports?.() ?? [],
    },
    authenticatorAttachment: (credential as any).authenticatorAttachment ?? undefined,
  };
}

/**
 * Call navigator.credentials.get() using server-provided options.
 * Returns a JSON-serializable assertion response.
 */
export async function getPasskeyAssertion(
  serverOptions: PasskeyLoginOptionsResponse["options"],
): Promise<{
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
}> {
  requirePasskeys();
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: toBuffer(base64urlToBytes(serverOptions.challenge)),
    rpId: serverOptions.rpId,
    timeout: serverOptions.timeout,
    userVerification: serverOptions.userVerification as UserVerificationRequirement,
    allowCredentials: serverOptions.allowCredentials.map((c) => ({
      id: toBuffer(base64urlToBytes(c.id)),
      type: c.type,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
  };

  const credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential;
  if (!credential) throw new Error("Passkey authentication cancelled");

  const assertionResponse = credential.response as AuthenticatorAssertionResponse;

  return {
    id: credential.id,
    rawId: bytesToBase64url(new Uint8Array(credential.rawId)),
    type: "public-key",
    response: {
      clientDataJSON: bytesToBase64url(new Uint8Array(assertionResponse.clientDataJSON)),
      authenticatorData: bytesToBase64url(new Uint8Array(assertionResponse.authenticatorData)),
      signature: bytesToBase64url(new Uint8Array(assertionResponse.signature)),
      userHandle: assertionResponse.userHandle
        ? bytesToBase64url(new Uint8Array(assertionResponse.userHandle))
        : undefined,
    },
  };
}
