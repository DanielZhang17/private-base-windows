import { act, useEffect } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {} from "vitest/jsdom";
import App from "../../App.js";
import { resetLocalCryptoState } from "../../lib/key-manager.js";
import { useAuthStore } from "../../stores/authStore.js";
import { api } from "../../services/api.js";
import { useKeyMaintenance } from "../app/useKeyMaintenance.js";
import { useOutgoingQueue } from "../../features/chat/useOutgoingQueue.js";
import { click, setupDom } from "../../ui/test-utils.js";

const keyState = vi.hoisted(() => {
  Object.defineProperty(globalThis, "localStorage", { value: jsdom.window.localStorage, configurable: true });
  return { loaded: true, unlockedEffects: 0 };
});
vi.mock("../../lib/key-manager.js", () => ({
  keysLoaded: () => keyState.loaded,
  hasLocalKeyMaterial: async () => true,
  resetLocalCryptoState: vi.fn(),
  lockLocalCryptoState: vi.fn(() => { keyState.loaded = false; }),
  // The real manual lock does not notify these listeners; idle lock does.
  onKeysLocked: () => () => {},
}));
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() }, resolveApiUrl: (path: string) => path }));
vi.mock("../../pages/LoginPage.js", () => ({ default: () => <h1>Sign in</h1> }));
vi.mock("../../pages/RegisterPage.js", () => ({ default: () => null }));
vi.mock("../../pages/UnlockPage.js", () => ({ default: () => <h1>Unlock</h1> }));
vi.mock("../../pages/ChatPage.js", () => ({ default: () => null }));
vi.mock("../../pages/ChatListPage.js", () => ({ default: () => <div data-testid="legacy-chat-list">Chats</div> }));
vi.mock("../../pages/CallPage.js", () => ({ default: () => null }));
vi.mock("../calls/IncomingCallModal.js", () => ({ default: () => <div data-testid="incoming-call-layer" /> }));
vi.mock("../../features/chat/useOutgoingQueue.js", () => ({ useOutgoingQueue: vi.fn() }));
vi.mock("../app/UnlockedAppEffects.js", () => ({
  default: function UnlockedEffects() {
    useEffect(() => {
      keyState.unlockedEffects++;
      return () => { keyState.unlockedEffects--; };
    }, []);
    return null;
  },
}));
vi.mock("../app/UiPreferencesEffects.js", () => ({ default: () => null }));
vi.mock("../app/SessionRepairEffects.js", () => ({ default: () => null }));
vi.mock("../app/useKeyMaintenance.js", () => ({ useKeyMaintenance: vi.fn() }));

const { render, container } = setupDom();
let client: QueryClient;
let location: ReturnType<typeof useLocation>;
let navigate: ReturnType<typeof useNavigate>;
function LocationProbe() { location = useLocation(); navigate = useNavigate(); return null; }
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  localStorage.clear();
  keyState.loaded = true;
  keyState.unlockedEffects = 0;
  useAuthStore.setState({
    user: { id: "sam", username: "sam", displayName: "Sam Rivera" } as never,
    device: { id: "this-device", deviceName: "Laptop" } as never,
    accessToken: "token", refreshToken: "refresh", sessionId: "session", authEpoch: 1,
  });
  vi.mocked(api.get).mockImplementation(async (path) => (
    path.endsWith("/recovery-key") ? { enrolled: true } : path === "/api/users/mara" ? { id: "mara", displayName: "Mara" } : []
  ) as never);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => { client.clear(); });
async function show(path: string, entries = [path]) {
  await render(<QueryClientProvider client={client}><MemoryRouter initialEntries={entries}><LocationProbe /><App /></MemoryRouter></QueryClientProvider>);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

it.each(["/settings?section=security", "/devices", "/verify/mara"])("mounts one standalone settings shell at %s", async (path) => {
  await show(path);
  expect(container().querySelector('[data-testid="legacy-chat-list"]')).toBeNull();
  expect(container().querySelectorAll("main")).toHaveLength(1);
  expect(container().querySelectorAll('nav[aria-label="Main"]')).toHaveLength(2); // One rail and one responsive bottom bar.
  expect(container().querySelectorAll('[data-testid="incoming-call-layer"]')).toHaveLength(1);
  expect(useOutgoingQueue).toHaveBeenCalled();
});

it("moves manual locking into the locked auth phase and suspends unlocked effects", async () => {
  await show("/settings?section=security");
  expect(keyState.unlockedEffects).toBe(1);
  const lock = Array.from(container().querySelectorAll("button")).find((button) => button.textContent === "Lock now")!;
  await click(lock);
  expect(keyState.loaded).toBe(false);
  expect(useAuthStore.getState().authEpoch).toBe(2);
  expect(location.pathname).toBe("/unlock");
  expect(location.state.from).toMatchObject({ pathname: "/settings", search: "?section=security" });
  expect(container().querySelector("h1")?.textContent).toBe("Unlock");
  expect(keyState.unlockedEffects).toBe(0);
  expect(vi.mocked(useKeyMaintenance).mock.lastCall).toEqual([false]);
});

it("enters the locked phase when forgetting keys fails after clearing in-memory keys", async () => {
  vi.mocked(resetLocalCryptoState).mockImplementationOnce(async () => {
    keyState.loaded = false;
    throw new Error("IndexedDB clearing failed");
  });
  await show("/settings?section=security");
  const forget = Array.from(container().querySelectorAll("button")).find((button) => button.textContent === "Forget keys on this device…")!;
  await click(forget);
  const dialog = document.querySelector('[role="alertdialog"]')!;
  await click(dialog.querySelector('input[type="checkbox"]')!);
  await click(Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Forget keys")!);
  expect(keyState.loaded).toBe(false);
  expect(useAuthStore.getState().authEpoch).toBe(2);
  expect(location.pathname).toBe("/unlock");
  expect(container().querySelector("h1")?.textContent).toBe("Unlock");
  expect(keyState.unlockedEffects).toBe(0);
  expect(vi.mocked(useKeyMaintenance).mock.lastCall).toEqual([false]);
});

it.each([["Security", "/settings", "?section=security"], ["Linked devices", "/devices", ""]])(
  "pops history when returning from %s opened through the settings menu",
  async (label, pathname, search) => {
    await show("/settings", ["/chat/origin", "/settings"]);
    const item = Array.from(container().querySelectorAll("aside button")).find((button) => button.textContent?.startsWith(label))!;
    await click(item);
    expect(location.pathname).toBe(pathname);
    expect(location.search).toBe(search);
    await click(container().querySelector('main button[aria-label="Back"]')!);
    expect(location.pathname).toBe("/settings");
    expect(location.search).toBe("");
    await act(async () => { await navigate(-1); });
    expect(location.pathname).toBe("/chat/origin");
  },
);

it.each(["/settings?section=security", "/devices"])("replaces a direct link %s with the settings menu without adding history", async (path) => {
  await show(path);
  await click(container().querySelector('main button[aria-label="Back"]')!);
  expect(location.pathname).toBe("/settings");
  expect(location.search).toBe("");
  await act(async () => { await navigate(-1); });
  expect(location.pathname).toBe("/settings");
  expect(location.search).toBe("");
});
