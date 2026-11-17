import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Windows capture protection", () => {
  it("merges the pre-JS capability without losing other native keys", () => {
    // Execute the actual Rust format string with each serialized flag payload.
    const source = read("../src-tauri/src/lib.rs");
    const template = source.match(/"(window\.__PRIVATEBASE_NATIVE_CAPABILITIES__ = Object\.assign[^\n]+)"/)[1];
    for (const passkeyHandoff of [false, true]) {
      const capabilities = { captureProtection: "full", fileOpen: true, fileSave: "dialog" };
      if (passkeyHandoff) capabilities.passkeyHandoff = true;
      const script = template.replace("{{}}", "{}").replace("{capabilities}", JSON.stringify(capabilities));
      for (const existing of [undefined, { otherCapability: "kept" }]) {
        const window = { __PRIVATEBASE_NATIVE_CAPABILITIES__: existing };
        runInNewContext(script, { window });
        expect(window.__PRIVATEBASE_NATIVE_CAPABILITIES__).toEqual({ ...existing, ...capabilities });
        if (existing) expect(window.__PRIVATEBASE_NATIVE_CAPABILITIES__).toBe(existing);
      }
    }
  });

  it("starts with content protection and grants only the local main window command", () => {
    const config = JSON.parse(read("../src-tauri/tauri.windows.conf.json"));
    expect(config.app.windows.find((window) => window.label === "main")).toMatchObject({
      create: false,
      contentProtected: true,
    });
    const capability = JSON.parse(read("../src-tauri/capabilities/windows-capture-protection.json"));
    expect(capability.windows).toEqual(["main"]);
    expect(capability.platforms).toEqual(["windows"]);
    expect(capability.remote).toBeUndefined();
    expect(capability.local).not.toBe(false);
    expect(capability.permissions).toEqual(["allow-get-capture-protection", "allow-set-capture-protection"]);
    const permission = read("../src-tauri/permissions/capture-protection.toml");
    expect(permission).toContain('commands.allow = ["get_capture_protection"]');
    expect(permission).toContain('commands.allow = ["set_capture_protection"]');
  });
});
