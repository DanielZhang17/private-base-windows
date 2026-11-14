import { toBase64Url } from "@e2ee-chat/crypto";
import {
  createDeviceLinkApprovalPayload,
  createDeviceLinkChallengePayload,
} from "@e2ee-chat/shared";
import { signWithIdentityKey } from "./key-manager.js";

function chunkString(value: string, size: number): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    parts.push(value.slice(index, index + size));
  }
  return parts.join("-");
}

export function buildDefaultDeviceName(locale = "en", browserLabel = "Browser"): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform
    || browserLabel;
  return `${platform} ${new Date().toLocaleDateString(locale)}`;
}

export function generateRecoveryKey(): string {
  return chunkString(toBase64Url(crypto.getRandomValues(new Uint8Array(24))), 4);
}

export async function signDeviceLinkApproval(
  linkRequestId: string,
  newIdentityKey: string,
  shortCode: string,
  expiresAt: number,
): Promise<string> {
  return signWithIdentityKey(
    createDeviceLinkApprovalPayload(linkRequestId, newIdentityKey, shortCode, expiresAt),
  );
}

export async function signDeviceLinkCompletion(
  linkRequestId: string,
  challengeNonce: string,
): Promise<string> {
  return signWithIdentityKey(
    createDeviceLinkChallengePayload(linkRequestId, challengeNonce),
  );
}
