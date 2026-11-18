import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { packSprite } from "../features/stickers/pack-assets.js";
import { mockSpriteIO, spriteBase, spriteResponse, spriteSource } from "../features/stickers/pack-assets.test-utils.js";

const source = import.meta.glob<string>("../../public/sw.js", { query: "?raw", import: "default", eager: true })["../../public/sw.js"];
const origin = "https://chat.example.com";
const asset = (id: number, size = "thumb") => `${spriteBase}/packs/${size}/genshin-${id}.webp`;
type StickersEvent = { request: Request; clientId: string; respondWith: (response: Promise<Response>) => void; waitUntil: (job: Promise<unknown>) => void };
let onFetch: (event: StickersEvent) => void;
let cache: Map<string, Response>;
let markers: Map<string, Response>;
const RECENCY_CACHE = "private-base-sticker-recency-v2";
let clientUrl: string | undefined;
let maintenance: Promise<unknown>;
const fetchImage = vi.fn<(request: Request) => Promise<Response>>();
const openCache = vi.fn();
const key = (input: string | Request) => typeof input === "string" ? input : input.url;
const webp = (size = 200) => new Response("webp", { headers: { "Content-Type": "image/webp", "Content-Length": String(size) } });

function resetWorker() {
  const self = {
    addEventListener: (kind: string, handler: typeof onFetch) => { if (kind === "fetch") onFetch = handler; },
    location: { origin },
    clients: { get: async () => clientUrl ? { url: clientUrl } : undefined },
  };
  new Function("self", "caches", "fetch", source)(self, { open: openCache }, fetchImage);
}

function storage(map: Map<string, Response>) {
  return {
    keys: async () => [...map.keys()].map((url) => new Request(url)),
    match: async (input: string | Request) => map.get(key(input))?.clone(),
    put: async (input: string | Request, response: Response) => { map.set(key(input), response); },
    delete: async (input: string | Request) => map.delete(key(input)),
  };
}

beforeEach(() => {
  cache = new Map();
  markers = new Map();
  clientUrl = `${origin}/chat/c1`;
  fetchImage.mockReset().mockImplementation(async () => webp());
  const artworkCache = storage(cache);
  const recencyCache = storage(markers);
  openCache.mockReset().mockImplementation(async (name: string) => name === RECENCY_CACHE ? recencyCache : artworkCache);
  resetWorker();
});

function dispatch(url: string, options: RequestInit & { destination?: string; clientId?: string } = {}) {
  const req = new Request(url, { mode: "cors", ...options });
  Object.defineProperty(req, "destination", { value: options.destination ?? "" });
  let pending: Promise<Response> | undefined;
  maintenance = Promise.resolve();
  onFetch({ request: req, clientId: options.clientId ?? "page", respondWith: (response) => { pending = response; },
    waitUntil: (job) => { maintenance = job; } });
  return pending;
}

async function dispatchAndMaintain(url: string, options?: Parameters<typeof dispatch>[1]) {
  const response = await dispatch(url, options);
  await maintenance;
  return response;
}

it("serves a repeat sticker offline from a versioned cache without credentials or a referrer", async () => {
  const url = asset(21);
  expect(await (await dispatchAndMaintain(url))?.text()).toBe("webp");
  expect(openCache).toHaveBeenCalledWith("private-base-stickers-v2");
  expect(fetchImage.mock.calls[0][0]).toMatchObject({ url, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
  fetchImage.mockRejectedValue(new Error("offline"));
  expect(await (await dispatchAndMaintain(url))?.text()).toBe("webp");
  expect(fetchImage).toHaveBeenCalledTimes(1);
});

it("ignores all other origins, asset paths, request kinds and versions", () => {
  for (const url of [
    asset(21).replace("dist.718788.xyz", "elsewhere.example.com"),
    asset(21).replace("/v2/", "/v1/"),
    asset(21).replace("/thumb/", "/covers/"),
    `${spriteBase.replace("/v2", "/v1")}/thumbs/genshin_hoyolab_21.webp`,
    asset(21).replace(".webp", ".png"),
    asset(21) + "?anything",
    `${origin}/clients`,
    `${origin}/assets/app.js`,
  ]) expect(dispatch(url)).toBeUndefined();
  expect(dispatch(asset(21), { method: "POST" })).toBeUndefined();
  expect(dispatch(asset(21), { destination: "script" })).toBeUndefined();
  expect(dispatch(asset(21), { destination: "image", mode: "no-cors" })).toBeUndefined();
  expect(dispatch(asset(21), { destination: "", mode: "no-cors" })).toBeUndefined();
  expect(dispatch(asset(21), { clientId: "" })).toBeUndefined();
  expect(openCache).not.toHaveBeenCalled();
});

it.each(["/clients", "/clients/", "/clients/ios"])("does not cache image requests initiated by %s", async (path) => {
  clientUrl = `${origin}${path}`;
  expect((await dispatch(asset(21)))?.status).toBe(200);
  expect(openCache).not.toHaveBeenCalled();
});

it("does not store non-200, opaque or non-image responses", async () => {
  fetchImage.mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.error())
    .mockResolvedValueOnce(new Response("html", { status: 200, headers: { "Content-Type": "text/html" } }));
  await dispatch(asset(21));
  await dispatch(asset(21));
  await dispatch(asset(21));
  expect(cache.size).toBe(0);
  expect(fetchImage).toHaveBeenCalledTimes(3);
});

it("evicts the least recently used bytes across a worker restart", async () => {
  fetchImage.mockImplementation(async () => webp(18 * 1024 * 1024));
  await dispatchAndMaintain(asset(21), { destination: "" });
  await dispatchAndMaintain(asset(22), { destination: "" });
  await dispatchAndMaintain(asset(21), { destination: "" });
  resetWorker();
  await dispatchAndMaintain(asset(23, "full"), { destination: "" });
  expect([...cache.keys()]).toEqual([asset(21), asset(23, "full")]);
});

it("returns a cache hit before a cold LRU index is read or a rewrite can fail", async () => {
  const url = asset(21);
  cache.set(url, webp());
  cache.set(asset(22), webp());
  const stored = await openCache("private-base-stickers-v2");
  let completeIndex!: () => void;
  const pauseIndex = new Promise<void>((resolve) => { completeIndex = resolve; });
  vi.spyOn(stored, "keys").mockImplementation(async () => {
    await pauseIndex;
    return [...cache.keys()].map((key) => new Request(key));
  });
  vi.spyOn(await openCache(RECENCY_CACHE), "put").mockRejectedValue(new Error("recency write failed"));
  fetchImage.mockRejectedValue(new Error("offline"));
  try {
    expect(await (await dispatch(url, { destination: "" }))?.text()).toBe("webp");
    expect(fetchImage).not.toHaveBeenCalled();
  } finally { completeIndex(); }
  await maintenance;
  expect(cache.has(url)).toBe(true);
  expect(await (await dispatchAndMaintain(url, { destination: "" }))?.text()).toBe("webp");
  expect(fetchImage).not.toHaveBeenCalled();
});

afterEach(() => vi.unstubAllGlobals());

it("uses only pack network URLs for a partially warm cache and a failed full-size retry", async () => {
  const { network } = mockSpriteIO();
  const thumbUrl = asset(21);
  const fullUrl = asset(21, "full");
  cache.set(thumbUrl, spriteResponse(thumbUrl));
  fetchImage.mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockImplementation(async (request) => spriteResponse(request.url));
  network.mockImplementation(async (url, options) => {
    const response = await dispatchAndMaintain(url, { mode: options.mode, cache: options.cache });
    if (!response) throw new Error("Sprite bypassed the worker");
    return response;
  });
  const source = spriteSource(21);
  const thumb = packSprite(source, "thumb");
  const full = packSprite(source, "full");
  const releaseThumb = thumb.subscribe(() => undefined);
  const releaseFull = full.subscribe(() => undefined);
  const releaseOtherFull = full.subscribe(() => undefined);
  try {
    await thumb.start();
    await full.start();
    expect(thumb.snapshot().state).toBe("ready");
    expect(full.snapshot().state).toBe("failed");
    await full.retry();
    expect(full.snapshot().state).toBe("ready");
    expect(network.mock.calls.map(([url]) => url)).toEqual([thumbUrl, fullUrl, fullUrl]);
    expect(fetchImage.mock.calls.map(([request]) => request.url)).toEqual([fullUrl, fullUrl]);
  } finally { releaseThumb(); releaseFull(); releaseOtherFull(); }
});

it("reloads a cached bad 200 sprite over the network and replaces it with the valid response", async () => {
  const { network, decode } = mockSpriteIO();
  const url = asset(22, "full");
  const bad = spriteResponse(asset(23, "full"));
  cache.set(url, bad);
  fetchImage.mockImplementation(async (request) => spriteResponse(request.url));
  network.mockImplementation(async (url, { mode, cache }) => {
    const response = await dispatchAndMaintain(url, { mode, cache });
    if (!response) throw new Error("Sprite bypassed the worker");
    return response;
  });

  const sprite = packSprite(spriteSource(22), "full");
  const release = sprite.subscribe(() => undefined);
  try {
    await sprite.start();
    expect(sprite.snapshot().state).toBe("failed");
    expect(decode).not.toHaveBeenCalled();
    expect(fetchImage).not.toHaveBeenCalled();
    await sprite.retry();
    expect(sprite.snapshot().state).toBe("ready");
    expect(fetchImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      url, cache: "reload", credentials: "omit", referrerPolicy: "no-referrer",
    }));
    expect(await (await dispatchAndMaintain(url))?.text()).toBe(await spriteResponse(url).text());
    expect(fetchImage).toHaveBeenCalledTimes(1);
  } finally { release(); }
});
