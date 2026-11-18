import { fromBase64Url, toBase64Url } from "@e2ee-chat/crypto";
import { capabilities } from "./capabilities.js";

export type BiometricUnlock = "touchid" | "faceid" | "windows-hello" | "android-biometric";

type BiometricFailureCode = "cancelled" | "lockout" | "invalidated" | "unsupported" | "failed";

export class NativeBiometricError extends Error {
  constructor(readonly code: BiometricFailureCode) { super(code); this.name = "NativeBiometricError"; }
}

export function isUnlockPromptCancelled(error: unknown): boolean {
  return (error as Error | undefined)?.name === "NotAllowedError" ||
    (error instanceof NativeBiometricError && error.code === "cancelled");
}

async function biometricInvoke<T>(command: string, args: Record<string, string>): Promise<T> {
  if (!capabilities.biometricUnlock) throw new NativeBiometricError("unsupported");
  const { invoke } = await import("@tauri-apps/api/core");
  try { return await invoke<T>(command, args); }
  catch (error) {
    const code = typeof error === "string" ? error : (error as { code?: unknown })?.code;
    throw new NativeBiometricError(code === "cancelled" || code === "lockout" || code === "invalidated" || code === "unsupported" ? code : "failed");
  }
}

export const biometricUnlock = {
  enroll: (vaultId: string, key: Uint8Array) =>
    biometricInvoke<void>("biometric_unlock_enroll", { vaultId, key: toBase64Url(key) }),
  unlock: async (vaultId: string): Promise<Uint8Array> => {
    const key = fromBase64Url(await biometricInvoke<string>("biometric_unlock", { vaultId }));
    if (key.byteLength !== 32) throw new Error("Invalid biometric key");
    return key;
  },
  remove: (vaultId: string) => biometricInvoke<void>("biometric_unlock_remove", { vaultId }),
};
