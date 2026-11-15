import { act } from "react";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { usePrivacySettings } from "./usePrivacySettings.js";
import { api } from "../../services/api.js";
import { capabilities } from "../../platform/capabilities.js";
import { invoke } from "@tauri-apps/api/core";
import { setLocalePreference, t } from "../../i18n/index.js";
import { setupDom } from "../../ui/test-utils.js";
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), patch: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "alice" } })) };
});
const { render } = setupDom();
let client: QueryClient;
let state: ReturnType<typeof usePrivacySettings>;
function Probe({ active }: { active: boolean }) { state = usePrivacySettings(active); return null; }
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset().mockImplementation(async command => command === "get_capture_protection" ? { enabled: true } : undefined);
  vi.mocked(api.get).mockResolvedValue({ discoverable: true, groupInvites: "everyone" });
  vi.mocked(api.patch).mockResolvedValue({ discoverable: false, groupInvites: "everyone" });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => { client.clear(); vi.restoreAllMocks(); });
async function show(active = true) {
  await render(<QueryClientProvider client={client}><Probe active={active} /></QueryClientProvider>);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
it("loads only when Privacy is active and uses account-scoped cached data", async () => {
  await show(false); expect(api.get).not.toHaveBeenCalled();
  await show();
  expect(api.get).toHaveBeenCalledExactlyOnceWith("/api/account/privacy");
  expect(state.data).toEqual({ discoverable: true, groupInvites: "everyone" });
  await act(async () => { expect(await state.save({ discoverable: false })).toBe(true); });
  expect(api.patch).toHaveBeenCalledWith("/api/account/privacy", { discoverable: false });
  expect(client.getQueryData(["privacy", "alice"])).toEqual({ discoverable: false, groupInvites: "everyone" });
});
it("serializes concurrent saves and disables controls until the request completes", async () => {
  let finish!: (data: unknown) => void;
  vi.mocked(api.patch).mockImplementation(() => new Promise(resolve => { finish = resolve; }) as never);
  await show();
  let pending!: Promise<boolean>;
  await act(async () => { pending = state.save({ discoverable: false }); expect(await state.save({ groupInvites: "nobody" })).toBe(false); });
  expect(state.disabled).toBe(true); expect(api.patch).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ discoverable: false, groupInvites: "everyone" }); await pending; });
  expect(state.disabled).toBe(false);
});
it("preserves server data on save failures and translates the error after a locale change", async () => {
  await show();
  vi.mocked(api.patch).mockRejectedValueOnce(new Error("offline"));
  await act(async () => { expect(await state.save({ discoverable: false })).toBe(false); });
  expect(state.data?.discoverable).toBe(true);
  expect(state.error).toBe(t("privacySaveFailed"));
  await act(async () => { await setLocalePreference("de"); });
  expect(state.error).toBe(t("privacySaveFailed"));
});
it("disables server controls on load errors and retries", async () => {
  vi.mocked(api.get).mockRejectedValueOnce(new Error("offline"));
  await show();
  expect(state.disabled).toBe(true); expect(state.error).toContain(t("privacyLoadFailed"));
  await act(async () => { state.retry(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(state.disabled).toBe(false); expect(state.error).toBeNull();
});
it("reads and updates the native window while offline", async () => {
  vi.spyOn(capabilities, "captureProtection", "get").mockReturnValue("full");
  vi.mocked(invoke).mockResolvedValueOnce({ enabled: false });
  onlineManager.setOnline(false);
  try {
    await show();
    expect(state.capture.enabled).toBe(false);
    await act(async () => { expect(await state.capture.setEnabled(true)).toBe(true); });
    expect(state.capture.enabled).toBe(true);
    expect(api.get).not.toHaveBeenCalled();
  } finally {
    await act(async () => { onlineManager.setOnline(true); });
  }
});
it("keeps capture preferences on this device across remounts with no API patch", async () => {
  vi.spyOn(capabilities, "captureProtection", "get").mockReturnValue("full");
  await show(); expect(state.capture.enabled).toBe(true);
  await act(async () => { expect(await state.capture.setEnabled(false)).toBe(true); });
  expect(invoke).toHaveBeenCalledWith("set_capture_protection", { enabled: false });
  expect(api.patch).not.toHaveBeenCalled();
  await render(null); await show(); expect(state.capture.enabled).toBe(false);
});
it("serializes capture commands and leaves the previous preference intact on failure", async () => {
  vi.spyOn(capabilities, "captureProtection", "get").mockReturnValue("recording");
  let reject!: (error: Error) => void;
  vi.mocked(invoke).mockImplementation(command => command === "get_capture_protection"
    ? Promise.resolve({ enabled: true })
    : new Promise((_resolve, failure) => { reject = failure; }));
  await show();
  let pending!: Promise<boolean>;
  await act(async () => { pending = state.capture.setEnabled(false); expect(await state.capture.setEnabled(true)).toBe(false); });
  expect(state.capture.busy).toBe(true);
  await act(async () => { reject(new Error("bridge failure")); expect(await pending).toBe(false); });
  expect(state.capture.busy).toBe(false); expect(state.capture.enabled).toBe(true);
  expect(state.capture.error).toBe(t("captureProtectionFailed"));
});
it("reports an unknown capture state and retries reading the native window", async () => {
  vi.spyOn(capabilities, "captureProtection", "get").mockReturnValue("full");
  vi.mocked(invoke).mockRejectedValueOnce(new Error("bridge unavailable"));
  await show();
  expect(state.capture.enabled).toBeUndefined();
  expect(state.capture.error).toBe(t("captureProtectionFailed"));
  await act(async () => { expect(await state.capture.setEnabled(false)).toBe(false); });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("get_capture_protection");
  vi.mocked(invoke).mockResolvedValueOnce({ enabled: false });
  await act(async () => { state.capture.retry(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(state.capture.enabled).toBe(false);
  expect(state.capture.error).toBeNull();
});
it("does not invoke capture protection when unsupported", async () => {
  await show();
  await act(async () => { expect(await state.capture.setEnabled(false)).toBe(false); });
  expect(invoke).not.toHaveBeenCalled();
});
