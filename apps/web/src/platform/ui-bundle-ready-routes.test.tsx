import { useEffect, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { setupDom } from "../ui/test-utils.js";
import type { AuthPhase } from "../features/chat/useAppPhase.js";

const state = vi.hoisted(() => ({ phase: "checking" as AuthPhase, acknowledged: [] as string[], imports: 0 }));
vi.mock("../features/chat/useAppPhase.js", () => ({
  useAuthPhase: () => state.phase, useAppLifecycle: () => {}, useDatabaseUpgradeBlocked: () => false,
}));
// Records the screen that was committed when the acknowledgement component mounted.
vi.mock("./UiBundleReady.js", () => ({ UiBundleChannelImport: () => { state.imports++; return null; }, UiBundleReady: function Recorder() {
  const { pathname } = useLocation();
  useEffect(() => { state.acknowledged.push(`${pathname}: ${document.body.textContent}`); }, [pathname]);
  return null;
} }));
vi.mock("../pages/LoginPage.js", () => ({ default: () => <main>Login screen</main> }));
vi.mock("../pages/UnlockPage.js", () => ({ default: () => <main>Unlock screen</main> }));
vi.mock("../components/layout/Layout.js", () => ({ default: () => <main>Chat list</main> }));
vi.mock("../features/calls/CallProvider.js", () => ({ CallProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../features/updates/UpdateProvider.js", () => ({ UpdateProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/app/SessionRepairEffects.js", () => ({ default: () => null }));
vi.mock("../components/app/WebPushEffects.js", () => ({ default: () => null }));
vi.mock("../components/app/UiPreferencesEffects.js", () => ({ default: () => null }));
vi.mock("../components/app/UnlockedAppEffects.js", () => ({ default: () => null }));

const { render } = setupDom();
beforeEach(() => { state.acknowledged = []; state.phase = "checking"; state.imports = 0; });
async function launch(phase: AuthPhase, path = "/") {
  const { default: App } = await import("../App.js");
  state.phase = phase;
  await render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

it("never acknowledges the startup loader or a redirect-only render", async () => {
  const { default: App } = await import("../App.js");
  await render(<MemoryRouter><App /></MemoryRouter>);
  expect(document.body.textContent).toBe("");
  expect(state.acknowledged).toEqual([]);
  // The channel import does not wait for a destination screen.
  expect(state.imports).toBeGreaterThan(0);
  state.phase = "database-error";
  await render(<MemoryRouter><App /></MemoryRouter>);
  expect(state.acknowledged).toEqual([]);
});

it.each([
  ["anonymous", "/", "/login: Login screen"],
  ["anonymous", "/unlock", "/login: Login screen"],
  ["locked", "/", "/unlock: Unlock screen"],
  ["locked", "/login", "/unlock: Unlock screen"],
  ["unlocked", "/login", "/: Chat list"],
  ["unlocked", "/unlock", "/: Chat list"],
] as const)("acknowledges only from the committed %s destination after leaving %s", async (phase, path, expected) => {
  await launch(phase, path);
  expect(state.acknowledged).toEqual([expected]);
});

it("acknowledges an unlocked chat list reached directly", async () => {
  await launch("unlocked");
  expect(state.acknowledged).toEqual(["/: Chat list"]);
});
