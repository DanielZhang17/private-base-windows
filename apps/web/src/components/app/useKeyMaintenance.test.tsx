import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Device } from "@e2ee-chat/shared";
import { KEY_MAINTENANCE_RETRY_DELAYS_MS, useKeyMaintenance } from "./useKeyMaintenance.js";
import { useAuthStore } from "../../stores/authStore.js";
import { getUnlockGeneration, keysLoaded, runPostUnlockKeyMaintenance } from "../../lib/key-manager.js";

vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ device: null, accessToken: null, sessionId: null, authEpoch: 0 })) };
});
vi.mock("../../lib/key-manager.js", () => ({
  getUnlockGeneration: vi.fn(),
  keysLoaded: vi.fn(),
  runPostUnlockKeyMaintenance: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
const maintenance = vi.mocked(runPostUnlockKeyMaintenance);

function Harness({ unlocked }: { unlocked: boolean }) {
  // Like App, re-render on every auth epoch change.
  useAuthStore((state) => (state as unknown as { authEpoch: number }).authEpoch);
  useKeyMaintenance(unlocked);
  return null;
}
const render = (unlocked: boolean) => act(async () => root.render(<Harness unlocked={unlocked} />));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const bumpEpoch = () => act(async () => {
  useAuthStore.setState((state) => ({ authEpoch: (state as unknown as { authEpoch: number }).authEpoch + 1 }) as never);
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(keysLoaded).mockReturnValue(true);
  vi.mocked(getUnlockGeneration).mockReturnValue(1);
  maintenance.mockResolvedValue(undefined);
  useAuthStore.setState({ device: { id: "device-1" } as Device, accessToken: "token", sessionId: "session-1", authEpoch: 1 } as never);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("runs once after unlock and not at all while locked or signed out", async () => {
  await render(false);
  expect(maintenance).not.toHaveBeenCalled();
  await render(true);
  expect(maintenance).toHaveBeenCalledTimes(1);
  await advance(60 * 60_000);
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  await advance(0);
  expect(maintenance).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("retries a failed run with backoff until it succeeds", async () => {
  maintenance.mockRejectedValue(new Error("offline"));
  await render(true);
  expect(maintenance).toHaveBeenCalledTimes(1);
  const [first, second, third, steady] = KEY_MAINTENANCE_RETRY_DELAYS_MS;
  expect([first, second, third, steady]).toEqual([5_000, 15_000, 60_000, 300_000]);

  let calls = 1;
  for (const delay of [first, second, third, steady, steady]) {
    await advance(delay - 1);
    expect(maintenance).toHaveBeenCalledTimes(calls);
    await advance(1);
    expect(maintenance).toHaveBeenCalledTimes(++calls);
  }

  maintenance.mockResolvedValue(undefined);
  await advance(steady);
  expect(maintenance).toHaveBeenCalledTimes(++calls);
  await advance(10 * steady);
  expect(maintenance).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
});

it("retries immediately when the browser comes back online or the tab becomes visible", async () => {
  maintenance.mockRejectedValue(new Error("offline"));
  await render(true);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(maintenance).toHaveBeenCalledTimes(2);

  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(maintenance).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("visible");
  maintenance.mockResolvedValue(undefined);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(maintenance).toHaveBeenCalledTimes(3);
  // An event-triggered retry replaces the pending timer instead of adding to it.
  await advance(60 * 60_000);
  expect(maintenance).toHaveBeenCalledTimes(3);
});

it("does not start overlapping runs", async () => {
  let reject!: (error: Error) => void;
  maintenance.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  await render(true);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(maintenance).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error("offline")); });
  await advance(KEY_MAINTENANCE_RETRY_DELAYS_MS[0]);
  expect(maintenance).toHaveBeenCalledTimes(2);
});

it.each(["lock", "logout", "unmount"])("stops retrying on %s", async (reason) => {
  maintenance.mockRejectedValue(new Error("offline"));
  await render(true);
  expect(vi.getTimerCount()).toBe(1);
  if (reason === "lock") {
    vi.mocked(keysLoaded).mockReturnValue(false);
    await render(false);
  } else if (reason === "logout") {
    await act(async () => { useAuthStore.setState({ accessToken: null, sessionId: null } as never); });
    await render(false);
  } else {
    await act(async () => root.unmount());
    root = createRoot(container);
  }
  expect(vi.getTimerCount()).toBe(0);
  window.dispatchEvent(new Event("online"));
  await advance(60 * 60_000);
  expect(maintenance).toHaveBeenCalledTimes(1);
});

it("does not re-run when another tab bumps the shared auth epoch, but does after a local unlock", async () => {
  await render(true);
  expect(maintenance).toHaveBeenCalledTimes(1);

  // Another tab idle-locked: the persisted epoch changes here too, and the phase is re-evaluated.
  await bumpEpoch();
  await render(false);
  await render(true);
  await bumpEpoch();
  expect(maintenance).toHaveBeenCalledTimes(1);

  // This tab locks and is unlocked again.
  vi.mocked(keysLoaded).mockReturnValue(false);
  await render(false);
  await bumpEpoch();
  expect(maintenance).toHaveBeenCalledTimes(1);
  vi.mocked(keysLoaded).mockReturnValue(true);
  vi.mocked(getUnlockGeneration).mockReturnValue(2);
  await render(true);
  expect(maintenance).toHaveBeenCalledTimes(2);

  // A new login (or another device) is a new run as well.
  await act(async () => { useAuthStore.setState({ sessionId: "session-2" } as never); });
  expect(maintenance).toHaveBeenCalledTimes(3);
  await act(async () => { useAuthStore.setState({ device: { id: "device-2" } as Device } as never); });
  expect(maintenance).toHaveBeenCalledTimes(4);
});

it("keeps retrying a failed run across a cross-tab epoch bump", async () => {
  maintenance.mockRejectedValue(new Error("offline"));
  await render(true);
  await bumpEpoch();
  await render(false);
  await render(true);
  maintenance.mockResolvedValue(undefined);
  await advance(KEY_MAINTENANCE_RETRY_DELAYS_MS[0]);
  expect(maintenance.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(maintenance).toHaveLastReturnedWith(expect.any(Promise));
  const calls = maintenance.mock.calls.length;
  await advance(60 * 60_000);
  expect(maintenance).toHaveBeenCalledTimes(calls);
});
