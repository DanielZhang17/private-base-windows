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
  onPrfSupport?: (enabled: boolean) => void,
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
  clientExtensionResults?: { credProps?: { rk?: boolean } };
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
      ...(serverOptions.authenticatorSelection.requireResidentKey === undefined ? {}
        : { requireResidentKey: serverOptions.authenticatorSelection.requireResidentKey }),
      userVerification: serverOptions.authenticatorSelection.userVerification as UserVerificationRequirement,
    },
    extensions: { ...serverOptions.extensions, prf: {} },
    excludeCredentials: serverOptions.excludeCredentials.map((c) => ({
      id: toBuffer(base64urlToBytes(c.id)),
      type: c.type,
      ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
    })),
  };

  const credential = await navigator.credentials.create({ publicKey }) as PublicKeyCredential;
  if (!credential) throw new Error("Passkey creation cancelled");

  const extensions = credential.getClientExtensionResults?.();
  onPrfSupport?.(extensions?.prf?.enabled === true);
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
    clientExtensionResults: extensions?.credProps ? { credProps: extensions.credProps } : undefined,
  };
}

/**
 * Call navigator.credentials.get() using server-provided options.
 * Returns a JSON-serializable assertion response.
 */
export async function getPasskeyAssertion(
  serverOptions: PasskeyLoginOptionsResponse["options"],
  request?: Pick<CredentialRequestOptions, "signal" | "mediation">,
): Promise<PasskeyAssertion> {
  return (await requestPasskeyAssertion(serverOptions, undefined, request)).credential;
}

export interface PasskeyAssertion {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
}

export function getPasskeyAssertionWithPrf(
  options: PasskeyLoginOptionsResponse["options"], salt: Uint8Array,
  request?: Pick<CredentialRequestOptions, "signal" | "mediation">,
) {
  return requestPasskeyAssertion(options, salt, request);
}

async function requestPasskeyAssertion(
  serverOptions: PasskeyLoginOptionsResponse["options"], salt?: Uint8Array,
  request?: Pick<CredentialRequestOptions, "signal" | "mediation">,
): Promise<{ credential: PasskeyAssertion; prf?: Uint8Array }> {
  requirePasskeys();
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: toBuffer(base64urlToBytes(serverOptions.challenge)),
    rpId: serverOptions.rpId,
    timeout: serverOptions.timeout,
    userVerification: salt ? "required" : serverOptions.userVerification as UserVerificationRequirement,
    ...(salt ? { extensions: { prf: { eval: { first: toBuffer(salt) } } } } : {}),
    allowCredentials: serverOptions.allowCredentials.map((c) => ({
      id: toBuffer(base64urlToBytes(c.id)),
      type: c.type,
      ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
    })),
  };

  const credential = await navigator.credentials.get({
    publicKey,
    ...(request?.signal ? { signal: request.signal } : {}),
    ...(request?.mediation ? { mediation: request.mediation } : {}),
  }) as PublicKeyCredential;
  if (!credential) throw new DOMException("Passkey authentication cancelled", "NotAllowedError");

  const assertionResponse = credential.response as AuthenticatorAssertionResponse;
  const result = salt ? readPrfResult(credential) : undefined;
  return { prf: result, credential: {
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
  } };
}

export class PasskeyPrfUnavailableError extends Error {
  constructor() {
    super("This passkey could not unlock this device");
    this.name = "PasskeyPrfUnavailableError";
  }
}

function readPrfResult(credential: PublicKeyCredential): Uint8Array | undefined {
  const first = credential.getClientExtensionResults?.()?.prf?.results?.first;
  if (first?.byteLength !== 32) return undefined;
  const output = ArrayBuffer.isView(first)
    ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
    : new Uint8Array(first);
  return output.byteLength === 32 ? output : undefined;
}

/** A local-only, user-verified request for an enrolled credential. */
export async function evaluatePasskeyPrf(credentialId: string, rpId: string, salt: Uint8Array): Promise<Uint8Array> {
  const { credential, prf } = await getPasskeyAssertionWithPrf({
    challenge: bytesToBase64url(crypto.getRandomValues(new Uint8Array(32))),
    rpId, timeout: 60_000, userVerification: "required",
    allowCredentials: [{ id: credentialId, type: "public-key" }],
  }, salt);
  if (credential.id !== credentialId || !prf) {
    prf?.fill(0);
    throw new PasskeyPrfUnavailableError();
  }
  return prf;
}
