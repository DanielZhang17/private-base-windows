import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import { LOCALES } from "./locales.js";
const resources = import.meta.glob<Record<string, string>>("./locales/*.json", { eager: true, import: "default" });
const plurals = new Set(Object.keys(en).filter((key) => key.endsWith("_other")).map((key) => key.slice(0, -6)));
const variables = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();
describe.each(LOCALES)("$code resources", ({ code }) => {
  it("has exactly the source keys and every plural form required by Intl", () => {
    const resource = resources[`./locales/${code}.json`];
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    expect(Object.keys(resource).sort()).toEqual(Object.keys(en).sort());
    for (const base of plurals) for (const category of categories) expect(resource[`${base}_${category}`]).toBeDefined();
  });
  it("has nonempty text and preserves interpolation variables", () => {
    for (const [key, value] of Object.entries(resources[`./locales/${code}.json`])) {
      expect(value.trim(), key).not.toBe("");
      const source = en[key as keyof typeof en] ?? en[key.replace(/_(zero|two|few|many)$/, "_other") as keyof typeof en];
      expect(source, key).toBeDefined();
      expect(variables(value), key).toEqual(variables(source));
      expect(value, key).not.toMatch(/ZXQ|QXZ|⟪\d+⟫/);
      if (source.includes("Private Base")) expect(value).toContain("Private Base");
    }
  });
  it("gives the system settings path and limits the Finder override to macOS 14 and earlier", () => {
    const note = resources[`./locales/${code}.json`]["clients.macosNote"];
    expect(note).toMatch(/›.+macOS 14/u);
  });
});

it.each([
  ["zh-Hans", /[帳帐設鑰碼機簡發聯線讓關閉傳體網驗證刪檔]/],
  ["zh-Hant", /[账帐设钥码机简发联线让关传体验证删档]/],
] as const)("%s uses its own Chinese character variants", (locale, divergent) => {
  for (const [key, value] of Object.entries(resources[`./locales/${locale}.json`])) {
    expect(value, key).not.toMatch(divergent);
  }
});

it("preserves region-specific Portuguese UI vocabulary", () => {
  const br = resources["./locales/pt-BR.json"];
  const pt = resources["./locales/pt-PT.json"];
  expect(br.password).toBe("Senha");
  expect(pt.password).toBe("Palavra-passe");
  expect(br.fileTypeLabel).toBe("Arquivo");
  expect(pt.fileTypeLabel).toBe("Ficheiro");
  expect(br.shareScreen).toBe("Compartilhar tela");
  expect(pt.shareScreen).toBe("Partilhar ecrã");
});

it("localizes the new setup, approval, replacement and permanent-loss copy in each supported locale", () => {
  const keys = ["passkeySetup.passkeyHelp", "passkeySetup.skipPasswordBody", "replace.body",
    "deviceAlert.warning", "privacy.requireApprovalHelp", "unlock.invalidatedNoBackup",
    "security.passkeySignInBody", "security.passwordUnlockOn", "unlock.bodyPasskey",
    "devices.clientOnPlatform", "passkeySetup.otherDevicesWillSee", "passkeySetup.receiptTime",
    "passkeySetup.passwordOnceBody", "passkeySetup.choosePasswordBody", "chats.emptyLinkedConversation", "chats.historyOnOtherDevices"] as const;
  for (const { code } of LOCALES) {
    if (code === "en") continue;
    for (const key of keys) expect(resources[`./locales/${code}.json`][key], `${code}: ${key}`).not.toBe(en[key]);
  }
});
