import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchReleaseManifest, isTrustedDownloadUrl, ManifestError, MANIFEST_URL, parseReleaseManifest } from "./manifest.js";
import { LATEST } from "./manifest.fixture.js";

type Entry = Record<string, unknown>;
type Input = Record<string, unknown> & { platforms: Record<string, unknown> };
const clone = () => structuredClone(LATEST) as unknown as Input;
const entry = (input: Input, key: string) => input.platforms[key] as Entry;

describe("parseReleaseManifest", () => {
  it("accepts the real manifest and normalises it", () => {
    const manifest = parseReleaseManifest(LATEST);
    expect(manifest.version).toBe("0.0.1-20261115");
    expect(manifest.published.toISOString()).toBe("2026-11-17T05:10:53.000Z");
    expect(manifest.platforms.ios).toBeNull();
    expect(manifest.platforms.macos).toEqual({
      file: LATEST.platforms.macos.file,
      url: LATEST.platforms.macos.url,
      size: 4764074,
      sha256: LATEST.platforms.macos.sha256,
      arch: "arm64",
      minOs: "macOS 12.3",
    });
    expect(Object.keys(manifest.platforms)).toEqual(["macos", "windows", "android", "ios"]);
  });

  it("treats a missing platform as not available and lower-cases checksums", () => {
    const input = clone();
    delete input.platforms.android;
    entry(input, "windows").sha256 = LATEST.platforms.windows.sha256.toUpperCase();
    const manifest = parseReleaseManifest(input);
    expect(manifest.platforms.android).toBeNull();
    expect(manifest.platforms.windows?.sha256).toBe(LATEST.platforms.windows.sha256);
  });

  it.each<[string, (input: Input) => unknown]>([
    ["a non-object root", () => "latest"],
    ["an array root", () => []],
    ["a missing version", (input) => { delete input.version; return input; }],
    ["markup in the version", (input) => ({ ...input, version: "<b>1</b>" })],
    ["an unparseable publish date", (input) => ({ ...input, published: "soon" })],
    ["missing platforms", (input) => ({ ...input, platforms: null })],
    ["a non-object platform", (input) => { input.platforms.macos = "yes"; return input; }],
    ["a short checksum", (input) => { entry(input, "macos").sha256 = "abc"; return input; }],
    ["a non-hex checksum", (input) => { entry(input, "macos").sha256 = "z".repeat(64); return input; }],
    ["a negative size", (input) => { entry(input, "macos").size = -1; return input; }],
    ["a string size", (input) => { entry(input, "macos").size = "4 MB"; return input; }],
    ["a path in the file name", (input) => { entry(input, "macos").file = "../evil.dmg"; return input; }],
    ["shell characters in the file name", (input) => { entry(input, "macos").file = "a;rm -rf.dmg"; return input; }],
    ["a missing minOs", (input) => { delete entry(input, "macos").minOs; return input; }],
  ])("rejects %s", (_label, mutate) => {
    expect(() => parseReleaseManifest(mutate(clone()))).toThrow(ManifestError);
  });

  it.each([
    "https://evil.example/PrivateBase.dmg",
    "http://dist.718788.xyz/private-base/releases/a.dmg",
    "https://dist.718788.xyz.evil.example/a.dmg",
    "https://user:pass@dist.718788.xyz/a.dmg",
    "https://dist.718788.xyz:8443/a.dmg",
    "javascript:alert(1)",
    "//dist.718788.xyz/a.dmg",
    "/private-base/releases/a.dmg",
  ])("rejects the whole manifest for a download URL outside the origin: %s", (url) => {
    const input = clone();
    entry(input, "windows").url = url;
    expect(isTrustedDownloadUrl(url)).toBe(false);
    expect(() => parseReleaseManifest(input)).toThrow(/platforms\.windows\.url/);
  });
});

describe("fetchReleaseManifest", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("fetches without credentials or cache and validates the body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(LATEST), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const manifest = await fetchReleaseManifest();
    expect(manifest.version).toBe(LATEST.version);
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST_URL, expect.objectContaining({ cache: "no-store", credentials: "omit" }));
  });

  it.each([
    ["a non-200 response", () => new Response("missing", { status: 404 })],
    ["invalid JSON", () => new Response("{", { status: 200 })],
    ["a foreign download URL", () => new Response(JSON.stringify({ ...LATEST, platforms: { ...LATEST.platforms, macos: { ...LATEST.platforms.macos, url: "https://evil.example/a.dmg" } } }), { status: 200 })],
  ])("rejects %s", async (_label, respond) => {
    vi.stubGlobal("fetch", vi.fn(async () => respond()));
    await expect(fetchReleaseManifest()).rejects.toThrow();
  });

  it("aborts after the timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const result = expect(fetchReleaseManifest(undefined, 8_000)).rejects.toThrow(/Aborted/);
    await vi.advanceTimersByTimeAsync(8_000);
    await result;
  });
});
