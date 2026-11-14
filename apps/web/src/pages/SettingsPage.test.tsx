import { getByLabelText, getByRole } from "@testing-library/dom";
import { loadLocale, LOCALE_STORAGE_KEY, setLocalePreference, t } from "../i18n/index.js";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage.js";
import { useSettings } from "../features/settings/useSettings.js";
import { api } from "../services/api.js";
import { capabilities } from "../platform/capabilities.js";
import { copyText } from "../platform/clipboard.js";
import { resetLocalCryptoState } from "../lib/key-manager.js";
import { click, setupDom } from "../ui/test-utils.js";
vi.mock("../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), put: vi.fn(async () => ({})) }, resolveApiUrl: (path: string) => path }));
vi.mock("../stores/authStore.js", async () => { const { create } = await import("zustand"); return { useAuthStore: create(() => ({ user: { id: "sam", displayName: "Sam Rivera", username: "sam" }, device: { id: "this-device" }, logout: vi.fn(), bumpSessionState: vi.fn(), updateProfile: vi.fn() })) }; });
vi.mock("../lib/key-manager.js", () => ({ lockLocalCryptoState: vi.fn(), resetLocalCryptoState: vi.fn(async () => { }) }));
vi.mock("../platform/session.js", () => ({ clearAccountScopedState: vi.fn() }));
vi.mock("../platform/clipboard.js", () => ({ copyText: vi.fn(async () => { }) }));
vi.mock("../lib/device-link.js", () => ({ generateRecoveryKey: () => "abcd-efgh-ijkl-mnop" }));
const { render } = setupDom();
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(false);
  vi.mocked(api.get).mockImplementation(async (path) => (path.endsWith("/recovery-key") ? { enrolled: true } : []) as never);
  vi.mocked(api.post).mockResolvedValue({}); client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => { client.clear(); vi.restoreAllMocks(); });
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
