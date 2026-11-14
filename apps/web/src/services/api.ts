import { useAuthStore } from "../stores/authStore.js";
import { isNative } from "../platform/environment.js";
import { navigate } from "../platform/navigation.js";
import { clearAccountScopedState } from "../platform/session.js";

const PAGE_PREVIEW_SUFFIX = ".e2ee-chat-web.pages.dev";
const PRODUCTION_WEB_HOSTS = new Set(["chat.718788.xyz"]);
const DEFAULT_CLOUDFLARE_API_ORIGIN = "https://chat-api.718788.xyz";

function resolveApiBaseUrl(): string {
  const configured = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  if (isNative()) {
    if (!configured) throw new Error("Native clients require VITE_API_BASE_URL (for example https://chat-api.718788.xyz)");
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new Error("VITE_API_BASE_URL must be an absolute http(s) URL for native clients");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("VITE_API_BASE_URL must be an absolute http(s) URL for native clients");
    }
  }
  if (configured) return configured.replace(/\/$/, "");

  // In Pages preview/alias hosts, same-origin /auth and /api requests hit static hosting (405).
  // Route them to the API Worker unless an explicit VITE_API_BASE_URL is set.
  const host = location.hostname.toLowerCase();
  if (host === "e2ee-chat-web.pages.dev" || host.endsWith(PAGE_PREVIEW_SUFFIX) || PRODUCTION_WEB_HOSTS.has(host)) {
    return DEFAULT_CLOUDFLARE_API_ORIGIN;
  }

  return "";
}

const API_BASE_URL = resolveApiBaseUrl();
let refreshPromise: Promise<void> | null = null;

/** End an expired session. Navigation stays in the SPA, so account state is cleared explicitly. */
function expireSession(): void {
  clearAccountScopedState();
  useAuthStore.getState().logout();
  navigate("/login");
}

export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE_URL}${path}`;
}

export function resolveWsBaseUrl(): string {
  if (API_BASE_URL) {
    const apiUrl = isNative() ? new URL(API_BASE_URL) : new URL(API_BASE_URL, location.origin);
    const wsProtocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${apiUrl.host}`;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  /** The parsed JSON error body, for endpoints that return extra fields with an error. */
  body?: unknown;

  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

type SessionSnapshot = {
  accessToken: string | null;
  device: { id: string } | null;
  authEpoch: number;
  sessionId: string | null;
};

/**
 * Whether `now` is still the session a request started in. The per-login sessionId decides:
 * it changes on every login (even on the same device) and on logout, but not on an idle lock,
 * a session-identity repair or a token rotation, and it is shared by all tabs of that login.
 * Sessions persisted before sessionId existed fall back to the device id, then to authEpoch
 * (which alone would also change on an idle lock and can coincide across tabs).
 */
function isSameSession(before: SessionSnapshot, now: SessionSnapshot): boolean {
  if (!now.accessToken) return false;
  if (before.sessionId || now.sessionId) return before.sessionId === now.sessionId;
  if (before.device?.id && now.device?.id) return before.device.id === now.device.id;
  return before.authEpoch === now.authEpoch;
}

type PersistedSession = {
  accessToken?: unknown;
  refreshToken?: unknown;
  sessionId?: unknown;
  user?: { id?: unknown } | null;
  device?: { id?: unknown } | null;
};

/** The auth state other tabs last wrote, or undefined when storage is empty or unreadable. */
function readPersistedSession(): PersistedSession | undefined {
  try {
    const state = JSON.parse(localStorage.getItem("e2ee-auth") ?? "null")?.state;
    return state && typeof state === "object" ? state : undefined;
  } catch {
    // Storage may be unavailable; the in-memory session can still be refreshed.
    return undefined;
  }
}

class ApiClient {
  private extractErrorMessage(body: unknown, fallback: string): string {
    if (typeof body === "string" && body.trim()) return body;
    if (!body || typeof body !== "object") return fallback;

    const record = body as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string" && error.trim()) return error;
    if (!error || typeof error !== "object") return fallback;

    const formErrors = Array.isArray((error as Record<string, unknown>).formErrors)
      ? ((error as Record<string, unknown>).formErrors as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [];
    if (formErrors.length > 0) return formErrors[0];

    const fieldErrors = (error as Record<string, unknown>).fieldErrors;
    if (fieldErrors && typeof fieldErrors === "object") {
      for (const value of Object.values(fieldErrors as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          const firstString = value.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
          if (firstString) return firstString;
        }
      }
    }

    return fallback;
  }

  private extractErrorCode(body: unknown): string | undefined {
    if (!body || typeof body !== "object") return undefined;
    const code = (body as Record<string, unknown>).code;
    return typeof code === "string" && code.trim() ? code : undefined;
  }

  private isAuthPath(path: string): boolean {
    return /^\/auth(?:\/|$)/.test(path);
  }

  private getHeaders(token: string | null): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return headers;
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(
        this.extractErrorMessage(body, res.statusText),
        res.status,
        this.extractErrorCode(body),
        body,
      );
    }
    return res.json();
  }

  private refreshToken(failedAccessToken: string | null, failedRefreshToken: string | null): Promise<void> {
    if (!refreshPromise) {
      const refresh = () => this.performRefresh(failedAccessToken, failedRefreshToken);
      refreshPromise = Promise.resolve(typeof navigator !== "undefined" && navigator.locks
        ? navigator.locks.request("e2ee-refresh", refresh)
        : refresh()
      ).finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  private async performRefresh(failedAccessToken: string | null, failedRefreshToken: string | null): Promise<void> {
    const persistedTokens = readPersistedSession();
    if (typeof persistedTokens?.accessToken === "string"
      && typeof persistedTokens.refreshToken === "string"
      && persistedTokens.refreshToken !== failedRefreshToken) {
      // Another tab rotated the tokens. Adopt them only if they are for this tab's session: the
      // other tab may instead have signed in as a different user or device. Refreshing our own
      // token here would also persist this tab's session over the newer one, so just fail.
      const current = useAuthStore.getState();
      const differs = (persisted: unknown, own: string | undefined) =>
        persisted != null && own != null && persisted !== own;
      if ((persistedTokens.sessionId ?? null) !== current.sessionId
        || differs(persistedTokens.device?.id, current.device?.id)
        || differs(persistedTokens.user?.id, current.user?.id)) {
        throw new ApiError("Session changed", 401);
      }
      current.setTokens(persistedTokens.accessToken, persistedTokens.refreshToken);
      return;
    }

    const { accessToken, refreshToken, setTokens } = useAuthStore.getState();
    if (accessToken && accessToken !== failedAccessToken) return;
    if (!refreshToken) {
      expireSession();
      throw new ApiError("Session expired", 401);
    }

    let res: Response;
    try {
      res = await fetch(resolveApiUrl("/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : "Network error", 0);
    }
    // The user may have logged out or switched accounts while this refresh was in flight;
    // its result belongs only to the session whose refresh token it redeemed.
    // Another tab may also have signed out or signed in as someone else before this tab's
    // storage listener rehydrated; committing would resurrect the old session for every tab.
    const stillSameSession = () => {
      if (useAuthStore.getState().refreshToken !== refreshToken) return false;
      const persisted = readPersistedSession();
      return !persisted || persisted.refreshToken === refreshToken;
    };
    if ((res.status === 401 || res.status === 403) && stillSameSession()) {
      expireSession();
    }
    const data = await this.handleResponse<{ accessToken: string; refreshToken: string }>(res);
    if (!stillSameSession()) throw new ApiError("Session changed", 401);
    setTokens(data.accessToken, data.refreshToken);
  }

  private async request<T>(path: string, options: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
  } = {}): Promise<T> {
    const before = useAuthStore.getState();
    const { accessToken, refreshToken } = before;
    const send = (token: string | null) => fetch(resolveApiUrl(path), {
      ...options,
      headers: { ...this.getHeaders(token), ...options.headers },
    });
    let res = await send(accessToken);
    if (res.status === 401 && accessToken && !this.isAuthPath(path)) {
      if (!isSameSession(before, useAuthStore.getState())) throw new ApiError("Session changed", 401);
      await this.refreshToken(accessToken, refreshToken);
      // Never replay a request from one session under another session's token.
      if (!isSameSession(before, useAuthStore.getState())) throw new ApiError("Session changed", 401);
      res = await send(useAuthStore.getState().accessToken);
    }
    return this.handleResponse<T>(res);
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async put<T>(path: string, body: ArrayBuffer | unknown): Promise<T> {
    const isBuffer = body instanceof ArrayBuffer;
    return this.request<T>(path, {
      method: "PUT",
      headers: isBuffer ? { "Content-Type": "application/octet-stream" } : undefined,
      body: isBuffer ? body : JSON.stringify(body),
    });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

export const api = new ApiClient();
