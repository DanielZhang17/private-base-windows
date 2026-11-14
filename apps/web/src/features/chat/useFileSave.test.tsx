import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFileSave } from "./useFileSave.js";
import { capabilities } from "../../platform/capabilities.js";
import { saveFile, SaveUnsupportedError } from "../../platform/files.js";

vi.mock("../../platform/files.js", async (original) => ({ ...await original<object>(), saveFile: vi.fn(async () => {}) }));
let root: Root;
let state: ReturnType<typeof useFileSave>;
function Probe() { state = useFileSave(); return null; }
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("exposes the platform save capability before an action is attempted", async () => {
  vi.spyOn(capabilities, "saveFile", "get").mockReturnValue(false);
  await act(async () => root.render(<Probe />));
  expect(state.capabilities.saveFile).toBe(false);
  expect(state.saveUnsupported).toBe(true);
  expect(state.saveError).toBeNull();
  expect(saveFile).not.toHaveBeenCalled();
});

it("exposes typed unsupported errors as state for the view", async () => {
  await act(async () => root.render(<Probe />));
  const error = new SaveUnsupportedError();
  vi.mocked(saveFile).mockRejectedValueOnce(error);
  await act(async () => { await state.handleSave(new Blob(["file"]), "file.txt"); });
  expect(state.saveUnsupported).toBe(true);
  expect(state.saveError).toBe(error);
});

it("keeps successful saves and ordinary save failures available to the caller", async () => {
  await act(async () => root.render(<Probe />));
  const blob = new Blob(["file"]);
  await act(async () => { await state.handleSave(blob, "file.txt"); });
  expect(saveFile).toHaveBeenCalledExactlyOnceWith(blob, "file.txt");
  expect(state.saveUnsupported).toBe(false);
  vi.mocked(saveFile).mockRejectedValueOnce(new Error("Disk full"));
  await act(async () => { await expect(state.handleSave(blob, "file.txt")).rejects.toThrow("Disk full"); });
  expect(state.saveUnsupported).toBe(false);
  expect(state.saveError).toBeNull();
});
