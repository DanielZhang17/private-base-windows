import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { pnpmCommand } from "./pnpm.mjs";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "e2ee-native-build-"));
const fakePnpm = join(temporaryDirectory, "pnpm.cjs");
writeFileSync(fakePnpm, `
  console.log(JSON.stringify({ args: process.argv.slice(2), api: process.env.VITE_API_BASE_URL }));
  const failing = process.env.TEST_FAIL_ON;
  const fails = failing === undefined || process.argv.slice(2).join(" ").includes(failing);
  process.exit(fails ? Number(process.env.TEST_BUILD_STATUS || 0) : 0);
`);
// A non-JavaScript "pnpm" (stands in for @pnpm/exe): Node cannot parse it, so it
// only works when the hook executes it directly.
const nativePnpm = join(temporaryDirectory, "native install", "pnpm");
mkdirSync(dirname(nativePnpm));
writeFileSync(nativePnpm, `#!/bin/sh\necho "native:$*"\n`);
chmodSync(nativePnpm, 0o755);
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const calls = (result) => result.stdout.trim().split("\n").map((line) => JSON.parse(line));

const hook = (name, env) =>
  spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url))], { env, encoding: "utf8" });

function build(api, status = "0", failOn) {
  const env = { ...process.env, npm_execpath: fakePnpm, TEST_BUILD_STATUS: status };
  delete env.VITE_API_BASE_URL;
  delete env.TEST_FAIL_ON;
  if (failOn !== undefined) env.TEST_FAIL_ON = failOn;
  if (api !== undefined) env.VITE_API_BASE_URL = api;
  return hook("./build-web.mjs", env);
}

describe("native frontend build hook", () => {
  it.each([undefined, "", "  "])("uses the production API default for %j", (api) => {
    const result = build(api);
    expect(result.status).toBe(0);
    const api_ = "https://chat-api.718788.xyz";
    expect(calls(result)).toEqual([
      { args: ["--filter", "@e2ee-chat/web^...", "build"], api: api_ },
      { args: ["--filter", "@e2ee-chat/web", "exec", "tsc", "-b"], api: api_ },
      {
        args: ["--filter", "@e2ee-chat/web", "exec", "vite", "build", "--outDir", "dist-native", "--emptyOutDir"],
        api: api_,
      },
    ]);
  });

  it("passes a trimmed API override literally without shell interpolation", () => {
    const api = "https://preview.example.test/?value=$(literal)&other=`literal`";
    const result = build(`  ${api}  `);
    expect(result.status).toBe(0);
    expect(calls(result).map((call) => call.api)).toEqual([api, api, api]);
  });

  it("propagates a failed web build so Tauri cannot package stale assets", () => {
    expect(build(undefined, "23").status).toBe(23);
  });

  it("stops before bundling the frontend when a workspace dependency build fails", () => {
    const result = build(undefined, "17", "@e2ee-chat/web^...");
    expect(result.status).toBe(17);
    expect(calls(result)).toHaveLength(1);
  });

  it("fails when only the final frontend bundle fails", () => {
    const result = build(undefined, "19", "vite");
    expect(result.status).toBe(19);
    expect(calls(result)).toHaveLength(3);
  });
});

describe("pnpm invocation", () => {
  const steps = [
    "native:--filter @e2ee-chat/web^... build",
    "native:--filter @e2ee-chat/web exec tsc -b",
    "native:--filter @e2ee-chat/web exec vite build --outDir dist-native --emptyOutDir",
  ];

  it("runs a JavaScript npm_execpath through Node", () => {
    for (const path of ["/x/pnpm.cjs", "/x/pnpm.mjs", "/x/bin/pnpm.js"]) {
      expect(pnpmCommand(["a"], { npm_execpath: path })).toEqual({
        command: process.execPath, args: [path, "a"], shell: false,
      });
    }
  });

  it("executes a native npm_execpath directly", () => {
    expect(pnpmCommand(["a"], { npm_execpath: "C:\\pnpm\\pnpm.exe" }, "win32")).toEqual({
      command: "C:\\pnpm\\pnpm.exe", args: ["a"], shell: false,
    });
  });

  it("falls back to pnpm on PATH, through the .cmd shim's shell on Windows", () => {
    expect(pnpmCommand(["a^..."], {}, "linux")).toEqual({ command: "pnpm", args: ["a^..."], shell: false });
    expect(pnpmCommand(["a^..."], {}, "win32")).toEqual({ command: "pnpm", args: ['"a^..."'], shell: true });
  });

  it.skipIf(process.platform === "win32")("builds with a standalone pnpm executable", () => {
    const result = hook("./build-web.mjs", { ...process.env, npm_execpath: nativePnpm });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(steps);
  });

  it.skipIf(process.platform === "win32")("builds with pnpm from PATH when npm_execpath is unset", () => {
    const env = { ...process.env, PATH: `${dirname(nativePnpm)}${delimiter}${process.env.PATH}` };
    delete env.npm_execpath;
    const result = hook("./build-web.mjs", env);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(steps);
  });
});

describe("native dev hook", () => {
  const dev = (status = "0", failOn) => {
    const env = { ...process.env, npm_execpath: fakePnpm, TEST_BUILD_STATUS: status };
    delete env.VITE_API_BASE_URL;
    delete env.TEST_FAIL_ON;
    if (failOn !== undefined) env.TEST_FAIL_ON = failOn;
    return hook("./dev-web.mjs", env);
  };

  it("builds workspace dependencies, then starts Vite on the strict dev port without an API override", () => {
    const result = dev();
    expect(result.status).toBe(0);
    expect(calls(result)).toEqual([
      { args: ["--filter", "@e2ee-chat/web^...", "build"] },
      { args: ["--filter", "@e2ee-chat/web", "dev", "--host", "127.0.0.1", "--strictPort"] },
    ]);
  });

  it("does not start the dev server when a dependency build fails", () => {
    const result = dev("17", "@e2ee-chat/web^...");
    expect(result.status).toBe(17);
    expect(calls(result)).toHaveLength(1);
  });

  it("propagates a dev server failure after building dependencies", () => {
    const result = dev("29", "--strictPort");
    expect(result.status).toBe(29);
    expect(calls(result)).toHaveLength(2);
  });

  it("is the configured beforeDevCommand", () => {
    const config = JSON.parse(read("../src-tauri/tauri.conf.json"));
    expect(config.build.beforeDevCommand).toBe("node scripts/dev-web.mjs");
  });
});

describe("native workspace wiring", () => {
  it("grants only shared adapter permissions to the local main window on every platform", () => {
    const capability = JSON.parse(read("../src-tauri/capabilities/default.json"));
    expect(capability.windows).toEqual(["main"]);
    expect(capability.remote).toBeUndefined();
    expect(capability.platforms).toBeUndefined();
    expect(capability.permissions).toEqual([
      "core:app:allow-version",
      "notification:allow-is-permission-granted",
      "notification:allow-request-permission",
      "notification:allow-notify",
      "notification:allow-register-action-types",
      "notification:allow-register-listener",
      "clipboard-manager:allow-write-text",
      {
        identifier: "opener:allow-open-url",
        allow: [{ url: "https://*" }, { url: "http://*" }],
      },
    ]);
    // Save-only access also requires disabling the fs plugin's automatic drop scope.
    // The shared permission list above excludes all dialog and filesystem grants.
    const config = JSON.parse(read("../src-tauri/tauri.conf.json"));
    expect(config.plugins?.fs?.scopeDroppedPaths).toBe(false);
  });

  it("limits save dialogs and file writes to the local main window on desktop", () => {
    const capability = JSON.parse(read("../src-tauri/capabilities/desktop.json"));
    expect(capability.identifier).toBe("desktop");
    expect(capability.windows).toEqual(["main"]);
    expect(capability.remote).toBeUndefined();
    expect(capability.platforms).toEqual(["macOS", "windows", "linux"]);
    expect(capability.permissions).toEqual(["dialog:allow-save", "fs:allow-write-file"]);
  });

  it("limits the Windows passkey handoff to the local main window", () => {
    const capability = JSON.parse(read("../src-tauri/capabilities/windows-passkey.json"));
    expect(capability.windows).toEqual(["main"]);
    expect(capability.platforms).toEqual(["windows"]);
    expect(capability.remote).toBeUndefined();
    expect(capability.local).not.toBe(false);
    expect(capability.permissions).toEqual(["allow-passkey-handoff-start"]);
    // No deep-link getters/registration or event-listener grants to the renderer.
    const permission = read("../src-tauri/permissions/passkey-handoff.toml");
    expect(permission).toContain('commands.allow = ["passkey_handoff_start"]');
  });

  it("restricts updater wrappers and progress listeners to the local desktop main window", () => {
    const capability = JSON.parse(read("../src-tauri/capabilities/updater.json"));
    expect(capability.windows).toEqual(["main"]);
    expect(capability.remote).toBeUndefined();
    expect(capability.platforms).toEqual(["macOS", "windows", "linux"]);
    expect(capability.permissions).toEqual([
      "allow-update-check",
      "allow-update-download",
      "allow-update-install",
      "core:event:allow-listen",
      "core:event:allow-unlisten",
    ]);
    const config = JSON.parse(read("../src-tauri/tauri.conf.json"));
    expect(config.plugins.updater.endpoints).toBeUndefined();
    expect(config.plugins.updater.windows.installMode).toBe("passive");
    expect(config.plugins.updater.requireSignedVersion).toBe(true);
    expect(config.bundle.createUpdaterArtifacts).toBe(true);
  });

  it("merges the desktop update capability before application JavaScript runs", () => {
    const window = { __PRIVATEBASE_NATIVE_CAPABILITIES__: { passkeyHandoff: true } };
    const script = read("../src-tauri/src/update-capability.js");
    runInNewContext(script, { window });
    expect(window.__PRIVATEBASE_NATIVE_CAPABILITIES__).toEqual({
      passkeyHandoff: true, autoUpdate: "desktop",
    });
    const freshWindow = {};
    runInNewContext(script, { window: freshWindow });
    expect(freshWindow.__PRIVATEBASE_NATIVE_CAPABILITIES__).toEqual({ autoUpdate: "desktop" });
  });

  it("preserves native capabilities in either Windows/updater initialization order", () => {
    const source = read("../src-tauri/src/lib.rs");
    const template = source.match(/"(window\.__PRIVATEBASE_NATIVE_CAPABILITIES__ = Object\.assign[^\n]+)"/)[1];
    const updateScript = read("../src-tauri/src/update-capability.js");
    for (const passkeyHandoff of [false, true]) {
      const capabilities = { captureProtection: "full", fileOpen: true, fileSave: "dialog" };
      if (passkeyHandoff) capabilities.passkeyHandoff = true;
      const windowsScript = template.replace("{{}}", "{}").replace("{capabilities}", JSON.stringify(capabilities));
      for (const scripts of [[windowsScript, updateScript], [updateScript, windowsScript]]) {
        const existing = { backgroundConnection: true, nativeCallNotifications: true, otherCapability: "kept" };
        const window = { __PRIVATEBASE_NATIVE_CAPABILITIES__: { ...existing } };
        for (const script of scripts) runInNewContext(script, { window });
        expect(window.__PRIVATEBASE_NATIVE_CAPABILITIES__).toEqual({
          ...existing, ...capabilities, autoUpdate: "desktop",
        });
      }
    }
  });

  it("allows only the exact connection and avatar image sources in the CSP", () => {
    const config = JSON.parse(read("../src-tauri/tauri.conf.json"));
    expect(config.app.security.csp["connect-src"]).toBe(
      "'self' ipc: http://ipc.localhost https://chat.718788.xyz wss://chat.718788.xyz https://chat-api.718788.xyz wss://chat-api.718788.xyz https://dist.718788.xyz http://localhost:8787 ws://localhost:8787",
    );
    expect(config.app.security.csp["img-src"]).toBe(
      "'self' blob: data: https://chat.718788.xyz https://chat-api.718788.xyz https://genshin.jmp.blue https://api.dicebear.com",
    );
  });

  it("uses an identifier whose labels are valid for mobile projects", () => {
    const { identifier } = JSON.parse(read("../src-tauri/tauri.conf.json"));
    expect(identifier).toBe("xyz.chat718788.e2eechat");
    for (const label of identifier.split(".")) expect(label).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
  });

  const nativePackage = JSON.parse(read("../package.json"));
  const rootPackage = JSON.parse(read("../../../package.json"));
  const turbo = JSON.parse(read("../../../turbo.json"));

  it("embeds the dedicated, gitignored native frontend output", () => {
    const config = JSON.parse(read("../src-tauri/tauri.conf.json"));
    expect(config.build.frontendDist).toBe("../../web/dist-native");
    expect(read("./build-web.mjs")).toContain('NATIVE_OUT_DIR = "dist-native"');
    expect(read("../../../.gitignore").split("\n")).toContain("apps/web/dist-native/");
  });

  it("keeps native dev out of the generic turbo dev task", () => {
    expect(nativePackage.scripts.dev).toBeUndefined();
    expect(nativePackage.scripts["dev:native"]).toBe("tauri dev");
    expect(rootPackage.scripts["native:dev"]).toBe("pnpm --filter @e2ee-chat/native dev:native");
  });

  it("never caches the native build, preserves build order and passes signing env outside the hash", () => {
    expect(turbo.tasks["@e2ee-chat/native#build"]).toEqual({
      dependsOn: ["@e2ee-chat/web#build"],
      env: ["VITE_API_BASE_URL"],
      passThroughEnv: ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"],
      cache: false,
    });
  });
});
