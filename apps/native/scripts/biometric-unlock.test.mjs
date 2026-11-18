import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

it("preserves the Windows, biometric, and updater flags in either script order", () => {
  const source = read("../src-tauri/src/lib.rs");
  const template = source.match(/"(window\.__PRIVATEBASE_NATIVE_CAPABILITIES__ = Object\.assign[^\n]+)"/)[1];
  const updater = read("../src-tauri/src/update-capability.js");
  for (const biometricUnlock of [undefined, "windows-hello"]) {
    const windows = {
      captureProtection: "full", fileOpen: true, fileSave: "dialog", passkeyHandoff: true,
      ...(biometricUnlock ? { biometricUnlock } : {}),
    };
    const main = template.replace("{{}}", "{}").replace("{capabilities}", JSON.stringify(windows));
    for (const scripts of [[main, updater], [updater, main]]) {
      const window = { __PRIVATEBASE_NATIVE_CAPABILITIES__: { existing: true } };
      for (const script of scripts) runInNewContext(script, { window });
      expect(window.__PRIVATEBASE_NATIVE_CAPABILITIES__).toEqual({
        existing: true, ...windows, autoUpdate: "desktop",
      });
    }
  }
});

it("grants only the local Windows main window the three biometric commands", () => {
  const capability = JSON.parse(read("../src-tauri/capabilities/windows-biometric-unlock.json"));
  expect(capability.windows).toEqual(["main"]);
  expect(capability.platforms).toEqual(["windows"]);
  expect(capability.local).toBe(true);
  expect(capability.remote).toBeUndefined();
  const commands = ["biometric_unlock_enroll", "biometric_unlock", "biometric_unlock_remove"];
  expect(capability.permissions).toEqual(commands.map((command) => "allow-" + command.replaceAll("_", "-")));
  const permissions = read("../src-tauri/permissions/biometric-unlock.toml");
  for (const command of commands) expect(permissions).toContain(`commands.allow = ["${command}"]`);
});

it("only queries silent Hello readiness at startup and leaves credential creation to enroll", () => {
  const source = read("../src-tauri/src/biometric_unlock/windows_hello.rs");
  const probe = source.slice(source.indexOf("fn probe("), source.indexOf("fn offer_hello("));
  const readiness = source.slice(source.indexOf("fn hello_supported("), source.indexOf("fn has_saved_slot("));
  const enroll = source.slice(source.indexOf("fn enroll("), source.indexOf("fn unlock("));
  expect(probe).toContain("hello_supported()");
  expect(readiness).toContain("KeyCredentialManager::IsSupportedAsync()");
  expect(probe + readiness).not.toMatch(/open_credential|create_credential|require_tpm|Request(?:Create|Sign)|GetAttestationAsync|OpenAsync/);
  expect(enroll).toContain("create_credential(&name)");
  expect(enroll).toContain("require_tpm(&credential)");
  expect(enroll).not.toMatch(/hello_supported|IsSupportedAsync/);
});
