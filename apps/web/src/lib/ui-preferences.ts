export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface UiPreferences {
  themeMode: ThemeMode;
  outgoingMessageColor: string;
  incomingMessageColor: string;
  sendButtonColor: string;
  compressAttachments?: boolean;
}

const LIGHT_DEFAULTS = {
  outgoingMessageColor: "#14586e",
  incomingMessageColor: "#e3e9eb",
  sendButtonColor: "#14586e",
} satisfies Omit<UiPreferences, "themeMode" | "compressAttachments">;

const DARK_DEFAULTS = {
  outgoingMessageColor: "#1c6b84",
  incomingMessageColor: "#22323b",
  sendButtonColor: "#1c6b84",
} satisfies Omit<UiPreferences, "themeMode" | "compressAttachments">;

export function resolveTheme(themeMode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (themeMode === "system") return prefersDark ? "dark" : "light";
  return themeMode;
}

export function getDefaultUiPreferences(theme: ResolvedTheme): UiPreferences {
  const colors = theme === "dark" ? DARK_DEFAULTS : LIGHT_DEFAULTS;
  return {
    themeMode: "system",
    ...colors,
  };
}

export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(trimmed)) return null;
  return trimmed;
}

export function isHexColor(value: string): boolean {
  return normalizeHexColor(value) !== null;
}

function channelToLinear(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function getLuminance(backgroundHex: string): number {
  const hex = normalizeHexColor(backgroundHex) ?? "#000000";
  const red = parseInt(hex.slice(1, 3), 16);
  const green = parseInt(hex.slice(3, 5), 16);
  const blue = parseInt(hex.slice(5, 7), 16);
  const luminance = (
    0.2126 * channelToLinear(red) +
    0.7152 * channelToLinear(green) +
    0.0722 * channelToLinear(blue)
  );
  return luminance;
}

export function getContrastRatio(first: string, second: string): number {
  const a = getLuminance(first);
  const b = getLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function getReadableTextColor(backgroundHex: string): string {
  const dark = "#111827";
  const light = "#f9fafb";
  return getContrastRatio(backgroundHex, dark) >= getContrastRatio(backgroundHex, light) ? dark : light;
}

/**
 * Link colour inside incoming bubbles: the theme's primary colour when it stays
 * readable (WCAG AA, 4.5:1) on the user's incoming bubble colour, otherwise the
 * bubble's readable text colour, or pure black/white when even that falls
 * short on a mid-tone bubble (links stay underlined either way).
 */
export function getIncomingLinkColor(incomingBackgroundHex: string, primaryHex: string): string {
  if (isHexColor(primaryHex) && getContrastRatio(primaryHex, incomingBackgroundHex) >= 4.5) return "var(--primary)";
  const readable = getReadableTextColor(incomingBackgroundHex);
  if (getContrastRatio(readable, incomingBackgroundHex) >= 4.5) return readable;
  return getContrastRatio("#000000", incomingBackgroundHex) >= getContrastRatio("#ffffff", incomingBackgroundHex) ? "#000000" : "#ffffff";
}

/** Only an entire old default palette is uncustomised; preserve every custom palette. */
export function migrateDefaultPreferences(preferences: UiPreferences, prefersDark = false): UiPreferences {
  const palette = [preferences.outgoingMessageColor, preferences.incomingMessageColor, preferences.sendButtonColor]
    .map((value) => value.toLowerCase()).join("/");
  if (palette !== "#2563eb/#e5e7eb/#2563eb" && palette !== "#3b82f6/#1f2937/#3b82f6") return preferences;
  const defaults = getDefaultUiPreferences(resolveTheme(preferences.themeMode, prefersDark));
  return { ...preferences, ...defaults, themeMode: preferences.themeMode };
}
