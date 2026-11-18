import { invoke } from "@tauri-apps/api/core";
import { toBase64Url } from "@e2ee-chat/crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocalePreference } from "../i18n/index.js";
import {
  biometricUnlock, canEnrollNativeUnlock, nativeUnlockLabel, nativeUnlockStatus, nativeUnlockUsesFingerprint,
  refreshNativeUnlockCapability,
} from "./biometric-unlock.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("navigator", { userAgent: "Macintosh", locks: { request: vi.fn() } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([{ biometricUnlockRemove: true }, { biometricUnlockCleanup: true }] as const)(
  "can remove without advertising enrollment or unlock (%o)",
  async flags => {
    vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", flags);
    await expect(biometricUnlock.enroll("slot", new Uint8Array(32))).rejects.toMatchObject({ code: "unavailable" });
    await expect(biometricUnlock.unlock("slot")).rejects.toMatchObject({ code: "unavailable" });
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await biometricUnlock.remove("slot");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("biometric_unlock_remove", { vaultId: "slot" });
  },
);

it("sends the current locale to macOS prompts and keeps legacy removal arguments", async () => {
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlock: "touchid" });
  await setLocalePreference("ja");
  const key = new Uint8Array(32).fill(7);
  const encoded = toBase64Url(key);
  vi.mocked(invoke).mockResolvedValueOnce(undefined).mockResolvedValueOnce(encoded).mockResolvedValueOnce(undefined);
  await biometricUnlock.enroll("slot", key);
  await expect(biometricUnlock.unlock("slot")).resolves.toEqual(key);
  await biometricUnlock.remove("slot");
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["biometric_unlock_enroll", { vaultId: "slot", key: encoded, locale: "ja" }],
    ["biometric_unlock", { vaultId: "slot", locale: "ja" }],
    ["biometric_unlock_remove", { vaultId: "slot" }],
  ]);
});

it("unlocks, removes, and aborts on older WebViews without modern AbortSignal helpers", async () => {
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlock: "touchid" });
  const prototype = Object.getPrototypeOf(new AbortController().signal);
  const throwIfAborted = Object.getOwnPropertyDescriptor(prototype, "throwIfAborted")!;
  Object.defineProperty(prototype, "throwIfAborted", { configurable: true, value: undefined });
  const reason = vi.spyOn(prototype, "reason", "get").mockReturnValue(undefined);
  try {
    const key = new Uint8Array(32).fill(7);
    vi.mocked(invoke).mockResolvedValueOnce(toBase64Url(key)).mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise(() => {}));
    await expect(biometricUnlock.unlock("slot")).resolves.toEqual(key);
    await expect(biometricUnlock.remove("slot")).resolves.toBeUndefined();

    const controller = new AbortController();
    const stopped = expect(biometricUnlock.unlock("slot", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    controller.abort();
    await stopped;
    await expect(biometricUnlock.remove("slot", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledTimes(3);
  } finally {
    reason.mockRestore();
    Object.defineProperty(prototype, "throwIfAborted", throwIfAborted);
  }
});

it.each(["unsupported", { code: "unsupported" }])("remembers an unsupported reply %o at the enrollment boundary", async reply => {
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlock: "windows-hello" });
  vi.mocked(invoke).mockRejectedValueOnce(reply);
  await expect(biometricUnlock.enroll("slot", new Uint8Array(32))).rejects.toMatchObject({ code: "unsupported" });
  expect(nativeUnlockStatus().unsupported).toBe(true);
  expect(canEnrollNativeUnlock()).toBe(false);
  await expect(biometricUnlock.enroll("different-slot", new Uint8Array(32))).rejects.toMatchObject({ code: "unsupported" });
  expect(invoke).toHaveBeenCalledOnce();
});

it("coalesces probes, keeps the reported fingerprint label, and refreshes it on retry", async () => {
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { androidBiometricProbe: true });
  vi.stubGlobal("navigator", { userAgent: "Android" });
  const key = new Uint8Array(32);
  vi.mocked(invoke)
    .mockResolvedValueOnce("fingerprint")
    .mockRejectedValueOnce({ code: "failed" })
    .mockResolvedValueOnce("biometric")
    .mockResolvedValueOnce(toBase64Url(key));

  const initial = refreshNativeUnlockCapability();
  expect(refreshNativeUnlockCapability()).toBe(initial);
  await initial;
  expect(canEnrollNativeUnlock()).toBe(true);
  expect(nativeUnlockUsesFingerprint()).toBe(true);
  await refreshNativeUnlockCapability();
  expect(nativeUnlockStatus()).toMatchObject({ available: undefined, probeFailed: true });
  expect(nativeUnlockUsesFingerprint()).toBe(true);
  expect(canEnrollNativeUnlock()).toBe(false);
  await refreshNativeUnlockCapability();
  await expect(biometricUnlock.unlock("slot")).resolves.toEqual(key);
  expect(nativeUnlockUsesFingerprint()).toBe(false);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["biometric_unlock_probe", undefined],
    ["biometric_unlock_probe", undefined],
    ["biometric_unlock_probe", undefined],
    ["biometric_unlock", { vaultId: "slot" }],
  ]);
});

it("uses a cleanup-only method hint without enabling enrollment", () => {
  vi.stubGlobal("navigator", { userAgent: "iPhone" });
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlockRemove: true, biometricUnlockKind: "touchid" });
  expect(nativeUnlockLabel()).toBe("touchid");
  expect(canEnrollNativeUnlock()).toBe(false);
});

it("leaves the iOS label generic when the cleanup-only shell supplies no modality", () => {
  vi.stubGlobal("navigator", { userAgent: "iPhone" });
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlockRemove: true });
  expect(nativeUnlockLabel()).toBeUndefined();
});

it("keeps the fingerprint hint on Android method-only results and honors explicit subtype results", async () => {
  vi.stubGlobal("navigator", { userAgent: "Android" });
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { androidBiometricProbe: true, androidBiometricKind: "fingerprint" });
  vi.mocked(invoke).mockResolvedValueOnce("android-biometric").mockResolvedValueOnce("biometric");
  await refreshNativeUnlockCapability();
  expect(nativeUnlockUsesFingerprint()).toBe(true);
  await refreshNativeUnlockCapability();
  expect(nativeUnlockUsesFingerprint()).toBe(false);
});

it("lets the native unlock command determine permanent slot loss after an unavailable probe", async () => {
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlockProbe: true });
  vi.mocked(invoke).mockResolvedValueOnce(null).mockRejectedValueOnce("invalidated");
  await refreshNativeUnlockCapability();
  await expect(biometricUnlock.unlock("slot")).rejects.toMatchObject({ code: "invalidated" });
  expect(invoke).toHaveBeenLastCalledWith("biometric_unlock", { vaultId: "slot", locale: "en" });
});

it("unlocks directly during a stalled probe and retries the probe after its deadline", async () => {
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlockProbe: true });
  vi.useFakeTimers();
  const key = new Uint8Array(32).fill(7);
  let finish!: (kind: string) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(toBase64Url(key)).mockResolvedValueOnce("touchid");
  const stalled = refreshNativeUnlockCapability();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  await expect(biometricUnlock.unlock("slot")).resolves.toEqual(key);
  expect(nativeUnlockStatus().probePending).toBe(true);
  await vi.advanceTimersByTimeAsync(1500);
  await stalled;
  expect(nativeUnlockStatus()).toMatchObject({ probePending: false, probeFailed: true, available: undefined });
  finish("faceid");
  await refreshNativeUnlockCapability();
  expect(nativeUnlockStatus().available).toBe("touchid");
});

it.each([
  ["biometric_unlock_enroll", 60_000, () => biometricUnlock.enroll("slot", new Uint8Array(32))],
  ["biometric_unlock", 60_000, () => biometricUnlock.unlock("slot")],
  ["biometric_unlock_remove", 8000, () => biometricUnlock.remove("slot")],
] as const)("bounds a stalled %s IPC", async (command, deadline, invokeCommand) => {
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlock: "touchid" });
  vi.useFakeTimers();
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(() => {}));
  const stopped = expect(invokeCommand()).rejects.toMatchObject({ code: "failed" });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(command, expect.objectContaining({ vaultId: "slot" })));
  await vi.advanceTimersByTimeAsync(deadline);
  await stopped;
});

it("requests a fresh capability after a probe that started before enrollment", async () => {
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlockProbe: true });
  let finish!: (kind: string | null) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce("touchid");
  const startup = refreshNativeUnlockCapability();
  const afterEnrollment = refreshNativeUnlockCapability({ afterPending: true });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  finish(null);
  await Promise.all([startup, afterEnrollment]);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(nativeUnlockStatus().available).toBe("touchid");
});
