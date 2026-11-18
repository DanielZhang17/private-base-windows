import { toBase64Url } from "@e2ee-chat/crypto";
import {
  createDeviceLinkApprovalPayload,
  createDeviceLinkChallengePayload,
} from "@e2ee-chat/shared";
import { signWithIdentityKey } from "./key-manager.js";
import { t } from "../i18n/index.js";
import { isNative } from "../platform/environment.js";

function chunkString(value: string, size: number): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    parts.push(value.slice(index, index + size));
  }
  return parts.join("-");
}

export function buildDefaultDeviceName(): string {
  const { userAgent, platform, maxTouchPoints, userAgentData } = navigator as Navigator & {
    userAgentData?: { platform?: string; brands?: { brand: string }[] };
  };
  const system = `${userAgentData?.platform ?? ""} ${userAgent} ${platform}`;
  const systemName = /iPod/i.test(system) ? "iPod touch"
    : /iPhone/i.test(system) ? "iPhone"
    : /iPad/i.test(system) || (platform === "MacIntel" && maxTouchPoints > 1) ? "iPad"
    : /Android/i.test(system) ? "Android"
    : /CrOS|Chrome OS|ChromeOS/i.test(system) ? "ChromeOS"
    : /Windows|Win32|Win64/i.test(system) ? "Windows"
    : /Mac/i.test(system) ? "macOS"
    : /Linux/i.test(system) ? "Linux" : undefined;
  const browsers = [
    ["Edge", /Microsoft Edge|\bEdg(?:A|iOS)?\//i],
    ["Opera", /\bOpera\b|\bOP(?:R|iOS)\//i],
    ["Samsung Internet", /Samsung Internet|SamsungBrowser\//i],
    ["Vivaldi", /\bVivaldi\b/i],
    ["Brave", /\bBrave\b/i],
    ["Firefox", /\bFirefox\b|\bFxiOS\//i],
    ["Chrome", /Google Chrome|\bChrome\/|\bCriOS\//i],
    ["Chromium", /\bChromium\b/i],
    ["Safari", /\bSafari\//i],
  ] as const;
  const brands = userAgentData?.brands?.map(({ brand }) => brand).join(" ") ?? "";
  const client = isNative() ? "Private Base"
    : (browsers.find(([, pattern]) => pattern.test(brands)) ??
      browsers.find(([, pattern]) => pattern.test(userAgent)))?.[0] ?? t("browser");
  return systemName ? t("devices.clientOnPlatform", { client, platform: systemName }) : client;
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
