import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { useSyncExternalStore } from "react";
import en from "./locales/en.json";
import { isLocale, LOCALES, resolveSystemLocale, type Locale, type LocalePreference } from "./locales.js";
export { LOCALES, resolveSystemLocale } from "./locales.js";
export type { Locale, LocalePreference } from "./locales.js";
export { useTranslation };
export type TranslationKey = keyof typeof en;

export const LOCALE_STORAGE_KEY = "private-base:locale";
function readPreference(): LocalePreference {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : "system";
  } catch { return "system"; }
}
let preference = readPreference();
let systemLocale = resolveSystemLocale(typeof navigator === "undefined" ? [] : (navigator.languages ?? []));
const loaders = import.meta.glob<{ default: typeof en }>(["./locales/*.json", "!./locales/en.json"]);
const pending = new Map<Locale, Promise<void>>();
let revision = 0;
const listeners = new Set<() => void>();
function publish() { revision++; for (const listener of listeners) listener(); }

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: "en", fallbackLng: "en", supportedLngs: LOCALES.map(({ code }) => code),
  load: "currentOnly", initImmediate: false,
  keySeparator: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});
export const t = i18n.t.bind(i18n);
export { i18n };
export function getLocale(): Locale { return isLocale(i18n.language) ? i18n.language : "en"; }
function updateDocument() {
  if (typeof document === "undefined") return;
  const locale = getLocale();
  document.documentElement.lang = locale;
  document.documentElement.dir = LOCALES.find(({ code }) => code === locale)!.dir;
}
i18n.on("languageChanged", () => { updateDocument(); publish(); });
updateDocument();

export async function loadLocale(locale: Locale): Promise<void> {
  if (i18n.hasResourceBundle(locale, "translation")) return;
  let loading = pending.get(locale);
  if (!loading) {
    loading = loaders[`./locales/${locale}.json`]()
      .then((resource) => { i18n.addResourceBundle(locale, "translation", resource.default); })
      .finally(() => pending.delete(locale));
    pending.set(locale, loading);
  }
  await loading;
}
let changeId = 0;
export async function setLocalePreference(next: LocalePreference): Promise<void> {
  const id = ++changeId;
  preference = next;
  systemLocale = resolveSystemLocale(typeof navigator === "undefined" ? [] : (navigator.languages ?? []));
  try { localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* Device storage can be disabled. */ }
  publish();
  const locale = next === "system" ? systemLocale : next;
  try { await loadLocale(locale); } catch {
    if (id === changeId) await i18n.changeLanguage("en");
    return;
  }
  if (id === changeId) await i18n.changeLanguage(locale);
}
/** Awaited before the first React render, including on the authentication screens. */
export async function initializeLocale(): Promise<void> {
  await setLocalePreference(preference);
  // Route effects own the title after the first render.
  if (typeof document !== "undefined") document.title = t("appTitle");
}
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("languagechange", () => {
    if (preference === "system") void setLocalePreference("system");
  });
  window.addEventListener("storage", (event) => {
    if (event.key === LOCALE_STORAGE_KEY || event.key === null) void setLocalePreference(readPreference());
  });
}
export function useLocale() {
  useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision);
  return {
    preference, locale: getLocale(), systemLocale,
    systemLabel: LOCALES.find(({ code }) => code === systemLocale)!.label,
    setPreference: setLocalePreference,
  };
}
