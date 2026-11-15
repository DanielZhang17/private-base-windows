import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { capabilities } from "./capabilities.js";
import { getCaptureProtection, setCaptureProtection } from "./capture-protection.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("advertises only supported native values without changing other capability keys", () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { passkeyHandoff: true, captureProtection: "recording" };
  expect(capabilities.captureProtection).toBe("recording");
  expect(capabilities.nativePasskeys).toBe(true);
  expect(window.__PRIVATEBASE_NATIVE_CAPABILITIES__.passkeyHandoff).toBe(true);
  delete window.__PRIVATEBASE_NATIVE_CAPABILITIES__;
  expect(capabilities.captureProtection).toBeUndefined();
});
it("keeps the control unsupported on web even if a capability value is present", () => {
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { captureProtection: "full" };
  expect(capabilities.captureProtection).toBeUndefined();
  delete window.__PRIVATEBASE_NATIVE_CAPABILITIES__;
});
it("reads the actual window state when WebView storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.mocked(invoke).mockResolvedValueOnce({ enabled: false })
    .mockResolvedValueOnce(undefined).mockResolvedValueOnce({ enabled: true });

  expect(await getCaptureProtection()).toBe(false);
  await setCaptureProtection(true);
  expect(await getCaptureProtection()).toBe(true);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["get_capture_protection"], ["set_capture_protection", { enabled: true }], ["get_capture_protection"],
  ]);
});
