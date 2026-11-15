import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupCallBestEffort } from "./call-cleanup.js";
import { api } from "./api.js";
import { deletePendingCall } from "../db/index.js";
import { useAuthStore } from "../stores/authStore.js";

vi.mock("./api.js", () => ({ api: { post: vi.fn() } }));
vi.mock("../db/index.js", () => ({ deletePendingCall: vi.fn() }));
vi.mock("../stores/authStore.js", () => ({ useAuthStore: { getState: vi.fn() } }));
let auth: { user: { id: string } | null; device: { id: string } | null; sessionId: string | null; accessToken: string | null };
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  auth = { user: { id: "alice" }, device: { id: "device" }, sessionId: "session", accessToken: "token" };
  vi.mocked(useAuthStore.getState).mockImplementation(() => auth as never);
  vi.mocked(deletePendingCall).mockResolvedValue(undefined);
  vi.mocked(api.post).mockResolvedValue({} as never);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("deletes the local key independently of a hanging end request", async () => {
  let finish!: (value: never) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const cleanup = cleanupCallBestEffort("A", auth);
  await Promise.resolve();
  expect(deletePendingCall).toHaveBeenCalledWith("A");
  expect(api.post).toHaveBeenCalledWith("/api/calls/A/end");
  finish({} as never);
  await cleanup;
});

it("retries transient end failures after 500ms and 1500ms, using only the original call ID", async () => {
  vi.mocked(api.post).mockRejectedValueOnce({ status: 503 }).mockRejectedValueOnce({ status: 0 });
  const cleanup = cleanupCallBestEffort("A", auth);
  await vi.advanceTimersByTimeAsync(500);
  expect(api.post).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1500);
  await cleanup;
  expect(api.post).toHaveBeenCalledTimes(3);
  expect(vi.mocked(api.post).mock.calls.every(([path]) => path === "/api/calls/A/end")).toBe(true);
  expect(deletePendingCall).toHaveBeenCalledOnce();
});

it("bounds retries to three attempts on persistent network failure", async () => {
  vi.mocked(api.post).mockRejectedValue(new TypeError("Offline"));
  const cleanup = cleanupCallBestEffort("A", auth);
  await vi.advanceTimersByTimeAsync(2000);
  await cleanup;
  expect(api.post).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not retry a permanent rejection", async () => {
  vi.mocked(api.post).mockRejectedValueOnce({ status: 403 });
  await cleanupCallBestEffort("A", auth);
  expect(api.post).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["signed out", "different login"])("does not retry under a %s session", async (change) => {
  vi.mocked(api.post).mockRejectedValueOnce({ status: 503 });
  const cleanup = cleanupCallBestEffort("A", auth);
  await Promise.resolve();
  auth = change === "signed out" ? { ...auth, accessToken: null, user: null, sessionId: null }
    : { ...auth, sessionId: "different-session" };
  await vi.advanceTimersByTimeAsync(500);
  await cleanup;
  expect(api.post).toHaveBeenCalledOnce();
  expect(deletePendingCall).toHaveBeenCalledWith("A");
});

it("still deletes the key after sign-out, relying on the server ring timeout", async () => {
  const session = auth;
  auth = { ...auth, accessToken: null, user: null, sessionId: null };
  await cleanupCallBestEffort("A", session);
  expect(deletePendingCall).toHaveBeenCalledWith("A");
  expect(api.post).not.toHaveBeenCalled();
});

it("still ends the server call if local key deletion fails", async () => {
  vi.mocked(deletePendingCall).mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(cleanupCallBestEffort("A", auth)).resolves.toBeUndefined();
  expect(api.post).toHaveBeenCalledWith("/api/calls/A/end");
});
