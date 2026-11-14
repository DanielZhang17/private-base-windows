import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {} from "vitest/jsdom";
import { useAuthStore } from "./authStore.js";
import { lockLocalCryptoState } from "../lib/key-manager.js";

// Use jsdom storage instead of Node's optional localStorage global.
vi.hoisted(() => {
  Object.defineProperty(globalThis, "localStorage", { value: jsdom.window.localStorage, configurable: true });
});

vi.mock("../lib/key-manager.js", () => ({ lockLocalCryptoState: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.setState({ accessToken: "old-access", refreshToken: "old-refresh", authEpoch: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cross-tab auth sync", () => {
  it("rehydrates rotated tokens without locking crypto", async () => {
    const tokens = { accessToken: "new-access", refreshToken: "new-refresh" };
    const rehydrate = vi.spyOn(useAuthStore.persist, "rehydrate");
    const logout = vi.spyOn(useAuthStore.getState(), "logout");
    const newValue = JSON.stringify({ state: tokens, version: 0 });
    localStorage.setItem("e2ee-auth", newValue);

    window.dispatchEvent(new StorageEvent("storage", { key: "e2ee-auth", newValue }));
    await Promise.resolve();

    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).toMatchObject(tokens);
    expect(logout).not.toHaveBeenCalled();
    expect(lockLocalCryptoState).not.toHaveBeenCalled();
  });

  it("locks crypto after another tab's logout finishes rehydrating without persisting or bumping authEpoch", async () => {
    let finishHydration!: () => void;
    const hydration = new Promise<void>((resolve) => { finishHydration = resolve; });
    const originalRehydrate = useAuthStore.persist.rehydrate;
    const rehydrate = vi.spyOn(useAuthStore.persist, "rehydrate").mockImplementationOnce(async () => {
      await hydration;
      await originalRehydrate();
    });
    const logout = vi.spyOn(useAuthStore.getState(), "logout");
    const state = { accessToken: null, refreshToken: null, authEpoch: 42 };
    const newValue = JSON.stringify({ state, version: 0 });
    localStorage.setItem("e2ee-auth", newValue);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    window.dispatchEvent(new StorageEvent("storage", { key: "e2ee-auth", newValue }));

    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBe("old-access");
    expect(lockLocalCryptoState).not.toHaveBeenCalled();

    finishHydration();
    await rehydrate.mock.results[0].value;

    expect(useAuthStore.getState()).toMatchObject(state);
    expect(lockLocalCryptoState).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem("e2ee-auth")).toBe(newValue);
  });

  it("ignores storage events for unrelated keys", () => {
    const rehydrate = vi.spyOn(useAuthStore.persist, "rehydrate");

    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));

    expect(rehydrate).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ accessToken: "old-access", refreshToken: "old-refresh" });
  });
});

describe("per-login session id", () => {
  const login = () => useAuthStore.getState().applyAuthResponse({
    user: { id: "u1" }, device: { id: "d1" }, accessToken: "a", refreshToken: "r",
  } as never);

  it("changes on every login and clears on logout, but not on lock, repair or token rotation", () => {
    login();
    const first = useAuthStore.getState().sessionId;
    expect(first).toBeTruthy();
    useAuthStore.getState().bumpSessionState();
    useAuthStore.getState().repairSessionIdentity({ user: { id: "u1" }, device: { id: "d1" } } as never);
    useAuthStore.getState().setTokens("a2", "r2");
    expect(useAuthStore.getState().sessionId).toBe(first);
    expect(JSON.parse(localStorage.getItem("e2ee-auth")!).state.sessionId).toBe(first);
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().sessionId).toBeNull();
    login();
    expect(useAuthStore.getState().sessionId).toBeTruthy();
    expect(useAuthStore.getState().sessionId).not.toBe(first);
  });
});
