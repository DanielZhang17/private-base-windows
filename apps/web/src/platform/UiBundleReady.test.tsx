import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getAppDB } from "../db/index.js";
import { UiBundleChannelImport, UiBundleReady } from "./UiBundleReady.js";
import { UPDATE_CHANNEL_KEY, uiBundles } from "./updates.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../db/index.js", () => ({ getAppDB: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.removeItem(UPDATE_CHANNEL_KEY);
  delete window.__PRIVATEBASE_NATIVE_CAPABILITIES__;
  delete window.__PRIVATEBASE_UI_BUNDLE__;
});

function nativeShell() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true };
  window.__PRIVATEBASE_UI_BUNDLE__ = { appVersion: "0.1.3", uiVersion: "1.0.1", uiSource: "ota" };
}

/** Lets queued animation frames and the task after them run, i.e. the committed screen paints. */
async function paint() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}

it("waits for a rendered frame (animation frame, then a task) and does not acknowledge when IndexedDB fails", async () => {
  nativeShell();
  const root = createRoot(document.createElement("div"));
  vi.mocked(getAppDB).mockRejectedValue(new Error("IndexedDB failed"));
  let frame: FrameRequestCallback | undefined;
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frame = callback; return 1; });
  await act(async () => { root.render(<UiBundleReady />); });
  expect(getAppDB).not.toHaveBeenCalled();
  raf.mockRestore();
  // The animation frame runs before its paint; the check waits for the task after it.
  await act(async () => { frame!(0); });
  expect(getAppDB).not.toHaveBeenCalled();
  await paint();
  expect(getAppDB).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => { root.unmount(); });
});

it("does not acknowledge a screen that unmounts before it paints", async () => {
  nativeShell();
  vi.mocked(getAppDB).mockResolvedValue({} as Awaited<ReturnType<typeof getAppDB>>);
  const root = createRoot(document.createElement("div"));
  await act(async () => { root.render(<UiBundleReady />); root.unmount(); });
  await paint();
  expect(getAppDB).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it("acknowledges once under StrictMode only after a destination screen commits and IndexedDB opens", async () => {
  nativeShell();
  localStorage.setItem(UPDATE_CHANNEL_KEY, "beta");

  const host = document.createElement("div");
  const root = createRoot(host);
  let finish!: () => void;
  vi.mocked(getAppDB).mockReturnValue(new Promise(resolve => {
    finish = () => resolve({} as Awaited<ReturnType<typeof getAppDB>>);
  }));
  vi.mocked(invoke).mockImplementation(async () => {
    expect(host.textContent).toBe("Unlock screen");
    return undefined as never;
  });
  await act(async () => {
    root.render(<StrictMode><main>Unlock screen</main><UiBundleReady /></StrictMode>);
  });
  await paint();
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => { finish(); });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("ui_bundle_ready", { channel: "beta" });
  // A later destination (for example the chat list after unlocking) reuses the acknowledgement.
  await act(async () => { root.render(<StrictMode><main>Chat list</main><UiBundleReady key="chats" /></StrictMode>); });
  await paint();
  expect(invoke).toHaveBeenCalledOnce();
  expect(uiBundles.getActive()).toEqual({ appVersion: "0.1.3", uiVersion: "1.0.1", uiSource: "ota" });
  vi.mocked(invoke).mockResolvedValue(undefined);
  await uiBundles.setChannel("stable");
  expect(invoke).toHaveBeenLastCalledWith("ui_bundle_set_channel", { channel: "stable" });
  await act(async () => { root.unmount(); });
});

it("imports the saved channel from the app root without waiting for IndexedDB or a destination screen", async () => {
  nativeShell();
  localStorage.setItem(UPDATE_CHANNEL_KEY, "beta");
  vi.mocked(getAppDB).mockReturnValue(new Promise(() => {}));
  const root = createRoot(document.createElement("div"));
  await act(async () => { root.render(<UiBundleChannelImport />); });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("ui_bundle_initialize_channel", { channel: "beta" });
  expect(getAppDB).not.toHaveBeenCalled();
  await act(async () => { root.unmount(); });
});

it("imports the channel but skips readiness in the no-ready test build", async () => {
  nativeShell();
  vi.stubEnv("VITE_OTA_TEST_NO_READY", "1");
  const root = createRoot(document.createElement("div"));
  await act(async () => { root.render(<><UiBundleChannelImport /><UiBundleReady /></>); });
  await paint();
  expect(getAppDB).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("ui_bundle_initialize_channel", { channel: "stable" });
  await act(async () => { root.unmount(); });
});

it("ignores advertised OTA state in a browser and does not invoke native commands", async () => {
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true };
  window.__PRIVATEBASE_UI_BUNDLE__ = { appVersion: "0.1.3", uiVersion: "1.0.0", uiSource: "embedded" };
  expect(uiBundles.getActive()).toBeUndefined();
  expect(uiBundles.ready()).toBeUndefined();
  await uiBundles.setChannel("beta");
  expect(invoke).not.toHaveBeenCalled();
});

it("reports the embedded UI version on a boot after OTA rollback", () => {
  nativeShell();
  expect(uiBundles.getActive()).toEqual({ appVersion: "0.1.3", uiVersion: "1.0.1", uiSource: "ota" });
  window.__PRIVATEBASE_UI_BUNDLE__ = { appVersion: "0.1.3", uiVersion: "1.0.0", uiSource: "embedded" };
  expect(uiBundles.getActive()).toEqual({ appVersion: "0.1.3", uiVersion: "1.0.0", uiSource: "embedded" });
});
