import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  accessToken: "expired", refreshToken: null as string | null, device: null, authEpoch: 0, sessionId: null,
  logout: vi.fn(), setTokens: vi.fn(),
}));
vi.mock("../stores/authStore.js", () => ({ useAuthStore: { getState: () => auth } }));

function origin(url: string, bridge = false) {
  const location = new URL(url);
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", { location, ...(bridge ? { __TAURI_INTERNALS__: {} } : {}) });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("VITE_API_BASE_URL", "");
  vi.stubGlobal("localStorage", { getItem: () => null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("API and WebSocket origins", () => {
  it.each(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:5173"])("requires a configured API on native %s", async (url) => {
    origin(url, true);
    await expect(import("../services/api.js")).rejects.toThrow("Native clients require VITE_API_BASE_URL");
  });

  it.each(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"])("resolves native HTTP and WS against the API, never %s", async (url) => {
    origin(url);
    vi.stubEnv("VITE_API_BASE_URL", " https://chat-api.718788.xyz/ ");
    const { resolveApiUrl, resolveWsBaseUrl } = await import("../services/api.js");
    expect(resolveApiUrl("/auth/login")).toBe("https://chat-api.718788.xyz/auth/login");
    expect(resolveWsBaseUrl()).toBe("wss://chat-api.718788.xyz");
  });

  it.each(["/api", "tauri://localhost", "ws://localhost:8787", "not a URL"])("rejects invalid native API configuration %s", async (base) => {
    origin("tauri://localhost");
    vi.stubEnv("VITE_API_BASE_URL", base);
    await expect(import("../services/api.js")).rejects.toThrow("absolute http(s) URL");
  });

  it("supports an explicitly configured native development server", async () => {
    origin("tauri://localhost");
    vi.stubEnv("VITE_API_BASE_URL", "http://localhost:8787");
    const { resolveWsBaseUrl } = await import("../services/api.js");
    expect(resolveWsBaseUrl()).toBe("ws://localhost:8787");
  });

  it.each(["https://chat.718788.xyz", "https://branch.e2ee-chat-web.pages.dev", "https://e2ee-chat-web.pages.dev"])("preserves the production/Pages default for %s", async (url) => {
    origin(url);
    const { resolveApiUrl, resolveWsBaseUrl } = await import("../services/api.js");
    expect(resolveApiUrl("/api/data")).toBe("https://chat-api.718788.xyz/api/data");
    expect(resolveWsBaseUrl()).toBe("wss://chat-api.718788.xyz");
  });

  it.each([["http://localhost:5173", "ws://localhost:5173"], ["https://other.test", "wss://other.test"]])("preserves same-origin web behavior at %s", async (url, ws) => {
    origin(url);
    const { resolveApiUrl, resolveWsBaseUrl } = await import("../services/api.js");
    expect(resolveApiUrl("/api/data")).toBe("/api/data");
    expect(resolveWsBaseUrl()).toBe(ws);
    expect(resolveApiUrl("https://files.test/download")).toBe("https://files.test/download");
  });

  it.each([null, "expired-refresh"])("routes an expired native session to login (refresh=%s)", async (refreshToken) => {
    origin("tauri://localhost");
    vi.stubEnv("VITE_API_BASE_URL", "https://chat-api.718788.xyz");
    auth.refreshToken = refreshToken;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Expired" }), { status: 401 })));
    const route = vi.fn();
    const { registerNavigate } = await import("./navigation.js");
    const cleanup = registerNavigate(route);
    const { api } = await import("../services/api.js");
    await expect(api.get("/api/data")).rejects.toMatchObject({ status: 401 });
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledExactlyOnceWith("/login");
    cleanup();
  });
});
