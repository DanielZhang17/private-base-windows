import { afterEach, beforeEach, expect, it, vi } from "vitest";

const dialogImport = vi.fn();
const fsImport = vi.fn();
const save = vi.fn();
const writeFile = vi.fn();
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.doMock("@tauri-apps/plugin-dialog", () => { dialogImport(); return { save }; });
  vi.doMock("@tauri-apps/plugin-fs", () => { fsImport(); return { writeFile }; });
  save.mockResolvedValue("/chosen/private.bin");
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});
afterEach(() => {
  vi.doUnmock("@tauri-apps/plugin-dialog"); vi.doUnmock("@tauri-apps/plugin-fs");
  vi.unstubAllGlobals();
});

it.each([
  ["Android 15", "Linux", 5],
  ["iPhone; CPU iPhone OS 18", "iPhone", 5],
  ["Macintosh; Intel Mac OS X", "MacIntel", 5],
])("rejects saving on native %s without importing dialog or fs", async (userAgent, platform, maxTouchPoints) => {
  vi.stubGlobal("navigator", { userAgent, platform, maxTouchPoints });
  const arrayBuffer = vi.fn();
  const { saveFile, SaveUnsupportedError } = await import("./files.js");
  const error = await saveFile({ arrayBuffer } as unknown as Blob, "private.bin").catch((error: unknown) => error);
  expect(dialogImport).not.toHaveBeenCalled();
  expect(fsImport).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(error).toBeInstanceOf(SaveUnsupportedError);
  expect(error).toMatchObject({ name: "SaveUnsupportedError", code: "SAVE_UNSUPPORTED" });
});

it.each([
  ["Macintosh; Intel Mac OS X", "MacIntel"],
  ["Windows NT 10.0", "Win32"],
])("keeps selected-path saving on native desktop %s", async (userAgent, platform) => {
  vi.stubGlobal("navigator", { userAgent, platform, maxTouchPoints: 0 });
  const bytes = new Uint8Array([1, 2, 3]);
  const { saveFile } = await import("./files.js");
  await saveFile({ arrayBuffer: async () => bytes.buffer } as Blob, "private.bin");
  expect(dialogImport).toHaveBeenCalledTimes(1);
  expect(fsImport).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledExactlyOnceWith({ defaultPath: "private.bin" });
  expect(writeFile).toHaveBeenCalledExactlyOnceWith("/chosen/private.bin", bytes);
});
