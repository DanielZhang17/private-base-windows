import { describe, expect, it } from "vitest";
import { detectPlatform, platformLayout, type PlatformEnvironment } from "./platform.js";
import { isClientsPath } from "./routes.js";

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  chromeos: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};
const env = (userAgent: string, extra: Partial<PlatformEnvironment> = {}): PlatformEnvironment => ({ search: "", userAgent, ...extra });

describe("detectPlatform", () => {
  it.each<[string, PlatformEnvironment, ReturnType<typeof detectPlatform>]>([
    ["macOS Safari", env(UA.mac, { platform: "MacIntel", maxTouchPoints: 0 }), "macos"],
    ["macOS via userAgentData", env("Mozilla/5.0", { userAgentDataPlatform: "macOS" }), "macos"],
    ["Windows", env(UA.windows, { platform: "Win32" }), "windows"],
    ["Windows via userAgentData", env("Mozilla/5.0", { userAgentDataPlatform: "Windows" }), "windows"],
    ["Android", env(UA.android, { platform: "Linux armv8l", maxTouchPoints: 5 }), "android"],
    ["iPhone", env(UA.iphone, { platform: "iPhone", maxTouchPoints: 5 }), "ios"],
    ["iPad (mobile UA)", env(UA.ipad, { platform: "iPad", maxTouchPoints: 5 }), "ios"],
    ["iPadOS desktop mode (Mac UA with touch)", env(UA.mac, { platform: "MacIntel", maxTouchPoints: 5 }), "ios"],
    ["Linux", env(UA.linux, { platform: "Linux x86_64" }), "other"],
    ["ChromeOS", env(UA.chromeos, { userAgentDataPlatform: "Chrome OS" }), "other"],
    ["an empty user agent", env(""), "other"],
  ])("%s", (_label, environment, expected) => {
    expect(detectPlatform(environment)).toBe(expected);
  });

  it.each(["macos", "windows", "android", "ios"] as const)("?platform=%s overrides the user agent", (platform) => {
    expect(detectPlatform(env(UA.linux, { search: `?platform=${platform}` }))).toBe(platform);
    expect(detectPlatform(env(UA.android, { search: `?utm=x&platform=${platform.toUpperCase()}` }))).toBe(platform);
  });

  it("ignores an unknown ?platform= value", () => {
    expect(detectPlatform(env(UA.windows, { search: "?platform=linux" }))).toBe("windows");
    expect(detectPlatform(env(UA.mac, { search: "?platform=" }))).toBe("macos");
  });
});

describe("platformLayout ordering", () => {
  it.each([
    ["macos", "macos", ["windows", "android", "ios"]],
    ["windows", "windows", ["macos", "android", "ios"]],
    ["android", "android", ["macos", "windows", "ios"]],
    // A detected platform without a build is still featured first ("Coming soon").
    ["ios", "ios", ["macos", "windows", "android"]],
    // Linux and unknown: no misleading featured download; the web app leads and all four are listed.
    ["other", "web", ["macos", "windows", "android", "ios"]],
  ] as const)("%s features %s and lists the rest in fixed order", (detected, featured, others) => {
    const layout = platformLayout(detected);
    expect(layout.featured).toBe(featured);
    expect(layout.others).toEqual(others);
    expect(layout.others).not.toContain(layout.featured);
  });
});

it("recognises the public route", () => {
  expect(isClientsPath("/clients")).toBe(true);
  expect(isClientsPath("/clients/")).toBe(true);
  expect(isClientsPath("/clients/releases")).toBe(true);
  expect(isClientsPath("/clients/releases/")).toBe(true);
  expect(isClientsPath("/Clients/Releases//")).toBe(true);
  expect(isClientsPath("/clients/%72eleases")).toBe(true);
  expect(isClientsPath("/%63lients/%72eleases")).toBe(true);
  expect(isClientsPath("/CLIENTS//")).toBe(true);
  expect(isClientsPath("/clients/x")).toBe(false);
  expect(isClientsPath("/clients/releases/extra")).toBe(false);
  expect(isClientsPath("/clients%2Freleases")).toBe(false);
  expect(isClientsPath("/login")).toBe(false);
});
