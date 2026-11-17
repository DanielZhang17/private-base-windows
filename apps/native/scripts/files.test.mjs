import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

it("grants only local Windows main-window access to the three file commands", () => {
  const capability = JSON.parse(read("../src-tauri/capabilities/windows-files.json"));
  expect(capability.windows).toEqual(["main"]);
  expect(capability.platforms).toEqual(["windows"]);
  expect(capability.remote).toBeUndefined();
  expect(capability.local).not.toBe(false);
  expect(capability.permissions).toEqual([
    "allow-open-file",
    "allow-save-file",
    "allow-clear-open-cache",
  ]);
  const permissions = read("../src-tauri/permissions/files.toml");
  for (const command of ["open_file", "save_file", "clear_open_cache"]) {
    expect(permissions).toContain(`identifier = "allow-${command.replaceAll("_", "-")}"`);
    expect(permissions).toContain(`commands.allow = ["${command}"]`);
  }
});

it("dispatches file admission synchronously without Tauri's async command wrapper", () => {
  const files = read("../src-tauri/src/files.rs");
  const lib = read("../src-tauri/src/lib.rs");
  expect(files).toContain("pub(crate) fn dispatch(invoke: Invoke) -> bool");
  for (const command of ["open_file", "save_file", "clear_open_cache"]) {
    expect(files).toContain(`\nfn ${command}(`);
    expect(files).not.toContain(`async fn ${command}(`);
  }
  expect(lib).toContain('"open_file" | "save_file" | "clear_open_cache" => files::dispatch(invoke)');
  const generated = lib.match(/let other_commands[^;]+tauri::generate_handler!\[([\s\S]*?)\]/)[1];
  expect(generated).not.toContain("files::");
});
