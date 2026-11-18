/** Public release manifest for the native clients. No session, token or cookie is ever sent. */
export const DOWNLOAD_ORIGIN = "https://dist.718788.xyz";
export const MANIFEST_URL = `${DOWNLOAD_ORIGIN}/private-base/releases/latest.json`;
export const NOTES_URL = `${DOWNLOAD_ORIGIN}/private-base/releases/notes.json`;
export const MANIFEST_TIMEOUT_MS = 8_000;

export type PlatformKey = "macos" | "windows" | "android" | "ios";
/** Fixed order of the platform list (spec 2). */
export const PLATFORM_ORDER: readonly PlatformKey[] = ["macos", "windows", "android", "ios"];

export interface PlatformBuild {
  file: string;
  /** Always an https://dist.718788.xyz URL. */
  url: string;
  size: number;
  /** 64 lower-case hex characters. */
  sha256: string;
  arch: string;
  minOs: string;
}

export interface ReleaseManifest {
  version: string;
  published: Date;
  /** null: the platform has no build yet ("Coming soon"). */
  platforms: Record<PlatformKey, PlatformBuild | null>;
}

export class ManifestError extends Error {
  constructor(reason: string) {
    super(`Invalid release manifest: ${reason}`);
    this.name = "ManifestError";
  }
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const SHORT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
// Printable text without markup or control characters, e.g. "macOS 12.3".
const MIN_OS = /^[^\p{Cc}<>]{1,64}$/u;
const MAX_SIZE = 2 ** 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMatching(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value.trim()) || value.trim() !== value) throw new ManifestError(field);
  return value;
}

/** Accepts only https URLs on exactly the download origin, without credentials. */
export function isTrustedDownloadUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.origin === DOWNLOAD_ORIGIN && url.protocol === "https:" && !url.username && !url.password && url.port === "";
}

function parseBuild(value: unknown, key: PlatformKey): PlatformBuild | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new ManifestError(`platforms.${key}`);
  if (!isTrustedDownloadUrl(value.url)) throw new ManifestError(`platforms.${key}.url`);
  const size = value.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_SIZE) {
    throw new ManifestError(`platforms.${key}.size`);
  }
  return {
    file: stringMatching(value.file, FILE_NAME, `platforms.${key}.file`),
    url: new URL(value.url).href,
    size,
    sha256: stringMatching(value.sha256, SHA256, `platforms.${key}.sha256`).toLowerCase(),
    arch: stringMatching(value.arch, SHORT_TOKEN, `platforms.${key}.arch`),
    minOs: stringMatching(value.minOs, MIN_OS, `platforms.${key}.minOs`),
  };
}

/**
 * Validates the shape of latest.json. Any malformed or foreign-origin platform entry
 * rejects the whole manifest, so the page never offers a download it cannot vouch for.
 */
export function parseReleaseManifest(input: unknown): ReleaseManifest {
  if (!isRecord(input)) throw new ManifestError("root");
  const version = stringMatching(input.version, VERSION, "version");
  if (typeof input.published !== "string") throw new ManifestError("published");
  const published = new Date(input.published);
  if (Number.isNaN(published.getTime())) throw new ManifestError("published");
  if (!isRecord(input.platforms)) throw new ManifestError("platforms");
  const raw = input.platforms;
  const platforms = Object.fromEntries(
    PLATFORM_ORDER.map((key) => [key, parseBuild(raw[key], key)]),
  ) as Record<PlatformKey, PlatformBuild | null>;
  return { version, published, platforms };
}

/** Fetches public release metadata without sharing browser credentials. */
export async function fetchReleaseJson(url: typeof MANIFEST_URL | typeof NOTES_URL, signal?: AbortSignal, timeoutMs = MANIFEST_TIMEOUT_MS): Promise<unknown> {
  if (signal?.aborted) throw new DOMException("Release request aborted", "AbortError");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new ManifestError(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Fetches and validates the manifest. Rejects on network errors, timeout, non-2xx and bad JSON. */
export async function fetchReleaseManifest(signal?: AbortSignal, timeoutMs = MANIFEST_TIMEOUT_MS): Promise<ReleaseManifest> {
  return parseReleaseManifest(await fetchReleaseJson(MANIFEST_URL, signal, timeoutMs));
}
