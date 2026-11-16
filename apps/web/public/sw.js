/* Generic Web Push only. No session credentials, application assets, or offline cache. */
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
    if (payload.v !== 1 || !["message", "call"].includes(payload.type)) return;
    const call = payload.type === "call";
    if (call && (typeof payload.callId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.callId))) return;
    const stored = await cache.match("/__push_locale");
    const locale = stored ? await stored.json() : {};
    const title = call ? locale.call || "Incoming call" : locale.message || "New message";
    await self.registration.showNotification(title, {
      lang: locale.locale || "en", icon: "/apple-touch-icon.png",
      tag: call ? `call-${payload.callId}` : "new-message",
      data: { url: call ? `/call/${payload.callId}?push=call` : "/?push=message" },
    });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const path = event.notification.data?.url;
    const safe = path === "/?push=message" || /^\/call\/[A-Za-z0-9_-]{1,128}\?push=call$/.test(path);
    const destination = safe ? path : "/";
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Passkey handoff pages mount without the app router, so they cannot take push-open.
    const existing = windows.find((client) => {
      const url = new URL(client.url);
      return url.origin === self.location.origin && !url.pathname.startsWith("/native/passkey/");
    });
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: "push-open", destination });
    } else await self.clients.openWindow("/");
  })());
});
