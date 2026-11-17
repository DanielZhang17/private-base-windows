import { afterEach, expect, it, vi } from "vitest";
import { capabilities } from "./capabilities.js";
import { updates, UpdateError } from "./updates.js";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.1.0") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); delete window.__PRIVATEBASE_NATIVE_CAPABILITIES__; delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
it("ignores browser flags and preserves other native capabilities", async () => {
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { autoUpdate: "desktop", passkeyHandoff: true };
  expect(capabilities.autoUpdate).toBeUndefined();
  await expect(updates.check("stable")).rejects.toMatchObject({ code: "unsupported" });
  expect(invoke).not.toHaveBeenCalled();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  expect(capabilities.autoUpdate).toBe("desktop");
  expect(window.__PRIVATEBASE_NATIVE_CAPABILITIES__.passkeyHandoff).toBe(true);
});
it("uses only the contracted commands, channel and embedded app version", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("android");
  vi.mocked(invoke).mockResolvedValue({ available: false });
  expect(await updates.getVersion()).toBe("0.1.0");
  expect(getVersion).toHaveBeenCalledOnce();
  await updates.check("beta"); await updates.download(); await updates.install(); await updates.openPermissionSettings();
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["update_check", { channel: "beta" }], ["update_download", undefined], ["update_install", undefined], ["update_open_permission_settings", undefined],
  ]);
});
it("does not expose raw native diagnostics and preserves known error codes", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("desktop");
  for (const code of ["network", "unsupported", "permission_required"]) {
    vi.mocked(invoke).mockRejectedValueOnce(code);
    await expect(updates.install()).rejects.toMatchObject({ code });
  }
  vi.mocked(invoke).mockRejectedValueOnce("arbitrary native diagnostic");
  await expect(updates.check("stable")).rejects.toEqual(new UpdateError("failed"));
  await expect(updates.openPermissionSettings()).rejects.toMatchObject({ code: "unsupported" });
});
it("filters malformed progress and returns the native unlistener", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("desktop");
  const stop = vi.fn(), callback = vi.fn();
  vi.mocked(listen).mockResolvedValue(stop);
  expect(await updates.onProgress(callback)).toBe(stop);
  const emit = vi.mocked(listen).mock.calls[0][1];
  emit({ payload: { downloaded: 5, total: 10 } } as never);
  emit({ payload: { downloaded: -1, total: 10 } } as never);
  emit({ payload: { downloaded: NaN, total: 0 } } as never);
  expect(callback).toHaveBeenCalledExactlyOnceWith({ downloaded: 5, total: 10 });
});
