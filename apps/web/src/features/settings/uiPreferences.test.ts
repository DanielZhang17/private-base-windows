import { createJSONStorage } from "zustand/middleware";
import { beforeEach, describe, expect, it } from "vitest";
import { getContrastRatio, getDefaultUiPreferences, getIncomingLinkColor, getReadableTextColor, migrateDefaultPreferences, type UiPreferences } from "../../lib/ui-preferences.js";
import { useUiPreferencesStore } from "../../stores/uiPreferencesStore.js";
const oldLight: UiPreferences = { themeMode: "light", outgoingMessageColor: "#2563eb", incomingMessageColor: "#e5e7eb", sendButtonColor: "#2563eb" };
const oldDark: UiPreferences = { themeMode: "dark", outgoingMessageColor: "#3b82f6", incomingMessageColor: "#1f2937", sendButtonColor: "#3b82f6" };
const entries = new Map<string, string>();
const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
beforeEach(() => { useUiPreferencesStore.persist.setOptions({ storage: createJSONStorage(() => storage) }); for (const id of Object.keys(useUiPreferencesStore.getState().preferencesByUserId)) useUiPreferencesStore.getState().clearPreferencesForUser(id); entries.clear(); });
describe("brand palette migration", () => {
  it.each([["light", "#14586e", "#e3e9eb"], ["dark", "#1c6b84", "#22323b"]] as const)("uses approved %s defaults", (theme, outgoing, incoming) => {
    expect(getDefaultUiPreferences(theme)).toEqual({ themeMode: "system", outgoingMessageColor: outgoing, incomingMessageColor: incoming, sendButtonColor: outgoing });
  });
  it.each([oldLight, oldDark])("migrates the full old palette and preserves $themeMode", (old) => {
    expect(migrateDefaultPreferences(old)).toEqual({ ...getDefaultUiPreferences(old.themeMode as "light" | "dark"), themeMode: old.themeMode });
  });
  it("resolves system palettes against the current system theme", () => {
    const old = { ...oldLight, themeMode: "system" as const };
    expect(migrateDefaultPreferences(old, true)).toEqual(getDefaultUiPreferences("dark"));
    expect(migrateDefaultPreferences(old, false)).toEqual(getDefaultUiPreferences("light"));
  });
  it("notifies existing reader subscribers immediately on save and reset", () => {
    const before = useUiPreferencesStore.getState().getPreferencesForUser;
    useUiPreferencesStore.getState().savePreferencesForUser("sam", { ...getDefaultUiPreferences("dark"), themeMode: "dark" });
    const saved = useUiPreferencesStore.getState().getPreferencesForUser;
    expect(saved).not.toBe(before);
    expect(saved("sam").themeMode).toBe("dark");
    useUiPreferencesStore.getState().clearPreferencesForUser("sam");
    const cleared = useUiPreferencesStore.getState().getPreferencesForUser;
    expect(cleared).not.toBe(saved);
    expect(cleared("sam")).toEqual(getDefaultUiPreferences("light"));
  });
  it("preserves a custom palette, including a single changed colour", () => {
    const custom = { ...oldLight, incomingMessageColor: "#abcdef" };
    expect(migrateDefaultPreferences(custom, true)).toBe(custom);
  });
  it("migrates persisted user entries on hydration while preserving another user's custom palette", async () => {
    const custom = { ...oldDark, sendButtonColor: "#123456" };
    storage.setItem("e2ee-ui-preferences", JSON.stringify({ state: { preferencesByUserId: { alice: oldLight, bob: custom } }, version: 0 }));
    await useUiPreferencesStore.persist.rehydrate();
    const store = useUiPreferencesStore.getState();
    expect(store.getPreferencesForUser("alice").outgoingMessageColor).toBe("#14586e");
    expect(store.getPreferencesForUser("bob", true)).toEqual(custom);
    expect(store.getPreferencesForUser(null, true)).toEqual(getDefaultUiPreferences("dark"));
  });
});
describe("readable text", () => {
  it("gives #3b82f6 an AA text contrast", () => {
    const foreground = getReadableTextColor("#3b82f6");
    expect(foreground).toBe("#111827");
    expect(getContrastRatio("#3b82f6", foreground)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["#000000", "#ffffff", "#14586e", "#1c6b84", "#808080", "#f6c667", "#6b3fa0"])("chooses the higher contrast foreground for %s", (background) => {
    expect(getContrastRatio(background, getReadableTextColor(background))).toBe(Math.max(getContrastRatio(background, "#111827"), getContrastRatio(background, "#f9fafb")));
  });
});

describe("incoming link colour", () => {
  it.each([["light", "#14586e"], ["dark", "#6cc3db"]] as const)("keeps the %s primary colour on the default incoming bubble", (theme, primary) => {
    const incoming = getDefaultUiPreferences(theme).incomingMessageColor;
    expect(getContrastRatio(primary, incoming)).toBeGreaterThanOrEqual(4.5);
    expect(getIncomingLinkColor(incoming, ` ${primary}`)).toBe("var(--primary)");
  });
  it.each(["#14586e", "#0f4759", "#222222"])("falls back to readable text on a low-contrast custom bubble %s", (incoming) => {
    expect(getIncomingLinkColor(incoming, "#14586e")).toBe(getReadableTextColor(incoming));
  });
  it.each([["#7a7a7a", "#000000"], ["#767676", "#000000"]])("uses pure black/white when the palette text colour misses 4.5:1 on %s", (incoming, expected) => {
    expect(getContrastRatio(getReadableTextColor(incoming), incoming)).toBeLessThan(4.5);
    const color = getIncomingLinkColor(incoming, "#14586e");
    expect(color).toBe(expected);
    expect(getContrastRatio(color, incoming)).toBeGreaterThanOrEqual(4.5);
  });
  it("meets 4.5:1 for every grey bubble", () => {
    for (let value = 0; value < 256; value += 1) {
      const incoming = `#${value.toString(16).padStart(2, "0").repeat(3)}`;
      const color = getIncomingLinkColor(incoming, "#6cc3db");
      expect(getContrastRatio(color === "var(--primary)" ? "#6cc3db" : color, incoming)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("falls back when the primary colour cannot be read", () => {
    expect(getIncomingLinkColor("#e3e9eb", "")).toBe(getReadableTextColor("#e3e9eb"));
  });
});
