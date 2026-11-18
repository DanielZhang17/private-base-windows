/* Generic Web Push and a runtime cache for public sticker assets. */
const PUSH_CACHE = "private-base-push-v1";
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PUSH_CACHE);
    const enabled = await cache.match("/__push_enabled");
    if (!enabled || await enabled.json() !== true) return;
    let payload = { type: "message", v: 1 };
    if (event.data) {
      try { payload = event.data.json(); } catch { return; }
    }
    if (payload.v !== 1 || !["message", "call", "device_added", "approval_disabled"].includes(payload.type)) return;
    const call = payload.type === "call";
    const deviceAdded = payload.type === "device_added";
    const approvalDisabled = payload.type === "approval_disabled";
    const securityAlert = deviceAdded || approvalDisabled;
    if (call && (typeof payload.callId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.callId))) return;
    const stored = await cache.match("/__push_locale");
    const locale = stored ? await stored.json() : {};
    const title = call ? locale.call || "Incoming call" : securityAlert ? "Private Base" : locale.message || "New message";
    await self.registration.showNotification(title, {
      ...(securityAlert ? { body: approvalDisabled
        ? locale.approvalDisabled || "A security setting changed on your account. Open Private Base to review."
        : locale.deviceAdded || "A new device signed in to your account. Open Private Base to review." } : {}),
      lang: locale.locale || "en", icon: "/apple-touch-icon.png",
      tag: call ? `call-${payload.callId}` : securityAlert ? payload.type.replace("_", "-") : "new-message",
      data: { url: call ? `/call/${payload.callId}?push=call` : deviceAdded ? "/devices" : approvalDisabled ? "/settings?section=privacy" : "/?push=message" },
    });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const path = event.notification.data?.url;
    const safe = path === "/?push=message" || path === "/devices" || path === "/settings?section=privacy" || /^\/call\/[A-Za-z0-9_-]{1,128}\?push=call$/.test(path);
    const destination = safe ? path : "/";
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Passkey handoff and download pages mount without the app router, so they cannot take push-open.
    const existing = windows.find((client) => {
      const url = new URL(client.url);
      let pathname = url.pathname;
      try { pathname = decodeURI(pathname); } catch { /* Use the raw path for malformed escapes. */ }
      pathname = pathname.toLowerCase();
      return url.origin === self.location.origin
        && !url.pathname.startsWith("/native/passkey/")
        && pathname !== "/clients" && !pathname.startsWith("/clients/");
    });
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: "push-open", destination });
    } else await self.clients.openWindow((destination === "/devices" || destination === "/settings?section=privacy") ? destination : "/");
  })());
});

// Readable, immutable sticker images only. Separate recency markers preserve
// LRU order across worker restarts without rewriting a usable cached image.
const STICKER_ORIGIN = "https://dist.718788.xyz";
const STICKER_PATH = /^\/private-base\/assets\/stickers\/genshin\/v2\/packs\/(?:thumb|full)\/genshin-[1-9][0-9]*\.webp$/;
const STICKER_CACHE = "private-base-stickers-v2";
const STICKER_RECENCY = "private-base-sticker-recency-v2";
const STICKER_BUDGET = 40 * 1024 * 1024;
let stickerQueue = Promise.resolve();
let stickerIndex;

function withStickerCache(operation) {
  const next = stickerQueue.then(operation);
  stickerQueue = next.catch(() => { stickerIndex = undefined; });
  return next;
}

async function imageBytes(response) {
  const length = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(length) && length > 0 ? length : (await response.clone().arrayBuffer()).byteLength;
}

async function readStickerIndex(cache) {
  const entries = new Map();
  let bytes = 0;
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (!response) continue;
    const size = await imageBytes(response);
    entries.set(request.url, size);
    bytes += size;
  }
  const recency = await caches.open(STICKER_RECENCY).catch(() => undefined);
  const markers = await recency?.keys().catch(() => []) ?? [];
  for (const { url } of markers) {
    const size = entries.get(url);
    if (size === undefined) continue;
    entries.delete(url);
    entries.set(url, size);
  }
  return { entries, bytes, recency };
}

async function markStickerRecent(index, url) {
  if (!index.recency) return;
  try {
    await index.recency.delete(url);
    await index.recency.put(url, new Response(null));
  } catch {
    // The in-memory order is still current, and the cached image is untouched.
  }
}

async function serveSticker(event, maintain) {
  const request = new Request(event.request, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
  });
  const client = await self.clients.get(event.clientId).catch(() => undefined);
  const page = client && new URL(client.url);
  if (!page || page.origin !== self.location.origin || page.pathname === "/clients" || page.pathname.startsWith("/clients/")) {
    return fetch(request);
  }
  const cache = await caches.open(STICKER_CACHE).catch(() => undefined);
  if (!cache) return fetch(request);

  const refresh = request.cache === "reload";
  const cached = refresh ? undefined : await cache.match(request.url).catch(() => undefined);
  if (cached) {
    maintain(withStickerCache(async () => {
      const index = stickerIndex ??= await readStickerIndex(cache);
      const size = index.entries.get(request.url);
      if (size === undefined || Array.from(index.entries.keys()).at(-1) === request.url) return;
      index.entries.delete(request.url);
      index.entries.set(request.url, size);
      await markStickerRecent(index, request.url);
    }));
    return cached;
  }

  const response = await fetch(request);
  if (response.status !== 200 || response.type === "opaque" || response.redirected ||
      !/^image\/webp(?:;|$)/i.test(response.headers.get("content-type") || "")) return response;
  const copy = response.clone();
  maintain(withStickerCache(async () => {
    const index = stickerIndex ??= await readStickerIndex(cache);
    const previousSize = index.entries.get(request.url) ?? 0;
    if (!refresh && previousSize) return;
    const size = await imageBytes(copy);
    if (size > STICKER_BUDGET) return;
    for (const [url, length] of index.entries) {
      if (index.bytes - previousSize + size <= STICKER_BUDGET) break;
      if (url === request.url) continue;
      await cache.delete(url);
      await index.recency?.delete(url).catch(() => undefined);
      index.entries.delete(url);
      index.bytes -= length;
    }
    await cache.put(request.url, copy);
    index.entries.delete(request.url);
    index.entries.set(request.url, size);
    index.bytes += size - previousSize;
    await markStickerRecent(index, request.url);
  }));
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const artwork = request.destination === "" && request.mode === "cors";
  if (!event.clientId || request.method !== "GET" || !artwork) return;
  const url = new URL(request.url);
  if (url.origin !== STICKER_ORIGIN || url.search || !STICKER_PATH.test(url.pathname)) return;
  let maintenance;
  const response = serveSticker(event, (job) => { maintenance = job.catch(() => undefined); });
  event.respondWith(response);
  event.waitUntil(response.then(() => maintenance, () => undefined));
});
