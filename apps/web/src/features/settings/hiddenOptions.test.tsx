import { act } from "react";
import { getByRole, queryByText } from "@testing-library/dom";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { click, setupDom } from "../../ui/test-utils.js";
import { queryClient } from "../../lib/query-client.js";
import { CaptureProtectionGate } from "./CaptureProtectionGate.js";
import {
  captureToggleGated, createSecretTapCounter, ensureHiddenCaptureProtection, resetCaptureGuardForTests, unlockCaptureToggle,
  useCaptureToggleHidden,
} from "./hiddenOptions.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { render, container } = setupDom();
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
let hidden: boolean | undefined;
function Probe() { hidden = useCaptureToggleHidden(); return null; }
function nativeDevice(userAgent: string, captureProtection: string | null = "full") {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", captureProtection ? { captureProtection } : {});
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
}
const nativeProtection = (enabled: boolean) => vi.mocked(invoke).mockImplementation(async command =>
  command === "get_capture_protection" ? { enabled } : undefined);
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const gate = () => render(<CaptureProtectionGate><p>Secret chats</p></CaptureProtectionGate>);

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  nativeProtection(false);
  localStorage.removeItem("pb.captureToggleUnlocked");
  resetCaptureGuardForTests();
  queryClient.clear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("unlocks only after seven taps inside the time window", () => {
  vi.useFakeTimers();
  const onUnlock = vi.fn();
  const tap = createSecretTapCounter(onUnlock);
  for (let i = 0; i < 6; i++) { tap(); vi.advanceTimersByTime(400); }
  vi.advanceTimersByTime(2000); // the first taps fall out of the 3 s window
  tap();
  expect(onUnlock).not.toHaveBeenCalled();
  for (let i = 0; i < 6; i++) { tap(); vi.advanceTimersByTime(100); }
  expect(onUnlock).toHaveBeenCalledOnce();
  tap(); // the count starts over after an unlock
  expect(onUnlock).toHaveBeenCalledOnce();
});

it("gates the switch only in the Android native app with capture protection", () => {
  expect(captureToggleGated()).toBe(false); // web
  nativeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15");
  expect(captureToggleGated()).toBe(false);
  nativeDevice(WINDOWS_UA);
  expect(captureToggleGated()).toBe(false);
  nativeDevice(ANDROID_UA, null);
  expect(captureToggleGated()).toBe(false);
  nativeDevice(ANDROID_UA);
  expect(captureToggleGated()).toBe(true);
});

it("shows content straight away and leaves protection alone where the switch is visible", async () => {
  nativeDevice(WINDOWS_UA);
  await gate();
  await settle();
  expect(container().textContent).toBe("Secret chats");
  expect(invoke).not.toHaveBeenCalled();
});

it("covers chats until protection an older build turned off is back on", async () => {
  nativeDevice(ANDROID_UA);
  let finish!: () => void;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "get_capture_protection") return { enabled: false };
    await new Promise<void>(resolve => { finish = resolve; });
  });
  await gate();
  await settle();
  expect(queryByText(container(), "Secret chats")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("set_capture_protection", { enabled: true });
  await act(async () => finish());
  await settle();
  expect(container().textContent).toBe("Secret chats");
  expect(queryClient.getQueryData(["capture-protection"])).toBe(true);
});

it("does not rewrite protection that is already on", async () => {
  nativeDevice(ANDROID_UA);
  nativeProtection(true);
  await gate();
  await settle();
  expect(container().textContent).toBe("Secret chats");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("get_capture_protection");
});

it("keeps chats covered with a visible retry when protection cannot be confirmed", async () => {
  nativeDevice(ANDROID_UA);
  vi.mocked(invoke).mockRejectedValue(new Error("bridge down"));
  await gate();
  await settle();
  expect(queryByText(container(), "Secret chats")).toBeNull();
  expect(container().textContent).toContain("Screenshot protection couldn't be turned on.");
  nativeProtection(true);
  await click(getByRole(container(), "button", { name: "Retry" }));
  await settle();
  expect(container().textContent).toBe("Secret chats");
});

it("treats a stalled native bridge as a failure and lets the user continue knowingly", async () => {
  nativeDevice(ANDROID_UA);
  vi.useFakeTimers();
  vi.mocked(invoke).mockImplementation(() => new Promise(() => undefined));
  await gate();
  expect(queryByText(container(), "Secret chats")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(container().textContent).toContain("Screenshot protection couldn't be turned on.");
  await click(getByRole(container(), "button", { name: "Continue without protection" }));
  expect(container().textContent).toBe("Secret chats");
});

it("checks once per session", async () => {
  nativeDevice(ANDROID_UA);
  nativeProtection(true);
  await ensureHiddenCaptureProtection();
  await gate();
  expect(container().textContent).toBe("Secret chats");
  expect(invoke).toHaveBeenCalledOnce();
});

it("persists the unlock and reveals the switch on this device", async () => {
  nativeDevice(ANDROID_UA);
  await render(<Probe />);
  expect(hidden).toBe(true);
  await act(async () => unlockCaptureToggle());
  expect(hidden).toBe(false);
  expect(localStorage.getItem("pb.captureToggleUnlocked")).toBe("1");
  resetCaptureGuardForTests(); // a new session still finds the stored unlock
  vi.mocked(invoke).mockClear();
  await gate();
  await settle();
  expect(container().textContent).toBe("Secret chats");
  expect(invoke).not.toHaveBeenCalled(); // no longer enforced once the user can see the switch
});
