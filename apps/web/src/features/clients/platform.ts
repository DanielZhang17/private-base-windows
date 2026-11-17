import { PLATFORM_ORDER, type PlatformKey } from "./manifest.js";

/** "other": Linux, ChromeOS and anything unknown. The web app is featured instead. */
export type DetectedPlatform = PlatformKey | "other";

export interface PlatformEnvironment {
  /** location.search, for the ?platform= override. */
  search: string;
  userAgent: string;
  /** navigator.platform (deprecated, but the only iPadOS desktop-mode signal). */
  platform?: string;
  maxTouchPoints?: number;
  /** navigator.userAgentData.platform where supported (Chromium). */
  userAgentDataPlatform?: string;
}

function isPlatformKey(value: string | null): value is PlatformKey {
  return value !== null && (PLATFORM_ORDER as readonly string[]).includes(value);
}

/** First match wins (spec 2). Processor type is deliberately not detected. */
export function detectPlatform(env: PlatformEnvironment): DetectedPlatform {
  const override = new URLSearchParams(env.search).get("platform")?.toLowerCase() ?? null;
  if (isPlatformKey(override)) return override;
  const ua = env.userAgent;
  if (/Android/i.test(ua)) return "android";
  // iPadOS 13+ in desktop mode reports a Mac user agent; only touch points tell it apart.
  if (/iPhone|iPad|iPod/i.test(ua) || (env.platform === "MacIntel" && (env.maxTouchPoints ?? 0) > 1)) return "ios";
  if (env.userAgentDataPlatform === "Windows" || /Windows/i.test(ua)) return "windows";
  if (env.userAgentDataPlatform === "macOS" || /Macintosh/i.test(ua)) return "macos";
  return "other";
}

export function readPlatformEnvironment(): PlatformEnvironment {
  if (typeof window === "undefined" || typeof navigator === "undefined") return { search: "", userAgent: "" };
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return {
    search: window.location.search,
    userAgent: nav.userAgent ?? "",
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    userAgentDataPlatform: nav.userAgentData?.platform,
  };
}

export interface PlatformLayout {
  /** The featured card: a platform, or the web app when the OS is not one we build for. */
  featured: PlatformKey | "web";
  /** Every remaining platform in the fixed order; never repeats the featured one. */
  others: PlatformKey[];
}

export function platformLayout(detected: DetectedPlatform): PlatformLayout {
  if (detected === "other") return { featured: "web", others: [...PLATFORM_ORDER] };
  return { featured: detected, others: PLATFORM_ORDER.filter((key) => key !== detected) };
}
