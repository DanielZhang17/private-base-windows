import { getByLabelText, getByRole } from "@testing-library/dom";
import { loadLocale, LOCALE_STORAGE_KEY, setLocalePreference, t } from "../i18n/index.js";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage.js";
import { useSettings } from "../features/settings/useSettings.js";
import { addNativePasskey } from "../lib/native-passkeys.js";
import { api } from "../services/api.js";
import { capabilities } from "../platform/capabilities.js";
import { copyText } from "../platform/clipboard.js";
import { resetLocalCryptoState } from "../lib/key-manager.js";
import { invoke } from "@tauri-apps/api/core";
import { requestNotificationPermission } from "../platform/notifications.js";
import { startBackgroundSession } from "../platform/android-background-service.js";
import { click, setupDom } from "../ui/test-utils.js";
vi.mock("../lib/native-passkeys.js", () => ({ addNativePasskey: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../platform/notifications.js", () => ({ requestNotificationPermission: vi.fn() }));
vi.mock("../services/api.js", () => ({ api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn(), put: vi.fn(async () => ({})) }, resolveApiUrl: (path: string) => path }));
vi.mock("../stores/authStore.js", async () => { const { create } = await import("zustand"); return { useAuthStore: create(() => ({ user: { id: "sam", displayName: "Sam Rivera", username: "sam" }, device: { id: "this-device" }, logout: vi.fn(), bumpSessionState: vi.fn(), updateProfile: vi.fn() })) }; });
vi.mock("../lib/key-manager.js", () => ({ lockLocalCryptoState: vi.fn(), resetLocalCryptoState: vi.fn(async () => { }) }));
vi.mock("../platform/session.js", () => ({ clearAccountScopedState: vi.fn() }));
vi.mock("../platform/clipboard.js", () => ({ copyText: vi.fn(async () => { }) }));
vi.mock("../lib/device-link.js", () => ({ generateRecoveryKey: () => "abcd-efgh-ijkl-mnop" }));
const { render } = setupDom();
let client: QueryClient;
let stopBackground: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.mocked(requestNotificationPermission).mockResolvedValue(true);
  vi.mocked(invoke).mockImplementation(async command => command === "get_capture_protection"
    ? { enabled: true }
    : { running: false, notifications: true, fullScreen: false, batteryExempt: false });
  localStorage.removeItem("private-base:android-background:sam");
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(false);
  vi.mocked(api.get).mockImplementation(async (path) => (path.endsWith("/recovery-key") ? { enrolled: true } : path.endsWith("/privacy") ? { discoverable: true, groupInvites: "everyone" } : []) as never);
  vi.mocked(api.patch).mockImplementation(async (_path, patch) => ({ discoverable: true, groupInvites: "everyone", ...patch as object }) as never);
  vi.mocked(api.post).mockResolvedValue({}); client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(async () => { await act(async () => { stopBackground?.(); }); stopBackground = undefined; client.clear(); vi.restoreAllMocks(); });
async function show(section: string) {
  await render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[`/settings?section=${section}`]}>
      <SettingsPage />
    </MemoryRouter>
  </QueryClientProvider>);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}
const button = (text: string, scope: ParentNode = document) => Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent === text)!;
it("hides passkey management on unsupported platforms", async () => {
  await show("security"); expect(document.body.textContent).not.toContain("Passkeys");
  expect(api.get).not.toHaveBeenCalledWith("/api/passkeys");
});
it("hides Notifications and its toggle without the Android background capability", async () => {
  await show("notifications");
  expect(document.body.textContent).not.toContain("Stay connected in background");
  expect(Array.from(document.querySelectorAll("button")).some((node) => node.textContent === "Notifications")).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});
it("shows an off-by-default per-device toggle, persists it and provides Android settings", async () => {
  vi.spyOn(capabilities, "backgroundConnection", "get").mockReturnValue(true);
  stopBackground = startBackgroundSession("sam", () => true);
  await show("notifications");
  const toggle = getByRole<HTMLInputElement>(document.body, "switch", { name: "Stay connected in background" });
  expect(toggle.checked).toBe(false);
  expect(document.body.textContent).toContain(t("androidBackground.battery"));
  await click(toggle);
  expect(toggle.checked).toBe(true);
  expect(localStorage.getItem("private-base:android-background:sam")).toBe("true");
  expect(invoke).toHaveBeenCalledWith("configure_background", { enabled: true });
  expect(document.body.textContent).toContain(t("androidBackground.doze"));
  await click(button("Battery optimization settings"));
  expect(invoke).toHaveBeenCalledWith("open_background_settings", { setting: "battery" });
  await click(button("Full-screen call settings"));
  expect(invoke).toHaveBeenCalledWith("open_background_settings", { setting: "fullScreen" });
  await click(toggle);
  expect(toggle.checked).toBe(false);
  expect(localStorage.getItem("private-base:android-background:sam")).toBe("false");
});
it("disables the toggle while permission is pending and displays denial without enabling", async () => {
  vi.spyOn(capabilities, "backgroundConnection", "get").mockReturnValue(true);
  let grant!: (value: boolean) => void;
  vi.mocked(requestNotificationPermission).mockReturnValue(new Promise((resolve) => { grant = resolve; }));
  stopBackground = startBackgroundSession("sam", () => true);
  await show("notifications");
  const toggle = getByRole<HTMLInputElement>(document.body, "switch", { name: "Stay connected in background" });
  await click(toggle); expect(toggle.disabled).toBe(true);
  await act(async () => { grant(false); });
  expect(toggle.disabled).toBe(false); expect(toggle.checked).toBe(false);
  expect(document.body.textContent).toContain(t("androidBackground.permission"));
  expect(invoke).not.toHaveBeenCalledWith("configure_background", { enabled: true });
});
it("requires acknowledgement before forgetting keys and keeps the error in the dialog", async () => {
  vi.mocked(resetLocalCryptoState).mockRejectedValueOnce(new Error("Keys could not be cleared"));
  await show("security"); await click(button("Forget keys on this device…"));
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(button("Forget keys", dialog).disabled).toBe(true);
  await click(button("Forget keys", dialog)); expect(resetLocalCryptoState).not.toHaveBeenCalled();
  await click(dialog.querySelector('input[type="checkbox"]')!); await click(button("Forget keys", dialog));
  expect(resetLocalCryptoState).toHaveBeenCalledTimes(1); expect(dialog.textContent).toContain("Keys could not be cleared");
});
it("requires acknowledgement before submitting account deletion and preserves password/DELETE validation", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("Enter your password and DELETE"));
  await show("account"); await click(button("Delete account…"));
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(button("Delete account", dialog).disabled).toBe(true); expect(dialog.querySelector('input[type="password"]')).not.toBeNull();
  await click(button("Delete account", dialog)); expect(api.post).not.toHaveBeenCalled();
  await click(dialog.querySelector('input[type="checkbox"]')!); await click(button("Delete account", dialog));
  expect(api.post).toHaveBeenCalledWith("/api/account/delete", { password: "", confirmationText: "" }); expect(dialog.textContent).toContain("Enter your password and DELETE");
});
it("reveals a non-dismissible recovery key, copies through the adapter, and requires acknowledgement", async () => {
  vi.mocked(api.get).mockImplementation(async (path) => (path.endsWith("/recovery-key") ? { enrolled: false } : []) as never);
  await show("security"); await click(button("Create recovery key"));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector('.mockup-code code')?.textContent).toBe("abcd-efgh-ijkl-mnop");
  expect(button("Continue", dialog).disabled).toBe(true);
  expect(dialog.querySelector('[aria-label="Close"]')).toBeNull();
  await click(button("Copy", dialog)); expect(copyText).toHaveBeenCalledWith("abcd-efgh-ijkl-mnop"); expect(document.body.textContent).toContain("Recovery key copied");
  await click(dialog.querySelector('input[type="checkbox"]')!); await click(button("Continue", dialog)); expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("offers no recovery-key creation or replacement once enrolled", async () => {
  await show("security");
  expect(document.body.textContent).toContain("Set up");
  expect(button("Replace recovery key")).toBeUndefined();
  expect(button("Create recovery key")).toBeUndefined();
  expect(api.post).not.toHaveBeenCalled();
});

it("ignores direct enrollment attempts when a recovery key is already enrolled", async () => {
  let settings!: ReturnType<typeof useSettings>;
  function Probe() { settings = useSettings(); return null; }
  await render(<QueryClientProvider client={client}><MemoryRouter><Probe /></MemoryRouter></QueryClientProvider>);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(settings.hasRecoveryKey).toBe(true);
  await act(async () => { await settings.handleEnrollRecoveryKey(); });
  expect(api.post).not.toHaveBeenCalled();
  expect(settings.generatedRecoveryKey).toBeNull();
});

it.each(["Cancel", "Close"])("clears a cancelled emoji file when dismissing with %s", async (dismiss) => {
  await show("emoji");
  await click(button("Add emoji"));
  let dialog = document.querySelector('[role="dialog"]')!;
  const fileInput = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
  const shortcode = dialog.querySelector<HTMLInputElement>('input[placeholder="shortcode"]')!;
  const file = new File(["cancelled image"], "cancelled.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(8) });
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(shortcode, "party");
    shortcode.dispatchEvent(new Event("input", { bubbles: true }));
    Object.defineProperty(fileInput, "files", { value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click(dismiss === "Cancel" ? button("Cancel", dialog) : dialog.querySelector('button[aria-label="Close"]')!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click(button("Add emoji"));
  dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector<HTMLInputElement>('input[type="file"]')!.files).toHaveLength(0);
  await click(button("Upload", dialog));
  expect(api.post).not.toHaveBeenCalled();
  expect(api.put).not.toHaveBeenCalled();
  expect(dialog.textContent).toContain("Choose an image file to upload");
});

async function selectLanguage(value: string) {
  const select = getByLabelText<HTMLSelectElement>(document.body, t("language"));
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("changes language immediately, persists on the device, and survives a remount", async () => {
  await loadLocale("de");
  await show("appearance");
  expect(getByLabelText(document.body, "Language").tagName).toBe("SELECT");
  await selectLanguage("de");
  expect(document.body.textContent).toContain("Sprache");
  expect(document.documentElement.lang).toBe("de");
  expect(document.documentElement.dir).toBe("ltr");
  expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("de");
  await render(null);
  await show("appearance");
  expect(document.querySelector<HTMLSelectElement>("select")!.value).toBe("de");
  expect(document.body.textContent).toContain("Sprache");
});
it("System follows navigator.languages and languagechange while an explicit choice stays fixed", async () => {
  await Promise.all([loadLocale("de"), loadLocale("fr")]);
  const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["unsupported", "de-DE"]);
  await show("appearance");
  await selectLanguage("system");
  expect(document.documentElement.lang).toBe("de");
  expect(document.body.textContent).toContain("Deutsch");
  languages.mockReturnValue(["fr-CA", "en"]);
  await act(async () => { window.dispatchEvent(new Event("languagechange")); });
  expect(document.documentElement.lang).toBe("fr");
  expect(document.body.textContent).toContain("Français");
  await selectLanguage("en");
  languages.mockReturnValue(["de-DE"]);
  await act(async () => { window.dispatchEvent(new Event("languagechange")); });
  expect(document.documentElement.lang).toBe("en");
});
it("keeps language usable when device storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  await act(async () => { await setLocalePreference("en"); });
  await show("appearance");
  expect(document.body.textContent).toContain("Language");
});


it("re-renders an existing validation error in English after it was raised in German", async () => {
  await act(async () => { await setLocalePreference("de"); });
  await show("emoji");
  await click(getByRole(document.body, "button", { name: t("addEmoji") }));
  const dialog = getByRole(document.body, "dialog");
  await click(getByRole(dialog, "button", { name: t("uploadEmojiAction") }));
  const alert = getByRole(dialog, "alert");
  expect(alert.textContent).toBe(t("chooseAnImageFileToUpload"));
  expect(alert.textContent).not.toBe("Choose an image file to upload");
  await act(async () => { await setLocalePreference("en"); });
  expect(getByRole(dialog, "alert")).toBe(alert);
  expect(alert.textContent).toBe("Choose an image file to upload");
  expect(api.post).not.toHaveBeenCalled();
});

it("shows passkey management on native launchers and adds through the browser handoff", async () => {
  vi.spyOn(capabilities, "nativePasskeys", "get").mockReturnValue(true);
  vi.mocked(addNativePasskey).mockResolvedValue();
  await show("security");
  expect(document.body.textContent).toContain("Passkeys");
  expect(api.get).toHaveBeenCalledWith("/api/passkeys");
  const input = getByLabelText<HTMLInputElement>(document.body, "Passkey name");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Native phone");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Add a passkey"));
  expect(addNativePasskey).toHaveBeenCalledWith("Native phone");
  expect(api.post).not.toHaveBeenCalledWith("/api/passkeys/register-options");
});

it("shows Privacy with Hide me off and Everyone selected, and hides unsupported capture protection", async () => {
  await show("privacy");
  const hide = getByRole<HTMLInputElement>(document.body, "switch", { name: "Hide me" });
  expect(hide.checked).toBe(false);
  expect(getByLabelText<HTMLSelectElement>(document.body, "Who can add me to groups").value).toBe("everyone");
  expect(document.body.textContent).toContain(t("hideMeHelp"));
  expect(document.body.textContent).not.toContain(t("captureProtectionLabel"));
  expect(invoke).not.toHaveBeenCalled();
  await click(hide);
  expect(api.patch).toHaveBeenCalledWith("/api/account/privacy", { discoverable: false });
  expect(hide.checked).toBe(true);
  expect(document.body.textContent).toContain(t("privacySaved"));
});
it.each(["contacts", "nobody", "everyone"])("saves group invitation choice %s", async groupInvites => {
  await show("privacy");
  const select = getByLabelText<HTMLSelectElement>(document.body, "Who can add me to groups");
  await act(async () => { select.value = groupInvites; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(api.patch).toHaveBeenCalledWith("/api/account/privacy", { groupInvites });
  expect(select.value).toBe(groupInvites);
});
it.each([
  ["full", "captureProtectionFull"], ["recording", "captureProtectionRecording"], ["best-effort", "captureProtectionBestEffort"],
] as const)("shows capability-specific %s capture copy and immediately invokes the device command", async (capability, copy) => {
  vi.spyOn(capabilities, "captureProtection", "get").mockReturnValue(capability);
  await show("privacy");
  const toggle = getByRole<HTMLInputElement>(document.body, "switch", { name: t("captureProtectionLabel") });
  expect(toggle.checked).toBe(true);
  expect(document.body.textContent).toContain(t(copy));
  await click(toggle);
  expect(toggle.checked).toBe(false);
  expect(invoke).toHaveBeenLastCalledWith("set_capture_protection", { enabled: false });
  expect(api.patch).not.toHaveBeenCalled();
  await click(toggle);
  expect(invoke).toHaveBeenLastCalledWith("set_capture_protection", { enabled: true });
});
it("keeps failed privacy changes visible inline and preserves the previous value", async () => {
  vi.mocked(api.patch).mockRejectedValueOnce(new Error("offline"));
  await show("privacy");
  const hide = getByRole<HTMLInputElement>(document.body, "switch", { name: "Hide me" });
  await click(hide);
  expect(hide.checked).toBe(false);
  expect(document.body.textContent).toContain(t("privacySaveFailed"));
});
it("preserves protection and shows an inline error when the capture command fails", async () => {
  vi.spyOn(capabilities, "captureProtection", "get").mockReturnValue("recording");
  await show("privacy");
  vi.mocked(invoke).mockRejectedValueOnce(new Error("bridge failed"));
  const toggle = getByRole<HTMLInputElement>(document.body, "switch", { name: t("captureProtectionLabel") });
  await click(toggle);
  expect(toggle.checked).toBe(true);
  expect(document.body.textContent).toContain(t("captureProtectionFailed"));
});
