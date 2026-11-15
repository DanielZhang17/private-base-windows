import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootstrap } from "./bootstrap.js";
import { getLocale, i18n, initializeLocale, setLocalePreference, t } from "./i18n/index.js";
import { isNative } from "./platform/environment.js";

vi.mock("./platform/environment.js", () => ({ isNative: vi.fn(() => false) }));

vi.mock("./i18n/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./i18n/index.js")>(),
  initializeLocale: vi.fn(),
}));

beforeEach(() => { vi.mocked(initializeLocale).mockReset(); vi.mocked(isNative).mockReturnValue(false); });
afterEach(() => { vi.restoreAllMocks(); });

it("waits for the selected locale before rendering once", async () => {
  vi.mocked(initializeLocale).mockImplementationOnce(async () => { await setLocalePreference("fr"); });
  const render = vi.fn(() => {
    expect(getLocale()).toBe("fr");
    expect(t("language")).toBe("Langue");
  });
  await bootstrap(render);
  expect(render).toHaveBeenCalledTimes(1);
});

it("falls back to English before rendering when locale loading rejects", async () => {
  await setLocalePreference("de");
  vi.mocked(initializeLocale).mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"));
  const render = vi.fn(() => {
    expect(getLocale()).toBe("en");
    expect(t("language")).toBe("Language");
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });
  await expect(bootstrap(render)).resolves.toBeUndefined();
  expect(render).toHaveBeenCalledTimes(1);
});

it("still renders once when the English fallback also throws", async () => {
  vi.mocked(initializeLocale).mockRejectedValueOnce(new Error("Locale initialization failed"));
  const fallback = vi.spyOn(i18n, "changeLanguage").mockImplementationOnce(() => { throw new Error("Language engine unavailable"); });
  const render = vi.fn();
  await expect(bootstrap(render)).resolves.toBeUndefined();
  expect(fallback).toHaveBeenCalledWith("en");
  expect(render).toHaveBeenCalledTimes(1);
});

it.each([true, false])("configures page zoom before rendering only in native builds (%s)", async (native) => {
  vi.mocked(isNative).mockReturnValue(native);
  const viewport = document.createElement("meta");
  viewport.name = "viewport";
  const browserContent = "width=device-width, initial-scale=1.0, viewport-fit=cover";
  viewport.content = browserContent;
  const root = document.createElement("div");
  root.id = "root";
  document.head.append(viewport);
  document.body.append(root);
  try {
    await bootstrap(() => {
      expect(viewport.content).toBe(native ? "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" : browserContent);
      expect(root.style.touchAction ?? "").toBe(native ? "manipulation" : "");
    });
  } finally { viewport.remove(); root.remove(); }
});
