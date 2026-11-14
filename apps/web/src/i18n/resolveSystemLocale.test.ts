import { expect, it } from "vitest";
import { resolveSystemLocale } from "./locales.js";
it.each([
  [[], "en"], [["ar-SA", "xx"], "en"], [["xx", "de-CH", "ja"], "de"],
  [["en-GB", "fr"], "en"], [["fr-CA"], "fr"], [["es-MX"], "es"], [["it-IT"], "it"], [["ru-RU"], "ru"],
  [["ja-JP"], "ja"], [["ko-KR"], "ko"],
  [["zh"], "zh-Hans"], [["zh-CN"], "zh-Hans"], [["zh-SG"], "zh-Hans"],
  [["zh-Hans"], "zh-Hans"], [["zh-Hans-HK"], "zh-Hans"], [["ZH_hans_CN"], "zh-Hans"],
  [["zh-TW"], "zh-Hant"], [["zh-HK"], "zh-Hant"], [["zh-MO"], "zh-Hant"],
  [["zh-Hant"], "zh-Hant"], [["zh-Hant-CN"], "zh-Hant"], [["zh-Hant-HK-u-nu-hanidec"], "zh-Hant"],
  [["pt"], "pt-BR"], [["pt-BR"], "pt-BR"], [["PT_br"], "pt-BR"],
  [["pt-PT"], "pt-PT"], [["pt-AO"], "pt-PT"], [["pt-MZ"], "pt-PT"], [["pt-CV"], "pt-PT"],
  [["unsupported", "zh-TW", "pt"], "zh-Hant"], [["", "fr"], "fr"],
] as const)("resolves %j to %s", (languages, expected) => {
  expect(resolveSystemLocale(languages)).toBe(expected);
});
