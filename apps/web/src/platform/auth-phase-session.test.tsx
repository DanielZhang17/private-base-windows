import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {} from "vitest/jsdom";
import App from "../App.js";
import { useAuthStore } from "../stores/authStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { lockLocalCryptoState } from "../lib/key-manager.js";
import { clearAccountScopedState } from "./session.js";

const keyState = vi.hoisted(() => {
  Object.defineProperty(globalThis, "localStorage", { value: jsdom.window.localStorage, configurable: true });
  return { loaded: false };
});
vi.mock("../lib/key-manager.js", () => ({
  keysLoaded: () => keyState.loaded,
  hasLocalKeyMaterial: async () => true,
  lockLocalCryptoState: vi.fn(() => { keyState.loaded = false; }),
  // Manual locking does not notify these listeners in the real key manager.
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
vi.mock("../components/app/useKeyMaintenance.js", () => ({ useKeyMaintenance: () => {} }));

const signedIn = {
  user: { id: "alice" } as never,
  device: { id: "device" } as never,
  sessionId: "session-1", accessToken: "token", refreshToken: "refresh", authEpoch: 1,
};
let root: Root;
let container: HTMLDivElement;
const subscriptions: Array<() => void> = [];
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  useAuthStore.setState(signedIn);
  useChatStore.setState({ drafts: new Map([["chat", "private draft"]]) });
  keyState.loaded = true;
  container = document.createElement("div"); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><App /></MemoryRouter>));
  expect(container.textContent).toBe("Protected UI");
});
afterEach(async () => {
  await act(async () => root.unmount());
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
  clearAccountScopedState();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function storageUpdate(state: object) {
  const rehydrate = vi.spyOn(useAuthStore.persist, "rehydrate");
  const newValue = JSON.stringify({ state, version: 0 });
  localStorage.setItem("e2ee-auth", newValue);
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  // Flush React before the storage listener's awaited continuation can lock keys.
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: "e2ee-auth", newValue })));
  await act(async () => { await rehydrate.mock.results[0].value; });
  expect(setItem).not.toHaveBeenCalled();
}

it.each([
  ["a new session for the same user", { sessionId: "session-2", accessToken: "new-token", authEpoch: 2 }],
  ["another user", { user: { id: "bob" }, accessToken: "new-token", authEpoch: 2 }],
  ["a new session with unchanged token, device and epoch", { sessionId: "session-2" }],
])("shows Unlock when another tab publishes %s", async (_label, change) => {
  const order: string[] = [];
  subscriptions.push(useChatStore.subscribe((state) => { if (state.drafts.size === 0) order.push("clear"); }));
  vi.mocked(lockLocalCryptoState).mockImplementation(() => { order.push("lock"); keyState.loaded = false; });
  subscriptions.push(useAuthStore.subscribe(() => { order.push("publish"); }));

  await storageUpdate({ ...signedIn, ...change });

  expect(keyState.loaded).toBe(false);
  expect(container.textContent).toBe("Unlock");
  expect(order).toEqual(["clear", "lock", "publish"]);
  expect(useAuthStore.getState().authEpoch).toBe(2);
});

it("keeps the protected UI and keys during same-session token rotation", async () => {
  await storageUpdate({ ...signedIn, accessToken: "rotated", refreshToken: "rotated-refresh" });
  expect(container.textContent).toBe("Protected UI");
  expect(keyState.loaded).toBe(true);
  expect(lockLocalCryptoState).not.toHaveBeenCalled();
  expect(useChatStore.getState().drafts.get("chat")).toBe("private draft");
  expect(useAuthStore.getState().authEpoch).toBe(signedIn.authEpoch);
});
