import { isNative } from "../platform/environment.js";

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

export const API_BASE_URL = resolveApiBaseUrl();
export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE_URL}${path}`;
}

