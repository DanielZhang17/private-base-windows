import { asArrayBufferView, fromBase64Url, toBase64Url } from "@e2ee-chat/crypto";
import { PBKDF2_ITERATIONS } from "@e2ee-chat/shared";
import { biometricUnlock, nativeUnlockStatus } from "../platform/biometric-unlock.js";
import { capabilities } from "../platform/capabilities.js";
import { evaluatePasskeyPrf } from "./webauthn.js";
import { decryptData, encryptData } from "./local-key-encryption.js";

/** Derive an AES-256 encryption key from the user's password and a stored salt. */
export async function deriveEncryptionKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", asArrayBufferView(new TextEncoder().encode(password)), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: asArrayBufferView(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type UnlockMethod = "password" | "passkey" | "native";

export function unlockMethodAvailable(method: UnlockMethod): boolean {
  return method === "password" || (method === "passkey" ? capabilities.passkeys : !!nativeUnlockStatus().available);
}

type PrfCredential = { credentialId: string; rpId: string };
type PrfInput = PrfCredential & { salt: Uint8Array; output: Uint8Array };
export type UnlockSetup =
  | { method: "password"; password: string }
  | ({ method: "passkey" } & (PrfCredential | PrfInput))
  | { method: "native" };

type EncryptedKey = { iv: string; ciphertext: string };
export type UnlockSlot =
  | ({ method: "password"; salt: string } & EncryptedKey)
  | ({ method: "passkey"; salt: string } & PrfCredential & EncryptedKey)
  | { method: "native"; keyId: string };

export interface DeviceVault {
  id: string;
  slots: UnlockSlot[];
  pendingNativeRemoval?: string;
}

const VAULT_TYPE = "device-kek-v1";

export function vaultRecord(vault: DeviceVault) {
  return { id: "dbKey", type: VAULT_TYPE, data: JSON.stringify(vault) };
}

export function readVault(record: { type: string; data: string } | undefined): DeviceVault | null {
  if (record?.type !== VAULT_TYPE) return null;
  try {
    const vault = JSON.parse(record.data) as DeviceVault;
    return vault?.id && Array.isArray(vault.slots) ? vault : null;
  } catch {
    return null;
  }
}

export async function generateVault() {
  const encKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const vault: DeviceVault = { id: crypto.randomUUID(), slots: [] };
  return { encKey, vault };
}

/** A PRF output is used only as HKDF input. Its derived AES key and output never enter IndexedDB. */
async function prfWrappingKey(output: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  if (output.byteLength !== 32 || salt.byteLength !== 32) throw new Error("Invalid passkey PRF output or salt");
  const input = await crypto.subtle.importKey("raw", asArrayBufferView(output), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt: asArrayBufferView(salt),
    info: new TextEncoder().encode("privatebase-device-kek-prf-v1"),
  }, input, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

type SlotWrappingSetup = Exclude<UnlockSetup, { method: "native" }> | { method: "native"; keyId: string };

export async function wrapUnlockSlot(key: CryptoKey, setup: SlotWrappingSetup, signal?: AbortSignal): Promise<UnlockSlot> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  try {
    switch (setup.method) {
      case "native": {
        const { keyId } = setup;
        await biometricUnlock.enroll(keyId, raw, signal);
        return { method: "native", keyId };
      }
      case "password": {
        if (!setup.password) throw new Error("Password is required");
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const wrappingKey = await deriveEncryptionKey(setup.password, salt);
        return { method: "password", salt: toBase64Url(salt), ...await encryptData(wrappingKey, raw) };
      }
      case "passkey": {
        const salt = "salt" in setup ? setup.salt : crypto.getRandomValues(new Uint8Array(32));
        const output = "output" in setup ? setup.output : await evaluatePasskeyPrf(setup.credentialId, setup.rpId, salt);
        try {
          const wrappingKey = await prfWrappingKey(output, salt);
          return { method: "passkey", salt: toBase64Url(salt), credentialId: setup.credentialId, rpId: setup.rpId,
            ...await encryptData(wrappingKey, raw) };
        } finally {
          if (!("output" in setup)) output.fill(0);
        }
      }
    }
  } finally { raw.fill(0); }
}

export async function unwrapUnlockSlot(slot: UnlockSlot, password?: string, signal?: AbortSignal): Promise<CryptoKey> {
  let raw: Uint8Array;
  if (slot.method === "native") {
    raw = await biometricUnlock.unlock(slot.keyId, signal);
  } else {
    const salt = fromBase64Url(slot.salt);
    let wrappingKey: CryptoKey;
    if (slot.method === "password") {
      if (password === undefined) throw new Error("Password is required");
      wrappingKey = await deriveEncryptionKey(password, salt);
    } else {
      const output = await evaluatePasskeyPrf(slot.credentialId, slot.rpId, salt);
      try { wrappingKey = await prfWrappingKey(output, salt); }
      finally { output.fill(0); }
    }
    raw = await decryptData(wrappingKey, slot.iv, slot.ciphertext);
  }
  try {
    if (raw.byteLength !== 32) throw new Error("Invalid local device KEK");
    return await crypto.subtle.importKey("raw", asArrayBufferView(raw), "AES-GCM", true, ["encrypt", "decrypt"]);
  } finally { raw.fill(0); }
}
