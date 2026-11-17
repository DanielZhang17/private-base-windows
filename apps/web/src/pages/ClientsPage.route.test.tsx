import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {} from "vitest/jsdom";
import App from "../App.js";
import { capabilities } from "../platform/capabilities.js";
import { updates } from "../platform/updates.js";
import { UPDATE_INTERVAL } from "../features/updates/useUpdates.js";
import { useAuthStore } from "../stores/authStore.js";

vi.mock("../platform/updates.js", async importOriginal => ({
  ...await importOriginal<typeof import("../platform/updates.js")>(),
  updates: { getVersion: vi.fn(), check: vi.fn(), download: vi.fn(), install: vi.fn(), onProgress: vi.fn(), openPermissionSettings: vi.fn() },
}));
const keyState = vi.hoisted(() => {
  Object.defineProperty(globalThis, "localStorage", { value: jsdom.window.localStorage, configurable: true });
  return { loaded: false, hasKeys: true };
});
vi.mock("../lib/key-manager.js", () => ({
  keysLoaded: () => keyState.loaded,
  hasLocalKeyMaterial: async () => keyState.hasKeys,
  lockLocalCryptoState: vi.fn(() => { keyState.loaded = false; }),
  onKeysLocked: () => () => {},
}));
vi.mock("../pages/LoginPage.js", () => ({ default: () => <div>Login</div> }));
vi.mock("../pages/RegisterPage.js", () => ({ default: () => null }));
vi.mock("../pages/UnlockPage.js", () => ({ default: () => <div>Unlock</div> }));
vi.mock("../pages/ChatPage.js", () => ({ default: () => null }));
vi.mock("../pages/SettingsPage.js", () => ({ default: () => null }));
vi.mock("../pages/CallPage.js", () => ({ default: () => null }));
vi.mock("../pages/VerifyPage.js", () => ({ default: () => null }));
vi.mock("../pages/DeviceLinkPage.js", () => ({ default: () => null }));
vi.mock("../components/layout/Layout.js", () => ({ default: () => <div>Protected UI</div> }));
vi.mock("../components/app/UnlockedAppEffects.js", () => ({ default: () => null }));
vi.mock("../components/app/UiPreferencesEffects.js", () => ({ default: () => null }));
vi.mock("../components/app/SessionRepairEffects.js", () => ({ default: () => null }));
vi.mock("../components/app/WebPushEffects.js", () => ({ default: () => null }));
vi.mock("../components/app/useKeyMaintenance.js", () => ({ useKeyMaintenance: () => {} }));

let root: Root;
let container: HTMLDivElement;
let pathname = "";
let navigate: ReturnType<typeof useNavigate>;
function LocationProbe() {
  pathname = useLocation().pathname;
  navigate = useNavigate();
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updates.getVersion).mockResolvedValue("0.1.0");
  vi.mocked(updates.check).mockResolvedValue({ available: false });
  vi.mocked(updates.download).mockResolvedValue();
  vi.mocked(updates.onProgress).mockResolvedValue(vi.fn());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
  localStorage.clear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  useAuthStore.setState({ user: null, device: null, accessToken: null, refreshToken: null, sessionId: null } as never);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

const cases = [
  ["signed out", { accessToken: null, device: null }, false, true, "/login"],
  ["signed out without local keys", { accessToken: "token", device: { id: "device" } }, false, false, "/login"],
  ["locked", { accessToken: "token", device: { id: "device" }, user: { id: "alice" } }, false, true, "/unlock"],
  ["signed in and unlocked", { accessToken: "token", device: { id: "device" }, user: { id: "alice" } }, true, true, "/settings"],
] as const;

async function visit(path: string, auth: object, loaded: boolean, hasKeys: boolean) {
  keyState.loaded = loaded;
  keyState.hasKeys = hasKeys;
  useAuthStore.setState({ sessionId: "session", authEpoch: 1, ...auth } as never);
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}><LocationProbe /><App /></MemoryRouter>));
  await act(async () => { await Promise.resolve(); });
}

it.each(cases)("control: a protected route while %s ends on %s", async (_label, auth, loaded, hasKeys, expected) => {
  await visit("/settings", auth, loaded, hasKeys);
  expect(pathname).toBe(expected);
});

it.each(cases)("/clients is public when %s: no redirect to /login or /unlock", async (_label, auth, loaded, hasKeys) => {
  await visit("/clients", auth, loaded, hasKeys);
  expect(pathname).toBe("/clients");
  expect(container.querySelector("h1")?.textContent).toBe("Get Private Base");
  expect(container.textContent).not.toContain("Login");
  expect(container.textContent).not.toContain("Unlock");
});

it.each(["/clients", "/clients/"])("%s never checks, downloads or renders update UI in a capable native shell", async path => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("desktop");
  vi.mocked(updates.check).mockResolvedValue({ available: true, version: "0.1.1", mandatory: true });
  vi.useFakeTimers();
  await visit(path, { accessToken: null, device: null, user: null }, false, true);
  await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL); });
  expect(updates.check).not.toHaveBeenCalled(); expect(updates.download).not.toHaveBeenCalled();
  expect(updates.getVersion).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Update required");
  expect(container.querySelector('[aria-label="App update"]')).toBeNull();
});
it("stops the updater timer when navigating in-app to /clients", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("desktop");
  vi.useFakeTimers();
  await visit("/login", { accessToken: null, device: null, user: null }, false, true);
  expect(updates.check).toHaveBeenCalledOnce();
  await act(async () => navigate("/clients"));
  await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL); });
  expect(pathname).toBe("/clients");
  expect(updates.check).toHaveBeenCalledOnce(); expect(updates.download).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="App update"]')).toBeNull();
});
it("does not start a download if an earlier check resolves after navigation to /clients", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("desktop");
  let finish!: (result: { available: boolean; version: string }) => void;
  vi.mocked(updates.check).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await visit("/login", { accessToken: null, device: null, user: null }, false, true);
  await act(async () => navigate("/clients"));
  await act(async () => finish({ available: true, version: "0.1.1" }));
  expect(updates.download).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="App update"]')).toBeNull();
});
