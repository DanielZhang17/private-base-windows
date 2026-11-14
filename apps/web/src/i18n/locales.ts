export const LOCALES = [
  { code: "en", label: "English", dir: "ltr" },
  { code: "zh-Hans", label: "简体中文", dir: "ltr" },
  { code: "zh-Hant", label: "繁體中文", dir: "ltr" },
  { code: "ja", label: "日本語", dir: "ltr" },
  { code: "ko", label: "한국어", dir: "ltr" },
  { code: "de", label: "Deutsch", dir: "ltr" },
  { code: "es", label: "Español", dir: "ltr" },
  { code: "fr", label: "Français", dir: "ltr" },
  { code: "pt-BR", label: "Português (Brasil)", dir: "ltr" },
  { code: "pt-PT", label: "Português (Portugal)", dir: "ltr" },
  { code: "it", label: "Italiano", dir: "ltr" },
  { code: "ru", label: "Русский", dir: "ltr" },
] as const;
export type Locale = typeof LOCALES[number]["code"];
export type LocalePreference = "system" | Locale;
export function isLocale(value: unknown): value is Locale {
  return LOCALES.some(({ code }) => code === value);
}

/** First supported language wins; unsupported entries do not hide later preferences. */
export function resolveSystemLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const [base, ...parts] = language.toLowerCase().replaceAll("_", "-").split("-");
    if (base === "zh") {
      if (parts.includes("hant")) return "zh-Hant";
      if (parts.includes("hans")) return "zh-Hans";
      return parts.some((part) => ["tw", "hk", "mo"].includes(part)) ? "zh-Hant" : "zh-Hans";
    }
    if (base === "pt") {
      const region = parts.find((part) => /^[a-z]{2}$/.test(part));
      return !region || region === "br" ? "pt-BR" : "pt-PT";
    }
    if (isLocale(base)) return base;
  }
  return "en";
}
