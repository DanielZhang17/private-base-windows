import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {} from "vitest/jsdom";
import { useAuthStore } from "../stores/authStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { useCallStore } from "../stores/callStore.js";
import { queryClient } from "../lib/query-client.js";
import { lockLocalCryptoState } from "../lib/key-manager.js";
import { clearAccountScopedState } from "./session.js";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "localStorage", { value: jsdom.window.localStorage, configurable: true });
});
vi.mock("../lib/key-manager.js", () => ({ lockLocalCryptoState: vi.fn() }));
const signedIn = { user: { id: "alice" } as never, sessionId: "session-1", accessToken: "token", refreshToken: "refresh" };
let stop: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.setState(signedIn);
  queryClient.setQueryData(["private"], "plaintext");
  useChatStore.setState({ drafts: new Map([["chat", "private draft"]]) });
  stop = vi.fn();
  useCallStore.setState({ activeCallId: "call", localStream: { getTracks: () => [{ stop }] } as unknown as MediaStream });
});
afterEach(() => { clearAccountScopedState(); vi.restoreAllMocks(); });
async function storageUpdate(state: object) {
  const rehydrate = vi.spyOn(useAuthStore.persist, "rehydrate");
  const newValue = JSON.stringify({ state, version: 0 });
  localStorage.setItem("e2ee-auth", newValue);
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  window.dispatchEvent(new StorageEvent("storage", { key: "e2ee-auth", newValue }));
  await rehydrate.mock.results[0].value;
  await Promise.resolve();
  expect(setItem).not.toHaveBeenCalled();
}

it.each([
  ["logout", { user: null, sessionId: null, accessToken: null, refreshToken: null }],
  ["another login by the same user", { ...signedIn, sessionId: "session-2" }],
  ["another user", { ...signedIn, user: { id: "bob" } }],
])("clears account state after rehydrating cross-tab %s", async (_label, state) => {
  await storageUpdate(state);
  expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  expect(useChatStore.getState().drafts.size).toBe(0);
  expect(useCallStore.getState().activeCallId).toBeNull();
  expect(stop).toHaveBeenCalled();
  expect(lockLocalCryptoState).toHaveBeenCalledTimes(1);
});

it("preserves account state and crypto during token rotation in the same session", async () => {
  await storageUpdate({ ...signedIn, accessToken: "rotated", refreshToken: "rotated-refresh" });
  expect(queryClient.getQueryData(["private"])).toBe("plaintext");
  expect(useChatStore.getState().drafts.get("chat")).toBe("private draft");
  expect(stop).not.toHaveBeenCalled();
  expect(lockLocalCryptoState).not.toHaveBeenCalled();
});
