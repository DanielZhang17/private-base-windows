import { afterEach, describe, expect, it, vi } from "vitest";
import { isNative, platformName } from "./environment.js";
import { capabilities } from "./capabilities.js";

afterEach(() => vi.unstubAllGlobals());

describe("platform detection", () => {
  it.each(["tauri://localhost", "tauri://localhost/chat/1", "http://tauri.localhost", "https://tauri.localhost"])("detects the native origin %s", (url) => {
    vi.stubGlobal("window", { location: new URL(url) });
    expect(isNative()).toBe(true);
  });

  it.each(["https://chat.718788.xyz", "http://localhost:5173", "https://tauri.localhost.evil.test", "https://evil.test/tauri.localhost"])("leaves %s on the web path", (url) => {
    vi.stubGlobal("window", { location: new URL(url) });
    expect(isNative()).toBe(false);
    expect(platformName()).toBe("web");
  });

  it("detects the Tauri bridge on a development origin and tolerates no window", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, location: new URL("http://localhost:5173") });
    expect(isNative()).toBe(true);
    vi.stubGlobal("window", undefined);
    expect(isNative()).toBe(false);
    expect(platformName()).toBe("web");
  });

  it.each([
    ["Macintosh; Intel Mac OS X", "MacIntel", 0, "macos"],
    ["Windows NT 10.0", "Win32", 0, "windows"],
    ["Linux; Android 15", "Linux", 5, "android"],
    ["iPhone; CPU iPhone OS 18", "iPhone", 5, "ios"],
    ["Macintosh; Intel Mac OS X", "MacIntel", 5, "ios"],
  ])("identifies native %s", (userAgent, platform, maxTouchPoints, expected) => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("navigator", { userAgent, platform, maxTouchPoints });
    expect(platformName()).toBe(expected);
    expect(capabilities.saveFile).toBe(expected !== "android" && expected !== "ios");
  });

  it.each(["Android 15", "iPhone; CPU iPhone OS 18"])("keeps file saving enabled in the %s web browser", (userAgent) => {
    vi.stubGlobal("window", { location: new URL("https://chat.718788.xyz") });
    vi.stubGlobal("navigator", { userAgent });
    expect(platformName()).toBe("web");
    expect(capabilities.saveFile).toBe(true);
  });

  it("computes capabilities at access time and disables native passkeys", () => {
    const webWindow = { location: new URL("https://chat.718788.xyz"), PublicKeyCredential: class {} };
    vi.stubGlobal("window", webWindow);
    vi.stubGlobal("navigator", { credentials: { create() {}, get() {} } });
    vi.stubGlobal("Notification", class {});
    expect(capabilities.passkeys).toBe(true);
    expect(capabilities.systemNotifications).toBe(true);
    vi.stubGlobal("window", { ...webWindow, __TAURI_INTERNALS__: {} });
    vi.stubGlobal("Notification", undefined);
    expect(capabilities.passkeys).toBe(false);
    expect(capabilities.systemNotifications).toBe(true);
    vi.stubGlobal("window", { location: new URL("https://chat.718788.xyz") });
    expect(capabilities.passkeys).toBe(false);
    expect(capabilities.systemNotifications).toBe(false);
    expect(capabilities.e2eeCalls).toBe(false);
  });
});
