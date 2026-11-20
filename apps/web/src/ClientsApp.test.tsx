import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { setupDom } from "./ui/test-utils.js";
import ClientsApp from "./ClientsApp.js";

const db = vi.hoisted(() => ({ getAppDB: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("./db/index.js", () => db);
vi.mock("./pages/ClientsPage.js", () => ({ default: () => <main>Download Private Base</main> }));

const { render } = setupDom();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete window.__PRIVATEBASE_NATIVE_CAPABILITIES__;
});
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });

it("keeps the browser download page free of native OTA calls", async () => {
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true };
  await render(<ClientsApp />);
  await settle();
  expect(invoke).not.toHaveBeenCalled();
});

it("imports the channel and acknowledges readiness on a native direct load without opening the database", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true };
  let painted = "";
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "ui_bundle_ready") painted = document.body.textContent ?? "";
    return undefined as never;
  });
  await render(<ClientsApp />);
  // The platform module loads lazily; wait for the acknowledgement rather than a fixed delay.
  await act(async () => { await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("ui_bundle_ready", expect.anything())); });
  await settle();
  const commands = vi.mocked(invoke).mock.calls.map(([command]) => command);
  expect(commands).toContain("ui_bundle_initialize_channel");
  expect(commands.filter(command => command === "ui_bundle_ready")).toEqual(["ui_bundle_ready"]);
  expect(painted).toBe("Download Private Base");
  expect(db.getAppDB).not.toHaveBeenCalled();
});
