import { afterEach, expect, it, vi } from "vitest";
import { capabilities } from "./capabilities.js";
import { acknowledgeUiBundleReady, readUpdateChannel, UI_READY_RETRY_DELAYS, uiBundles, UiRestartError, UPDATE_CHANNEL_KEY, updates, UpdateError } from "./updates.js";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.1.0") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); localStorage.removeItem(UPDATE_CHANNEL_KEY); delete window.__PRIVATEBASE_NATIVE_CAPABILITIES__; delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
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

it("uses the local preference when the native channel has not been initialized", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true };
  vi.mocked(invoke).mockResolvedValueOnce(null);
  localStorage.setItem(UPDATE_CHANNEL_KEY, "beta");
  await expect(readUpdateChannel()).resolves.toBe("beta");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("ui_bundle_get_channel");
});

it.each([[true, "1.0.2", "1.0.2"], [true, null, undefined], [true, "", undefined], [true, 7, undefined], [true, "rejected", undefined],
  ["read-only", "1.0.2", undefined], [undefined, "1.0.2", undefined]] as const)(
  "reads the staged UI version only from writable OTA shells (otaUi %s, native %s)", async (otaUi, native, expected) => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = otaUi === undefined ? {} : { otaUi };
    if (native === "rejected") vi.mocked(invoke).mockRejectedValueOnce("unknown command");
    else vi.mocked(invoke).mockResolvedValueOnce(native);
    await expect(uiBundles.getPending()).resolves.toBe(expected);
    expect(vi.mocked(invoke).mock.calls).toEqual(otaUi === true ? [["ui_bundle_get_pending"]] : []);
  });

function otaShell() {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true };
  return { ready: acknowledgeUiBundleReady, invoke: vi.mocked(invoke), delays: UI_READY_RETRY_DELAYS };
}
it("retries a transient ui_bundle_ready failure with short backoff well inside the 20 s window", async () => {
  vi.useFakeTimers();
  try {
    const { ready, invoke: native, delays } = otaShell();
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(6000);
    native.mockRejectedValueOnce("failed").mockRejectedValueOnce(new Error("IPC busy")).mockResolvedValueOnce(undefined);
    const acknowledged = ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(native).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(delays[0]);
    expect(native).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(delays[1]);
    await expect(acknowledged).resolves.toBeUndefined();
    expect(native.mock.calls).toEqual(Array(3).fill(["ui_bundle_ready", { channel: "stable" }]));
  } finally { vi.useRealTimers(); }
});
it("gives up after three failed tries", async () => {
  vi.useFakeTimers();
  try {
    const { ready, invoke: native } = otaShell();
    native.mockRejectedValue("failed");
    const acknowledged = ready();
    const outcome = expect(acknowledged).rejects.toBe("failed");
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    expect(native).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});
it.each(["unsupported", "no_trial"])("stops retrying after the definitive %s answer", async code => {
  vi.useFakeTimers();
  try {
    const { ready, invoke: native } = otaShell();
    native.mockRejectedValue(code);
    const outcome = expect(ready()).rejects.toBe(code);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    expect(native).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it.each([
  [{ otaUi: true, otaUiRestart: true }, undefined, null],
  [{ otaUi: true, otaUiRestart: true }, "not_ready", "not_ready"],
  [{ otaUi: true, otaUiRestart: true }, "unsupported", "unsupported"],
  [{ otaUi: true, otaUiRestart: true }, "C:\\Users\\me\\secret path", "failed"],
  [{ otaUi: true }, undefined, "unsupported"],
  [{ otaUi: "read-only", otaUiRestart: true }, undefined, "unsupported"],
] as const)("restarts into the staged bundle only when advertised (%j, native %s)", async (flags, rejection, code) => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { ...flags };
  expect(capabilities.otaUiRestart).toBe(flags.otaUi === true && "otaUiRestart" in flags);
  if (rejection) vi.mocked(invoke).mockRejectedValueOnce(rejection);
  else vi.mocked(invoke).mockResolvedValueOnce(undefined);
  const result = uiBundles.restart();
  if (code) await expect(result).rejects.toEqual(new UiRestartError(code));
  else await expect(result).resolves.toBeUndefined();
  expect(vi.mocked(invoke).mock.calls).toEqual(capabilities.otaUiRestart ? [["ui_bundle_restart"]] : []);
});
it("does not advertise restart in a browser", () => {
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true, otaUiRestart: true };
  expect(capabilities.otaUiRestart).toBe(false);
});
