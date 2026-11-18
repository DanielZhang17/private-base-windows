import { afterEach, expect, it, vi } from "vitest";
import { buildDefaultDeviceName } from "./device-link.js";
import { setLocalePreference } from "../i18n/index.js";

afterEach(() => vi.unstubAllGlobals());

const chromeOnMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const safariOniPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1";
const safariOnMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15";

it.each([
  [{ userAgent: chromeOnMac }, "Chrome on macOS"],
  [{ userAgent: safariOniPhone }, "Safari on iPhone"],
  [{ userAgent: safariOniPhone.replace("(iPhone;", "(iPod touch;") }, "Safari on iPod touch"],
  [{ userAgent: safariOnMac, platform: "MacIntel", maxTouchPoints: 5 }, "Safari on iPad"],
  [{ userAgent: chromeOnMac + " Edg/131.0.0.0" }, "Edge on macOS"],
  [{ userAgentData: { platform: "Windows", brands: [{ brand: "Chromium" }, { brand: "Microsoft Edge" }] } }, "Edge on Windows"],
  [{ userAgentData: { platform: "macOS", brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }] } }, "Chrome on macOS"],
  [{ userAgent: chromeOnMac, userAgentData: { platform: "macOS", brands: [{ brand: "Chromium" }] } }, "Chromium on macOS"],
  [{ userAgent: chromeOnMac, userAgentData: { platform: "macOS", brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }] } }, "Chrome on macOS"],
  [{ userAgent: "" }, "Browser"],
] as const)("labels a device from its browser and platform (%s)", (browserInfo, expected) => {
  vi.stubGlobal("navigator", browserInfo);
  expect(buildDefaultDeviceName()).toBe(expected);
});

it("localizes the browser and platform label when it is created", async () => {
  await setLocalePreference("fr");
  vi.stubGlobal("navigator", { userAgent: safariOniPhone });
  expect(buildDefaultDeviceName()).toBe("Safari sur iPhone");
});
