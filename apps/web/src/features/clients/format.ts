import type { TranslationKey } from "../../i18n/index.js";
import type { PlatformKey } from "./manifest.js";

/** Processor fact: a translation key for known builds, otherwise the raw manifest value. */
export type ProcessorLabel = { key: TranslationKey } | { raw: string };

const KNOWN_ARCH: Partial<Record<PlatformKey, Record<string, TranslationKey>>> = {
  macos: { arm64: "clients.archAppleSilicon" },
  windows: { x64: "clients.archX64" },
  android: { arm64: "clients.archArm64" },
};

export function processorLabel(platform: PlatformKey, arch: string): ProcessorLabel {
  const key = KNOWN_ARCH[platform]?.[arch.toLowerCase()];
  return key ? { key } : { raw: arch };
}

/** 64 hex characters as 8 groups of 8, rendered as separate text nodes. */
export function checksumGroups(sha256: string): string[] {
  return sha256.toLowerCase().match(/.{1,8}/g) ?? [];
}

/** Platform command that prints the file's SHA-256. Commands are code and stay untranslated. */
export function verifyCommand(platform: PlatformKey, file: string): string | null {
  if (platform === "macos") return `shasum -a 256 ~/Downloads/${file}`;
  // PowerShell starts in the home folder, so the path names Downloads like the macOS command.
  if (platform === "windows") return `Get-FileHash ~\\Downloads\\${file}`;
  return null;
}

export const PLATFORM_NAME_KEY: Record<PlatformKey, TranslationKey> = {
  macos: "clients.platformMacos",
  windows: "clients.platformWindows",
  android: "clients.platformAndroid",
  ios: "clients.platformIos",
};
