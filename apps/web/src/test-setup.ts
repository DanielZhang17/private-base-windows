import { beforeEach } from "vitest";
import { setLocalePreference } from "./i18n/index.js";
import type {} from "vitest/jsdom";
if (typeof jsdom !== "undefined") {
  Object.defineProperty(globalThis, "localStorage", { value: jsdom.window.localStorage, configurable: true });
}
// English copy remains the contract for existing tests and browser selectors.
await setLocalePreference("en");
beforeEach(async () => { await setLocalePreference("en"); });
