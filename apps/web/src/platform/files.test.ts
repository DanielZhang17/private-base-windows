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

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
it.each(["Android 15", "iPhone; CPU iPhone OS 18"])("enables advertised mobile saving on %s", async (userAgent) => {
  vi.stubGlobal("navigator", { userAgent, platform: "", maxTouchPoints: 5 });
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { fileSave: "share", fileOpen: true };
  const { saveFile, openFile } = await import("./files.js");
  const { capabilities } = await import("./capabilities.js");
  expect(capabilities.saveFile).toBe(true);
  const bytes = new Uint8Array([1, 2, 3]);
  const blob = { type: "application/pdf", arrayBuffer: async () => bytes.buffer } as Blob;
  invoke.mockResolvedValueOnce("saved");
  await expect(saveFile(blob, "private.pdf")).resolves.toBe("saved");
  expect(invoke).toHaveBeenLastCalledWith("save_file", bytes, { headers: { "x-file-name": "private.pdf", "x-mime-type": "application/pdf" } });
  await openFile(blob, "private.pdf", "application/pdf");
  expect(invoke).toHaveBeenLastCalledWith("open_file", bytes, { headers: { "x-file-name": "private.pdf", "x-mime-type": "application/pdf" } });
  expect(dialogImport).not.toHaveBeenCalled();
  expect(fsImport).not.toHaveBeenCalled();
});
it.each(["dialog", "downloads", "share"] as const)("preserves %s save and cancel outcomes and propagates failures", async (fileSave) => {
  vi.stubGlobal("navigator", { userAgent: "Android", platform: "", maxTouchPoints: 5 });
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { fileSave };
  const { saveFile } = await import("./files.js");
  const blob = { type: "text/plain", arrayBuffer: async () => new ArrayBuffer(0) } as Blob;
  invoke.mockResolvedValueOnce("saved");
  await expect(saveFile(blob, "a.txt")).resolves.toBe("saved");
  invoke.mockResolvedValueOnce("cancelled");
  await expect(saveFile(blob, "a.txt")).resolves.toBe("cancelled");
  invoke.mockRejectedValueOnce("write_failed");
  await expect(saveFile(blob, "a.txt")).rejects.toBe("write_failed");
  expect(invoke).toHaveBeenCalledTimes(3);
});
it.each(["unsupported", "no_app", "cancelled", "blocked"])("propagates native open rejection %s", async (code) => {
  vi.stubGlobal("navigator", { userAgent: "Android", platform: "", maxTouchPoints: 5 });
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { fileOpen: true };
  const { openFile } = await import("./files.js");
  invoke.mockRejectedValueOnce(code);
  await expect(openFile({ arrayBuffer: async () => new ArrayBuffer(0) } as Blob, "a.pdf", "application/pdf")).rejects.toBe(code);
});
it("uses the legacy desktop save dialog when fileOpen is absent", async () => {
  vi.stubGlobal("navigator", { userAgent: "Windows", platform: "Win32", maxTouchPoints: 0 });
  const { openFile } = await import("./files.js");
  await openFile({ arrayBuffer: async () => new ArrayBuffer(0) } as Blob, "a.pdf", "application/pdf");
  expect(save).toHaveBeenCalledWith({ defaultPath: "a.pdf" });
  expect(invoke).not.toHaveBeenCalled();
});

it("uses a raw Uint8Array body and percent-encoded filename headers for native file commands", async () => {
  vi.stubGlobal("navigator", { userAgent: "Windows", platform: "Win32", maxTouchPoints: 0 });
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { fileOpen: true, fileSave: "dialog" };
  const bytes = new Uint8Array([0, 127, 255]);
  const blob = { type: "text/plain", arrayBuffer: async () => bytes.buffer } as Blob;
  const { openFile, saveFile } = await import("./files.js");
  const name = "résumé #1 %.txt";
  await openFile(blob, name, "text/plain");
  await saveFile(blob, name);
  for (const [command, body, options] of invoke.mock.calls) {
    expect(["open_file", "save_file"]).toContain(command);
    expect(body).toBeInstanceOf(Uint8Array);
    expect(Array.isArray(body)).toBe(false);
    expect(body).toEqual(bytes);
    expect(options).toEqual({ headers: { "x-file-name": encodeURIComponent(name), "x-mime-type": "text/plain" } });
    expect(body).not.toHaveProperty("bytes");
  }
});
