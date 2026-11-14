import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {} from "vitest/jsdom";
import { api, ApiError } from "./api.js";
import { useAuthStore } from "../stores/authStore.js";
import { lockLocalCryptoState } from "../lib/key-manager.js";

// Use jsdom storage instead of Node's optional localStorage global.
vi.hoisted(() => {
  Object.defineProperty(globalThis, "localStorage", { value: jsdom.window.localStorage, configurable: true });
});

vi.mock("../lib/key-manager.js", () => ({ lockLocalCryptoState: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const logout = vi.fn(useAuthStore.getState().logout);
const oldTokens = { accessToken: "old-access", refreshToken: "old-refresh" };
const newTokens = { accessToken: "new-access", refreshToken: "new-refresh" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function persistTokens(tokens: { accessToken: string; refreshToken: string }) {
  localStorage.setItem("e2ee-auth", JSON.stringify({ state: tokens, version: 0 }));
}

function authorization(options?: RequestInit): string | null {
  return new Headers(options?.headers).get("Authorization");
}

function refreshCalls() {
  return fetchMock.mock.calls.filter(([path]) => path === "/auth/refresh");
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  localStorage.clear();
  useAuthStore.setState({ ...oldTokens, user: null, device: null, authEpoch: 0, sessionId: null, logout });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("returns an anonymous 401 without clearing the session or navigating away", async () => {
  useAuthStore.setState({ accessToken: null, refreshToken: null });
  fetchMock.mockResolvedValueOnce(json({ error: "Missing authorization" }, 401));
  await expect(api.post("/api/account/avatar-upload-url", {})).rejects.toMatchObject({
    status: 401, message: "Missing authorization",
  });
  expect(refreshCalls()).toHaveLength(0);
  expect(logout).not.toHaveBeenCalled();
});

describe("API token refresh", () => {
  const otherSession = { accessToken: "other-access", refreshToken: "other-refresh" };
  const switchSession = () => useAuthStore.getState().applyAuthResponse({
    user: { id: "u2", username: "other" }, device: { id: "d2" }, ...otherSession,
  } as never);

  it.each([
    ["succeeds", () => json(newTokens)],
    ["is rejected", () => json({ error: "Invalid refresh token" }, 401)],
  ])("ignores a refresh that %s after the user switched sessions", async (_label, refreshResponse) => {
    const refresh = deferred<Response>();
    fetchMock.mockImplementation(async (path, options) => {
      if (path === "/auth/refresh") return refresh.promise;
      return authorization(options) === `Bearer ${oldTokens.accessToken}` ? json({ error: "Expired" }, 401) : json({ ok: true });
    });
    const pending = api.get("/api/data");
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    switchSession();
    refresh.resolve(refreshResponse());
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(useAuthStore.getState()).toMatchObject(otherSession);
    expect(logout).not.toHaveBeenCalled();
    // The old session's request is never replayed under the new session's token.
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/data")).toHaveLength(1);
  });

  it.each([
    ["an idle lock", () => useAuthStore.getState().bumpSessionState()],
    ["a session identity repair", () => useAuthStore.getState().repairSessionIdentity({ user: { id: "u1" }, device: { id: "d1" } } as never)],
  ])("still retries after %s bumps the epoch without changing the session", async (_label, bump) => {
    useAuthStore.setState({ device: { id: "d1" } as never });
    const refresh = deferred<Response>();
    fetchMock.mockImplementation(async (path, options) => {
      if (path === "/auth/refresh") return refresh.promise;
      return authorization(options) === `Bearer ${newTokens.accessToken}` ? json({ ok: true }) : json({ error: "Expired" }, 401);
    });
    const pending = api.get("/api/data");
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    bump();
    refresh.resolve(json(newTokens));
    await expect(pending).resolves.toEqual({ ok: true });
    expect(useAuthStore.getState()).toMatchObject(newTokens);
  });

  it.each([
    ["device", { user: { id: "u1" }, device: { id: "d2" } }],
    ["user", { user: { id: "u2" }, device: null }],
  ])("does not adopt another tab's tokens for a different %s", async (_label, otherIdentity) => {
    useAuthStore.setState({ user: { id: "u1" } as never, device: { id: "d1" } as never });
    localStorage.setItem("e2ee-auth", JSON.stringify({ state: { ...otherSession, ...otherIdentity }, version: 0 }));
    fetchMock.mockImplementation(async () => json({ error: "Expired" }, 401));
    await expect(api.get("/api/data")).rejects.toMatchObject({ status: 401, message: "Session changed" });
    expect(useAuthStore.getState()).toMatchObject({ ...oldTokens, user: { id: "u1" }, device: { id: "d1" } });
    expect(refreshCalls()).toHaveLength(0);
    expect(logout).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/data")).toHaveLength(1);
  });

  it("adopts another tab's rotated tokens for the same user and device", async () => {
    const identity = { user: { id: "u1" }, device: { id: "d1" } };
    useAuthStore.setState(identity as never);
    localStorage.setItem("e2ee-auth", JSON.stringify({ state: { ...newTokens, ...identity }, version: 0 }));
    fetchMock.mockImplementation(async (_path, options) => (
      authorization(options) === `Bearer ${newTokens.accessToken}` ? json({ ok: true }) : json({ error: "Expired" }, 401)
    ));
    await expect(api.get("/api/data")).resolves.toEqual({ ok: true });
    expect(useAuthStore.getState()).toMatchObject(newTokens);
    expect(refreshCalls()).toHaveLength(0);
  });

  it("does not replay a request under a session rehydrated from another tab", async () => {
    useAuthStore.setState({ user: { id: "u1" } as never, device: { id: "d1" } as never });
    const refresh = deferred<Response>();
    fetchMock.mockImplementation(async (path) => (path === "/auth/refresh" ? refresh.promise : json({ error: "Expired" }, 401)));
    const pending = api.get("/api/data");
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    // A storage-event rehydrate replaces the whole state, and the persisted epoch can coincide.
    useAuthStore.setState({ ...otherSession, user: { id: "u2" } as never, device: { id: "d2" } as never });
    refresh.resolve(json(newTokens));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(useAuthStore.getState()).toMatchObject(otherSession);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/data")).toHaveLength(1);
  });

  it.each([
    ["signed out", { accessToken: null, refreshToken: null }],
    ["signed in to another session", otherSession],
  ])("does not commit a refresh after another tab %s before this tab rehydrated", async (_label, persisted) => {
    const refresh = deferred<Response>();
    fetchMock.mockImplementation(async (path) => (path === "/auth/refresh" ? refresh.promise : json({ error: "Expired" }, 401)));
    const pending = api.get("/api/data");
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    // The other tab's write is in storage, but this tab's storage listener has not run yet.
    const stored = JSON.stringify({ state: persisted, version: 0 });
    localStorage.setItem("e2ee-auth", stored);
    refresh.resolve(json(newTokens));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem("e2ee-auth")).toBe(stored);
    expect(useAuthStore.getState()).toMatchObject(oldTokens);
    expect(logout).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/data")).toHaveLength(1);
  });

  it("does not replay a request under a new login on the same device", async () => {
    const identity = { user: { id: "u1", username: "one" }, device: { id: "d1" } };
    useAuthStore.getState().applyAuthResponse({ ...identity, ...oldTokens } as never);
    const refresh = deferred<Response>();
    fetchMock.mockImplementation(async (path, options) => {
      if (path === "/auth/refresh") return refresh.promise;
      return authorization(options) === `Bearer ${oldTokens.accessToken}` ? json({ error: "Expired" }, 401) : json({ ok: true });
    });
    const pending = api.get("/api/data");
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    useAuthStore.getState().logout();
    useAuthStore.getState().applyAuthResponse({ ...identity, ...otherSession } as never);
    refresh.resolve(json(newTokens));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(useAuthStore.getState()).toMatchObject(otherSession);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/data")).toHaveLength(1);
  });

  it("does not replay a request that fails after a new login on the same device", async () => {
    const identity = { user: { id: "u1", username: "one" }, device: { id: "d1" } };
    useAuthStore.getState().applyAuthResponse({ ...identity, ...oldTokens } as never);
    const first = deferred<Response>();
    fetchMock.mockImplementationOnce(async () => first.promise);
    fetchMock.mockImplementation(async () => json({ ok: true }));
    const pending = api.get("/api/data");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    useAuthStore.getState().logout();
    useAuthStore.getState().applyAuthResponse({ ...identity, ...otherSession } as never);
    // With storage unavailable only the in-memory session can tell the two logins apart.
    localStorage.removeItem("e2ee-auth");
    first.resolve(json({ error: "Expired" }, 401));
    await expect(pending).rejects.toMatchObject({ status: 401, message: "Session changed" });
    expect(refreshCalls()).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/data")).toHaveLength(1);
  });

  it("does not adopt another tab's tokens from a different login on the same device", async () => {
    const identity = { user: { id: "u1" }, device: { id: "d1" } };
    useAuthStore.setState({ ...identity, sessionId: "login-1" } as never);
    localStorage.setItem("e2ee-auth", JSON.stringify({ state: { ...otherSession, ...identity, sessionId: "login-2" }, version: 0 }));
    fetchMock.mockImplementation(async () => json({ error: "Expired" }, 401));
    await expect(api.get("/api/data")).rejects.toMatchObject({ status: 401, message: "Session changed" });
    expect(useAuthStore.getState()).toMatchObject(oldTokens);
    expect(refreshCalls()).toHaveLength(0);
  });

  it("shares one refresh across five concurrent requests and retries all with the new token", async () => {
    fetchMock.mockImplementation(async (path, options) => {
      if (path === "/auth/refresh") {
        expect(JSON.parse(options!.body as string)).toEqual({ refreshToken: oldTokens.refreshToken });
        return json(newTokens);
      }
      return authorization(options) === `Bearer ${oldTokens.accessToken}`
        ? json({ error: "Expired" }, 401)
        : json({ ok: true });
    });

    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => api.get(`/api/data/${index}`)));

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ ok: true })));
    expect(refreshCalls()).toHaveLength(1);
    const requests = fetchMock.mock.calls.filter(([path]) => path !== "/auth/refresh");
    expect(requests.filter(([, options]) => authorization(options) === `Bearer ${oldTokens.accessToken}`)).toHaveLength(5);
    expect(requests.filter(([, options]) => authorization(options) === `Bearer ${newTokens.accessToken}`)).toHaveLength(5);
    expect(logout).not.toHaveBeenCalled();
  });

  it.each(["post", "put", "delete", "patch"] as const)("retries %s with its original method and body", async (method) => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "Expired" }, 401))
      .mockResolvedValueOnce(json(newTokens))
      .mockResolvedValueOnce(json({ ok: true }));
    const body = { name: "updated" };

    const result = method === "delete"
      ? await api.delete("/api/resource")
      : await api[method]("/api/resource", body);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const initial = fetchMock.mock.calls[0][1]!;
    const retry = fetchMock.mock.calls[2][1]!;
    expect(initial.method).toBe(method.toUpperCase());
    expect(initial.body).toBe(method === "delete" ? undefined : JSON.stringify(body));
    expect(retry).toEqual({
      ...initial,
      headers: { ...initial.headers, Authorization: `Bearer ${newTokens.accessToken}` },
    });
  });

  it("preserves an ArrayBuffer body and content type on a PUT retry", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "Expired" }, 401))
      .mockResolvedValueOnce(json(newTokens))
      .mockResolvedValueOnce(json({ ok: true }));
    const body = new ArrayBuffer(4);

    await expect(api.put("/api/files/upload", body)).resolves.toEqual({ ok: true });

    for (const index of [0, 2]) {
      const options = fetchMock.mock.calls[index][1]!;
      expect(options.body).toBe(body);
      expect(new Headers(options.headers).get("Content-Type")).toBe("application/octet-stream");
    }
    expect(authorization(fetchMock.mock.calls[2][1])).toBe(`Bearer ${newTokens.accessToken}`);
  });

  it("keeps the session on a network refresh failure and allows a later refresh", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "Expired" }, 401))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(api.get("/api/data")).rejects.toMatchObject({
      name: "ApiError", status: 0, message: "Failed to fetch",
    });

    expect(logout).not.toHaveBeenCalled();
    expect(lockLocalCryptoState).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject(oldTokens);
    expect(JSON.parse(localStorage.getItem("e2ee-auth")!).state).toMatchObject(oldTokens);

    fetchMock
      .mockResolvedValueOnce(json({ error: "Expired" }, 401))
      .mockResolvedValueOnce(json(newTokens))
      .mockResolvedValueOnce(json({ ok: true }));
    await expect(api.get("/api/data")).resolves.toEqual({ ok: true });
    expect(refreshCalls()).toHaveLength(2);
  });

  it.each([500, 429])("keeps the session when refresh returns %s", async (status) => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "Expired" }, 401))
      .mockResolvedValueOnce(json({ error: "Try again later", code: "TEMPORARY" }, status));

    await expect(api.get("/api/data")).rejects.toMatchObject({
      name: "ApiError", status, message: "Try again later", code: "TEMPORARY",
    });

    expect(logout).not.toHaveBeenCalled();
    expect(lockLocalCryptoState).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject(oldTokens);
    expect(JSON.parse(localStorage.getItem("e2ee-auth")!).state).toMatchObject(oldTokens);
  });

  it.each([401, 403])("logs out and redirects when refresh returns %s", async (status) => {
    const location = { href: "/chat" };
    vi.stubGlobal("window", { location });
    fetchMock
      .mockResolvedValueOnce(json({ error: "Expired" }, 401))
      .mockResolvedValueOnce(json({ error: "Invalid refresh token", code: "INVALID_REFRESH" }, status));

    await expect(api.get("/api/data")).rejects.toMatchObject({
      name: "ApiError", status, code: "INVALID_REFRESH",
    });

    expect(logout).toHaveBeenCalledTimes(1);
    expect(lockLocalCryptoState).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(location.href).toBe("/login");
  });

  it("adopts another tab's persisted tokens before handling a 401 without refreshing", async () => {
    const initialResponse = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(initialResponse.promise)
      .mockResolvedValueOnce(json({ ok: true }));

    const request = api.get("/api/data");
    persistTokens(newTokens);
    initialResponse.resolve(json({ error: "Expired" }, 401));

    await expect(request).resolves.toEqual({ ok: true });
    expect(refreshCalls()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorization(fetchMock.mock.calls[1][1])).toBe(`Bearer ${newTokens.accessToken}`);
    expect(useAuthStore.getState()).toMatchObject(newTokens);
    expect(logout).not.toHaveBeenCalled();
  });

  it("reads persisted tokens after acquiring the browser refresh lock", async () => {
    const lockRequested = deferred<void>();
    const releaseLock = deferred<void>();
    const requestLock = vi.fn(async (_name: string, callback: () => Promise<void>) => {
      lockRequested.resolve();
      await releaseLock.promise;
      return callback();
    });
    vi.stubGlobal("navigator", { locks: { request: requestLock } });
    fetchMock
      .mockResolvedValueOnce(json({ error: "Expired" }, 401))
      .mockResolvedValueOnce(json({ ok: true }));

    const request = api.get("/api/data");
    await lockRequested.promise;
    persistTokens(newTokens);
    releaseLock.resolve();

    await expect(request).resolves.toEqual({ ok: true });
    expect(requestLock).toHaveBeenCalledExactlyOnceWith("e2ee-refresh", expect.any(Function));
    expect(refreshCalls()).toHaveLength(0);
    expect(authorization(fetchMock.mock.calls[1][1])).toBe(`Bearer ${newTokens.accessToken}`);
  });

  it("uses the in-memory token for a late 401 after another request finished refreshing", async () => {
    const lateResponse = deferred<Response>();
    fetchMock.mockImplementation(async (path, options) => {
      if (path === "/auth/refresh") return json(newTokens);
      if (authorization(options) === `Bearer ${newTokens.accessToken}`) return json({ ok: true });
      if (path === "/api/late") return lateResponse.promise;
      return json({ error: "Expired" }, 401);
    });

    const lateRequest = api.get("/api/late");
    await api.get("/api/early");
    localStorage.removeItem("e2ee-auth");
    lateResponse.resolve(json({ error: "Expired" }, 401));

    await expect(lateRequest).resolves.toEqual({ ok: true });
    expect(refreshCalls()).toHaveLength(1);
    expect(authorization(fetchMock.mock.calls.at(-1)![1])).toBe(`Bearer ${newTokens.accessToken}`);
  });

  it("retries only once when the replacement access token also receives a 401", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "Expired" }, 401))
      .mockResolvedValueOnce(json(newTokens))
      .mockResolvedValueOnce(json({ error: "Still unauthorized", code: "UNAUTHORIZED" }, 401));

    await expect(api.get("/api/data")).rejects.toMatchObject({
      name: "ApiError", status: 401, message: "Still unauthorized", code: "UNAUTHORIZED",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refreshCalls()).toHaveLength(1);
  });

  it.each(["/auth/login", "/auth/register", "/auth/refresh"])("does not refresh for %s", async (path) => {
    fetchMock.mockResolvedValueOnce(json({ error: "Invalid credentials" }, 401));

    await expect(api.post(path, {})).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
  });

  it("does not refresh an unauthenticated device-link request", async () => {
    useAuthStore.setState({ accessToken: null, refreshToken: null });
    fetchMock.mockResolvedValueOnce(json({ error: "Link expired" }, 401));

    await expect(api.get("/api/device-links/request/status")).rejects.toMatchObject({ status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
  });

  it("refreshes an authenticated device-link request", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "Expired" }, 401))
      .mockResolvedValueOnce(json(newTokens))
      .mockResolvedValueOnce(json({ ok: true }));

    await expect(api.get("/api/device-links/pending")).resolves.toEqual({ ok: true });

    expect(refreshCalls()).toHaveLength(1);
  });

  it("preserves structured error messages and codes", async () => {
    fetchMock.mockResolvedValueOnce(json({
      error: { fieldErrors: { name: ["Name is required"] } },
      code: "VALIDATION_ERROR",
    }, 400));

    await expect(api.post("/api/data", {})).rejects.toMatchObject({
      name: "ApiError", status: 400, message: "Name is required", code: "VALIDATION_ERROR",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
