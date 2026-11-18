import { beforeEach, expect, it, vi } from "vitest";
const source = import.meta.glob<string>("../../public/sw.js", { query: "?raw", import: "default", eager: true })["../../public/sw.js"];
let handlers: Record<string, (event: any) => void>;
let cache: Map<string, unknown>;
let worker: any;
async function dispatch(type: string, extra = {}) {
  let pending: Promise<unknown> = Promise.resolve();
  handlers[type]({ ...extra, waitUntil(promise: Promise<unknown>) { pending = promise; } });
  await pending;
}
beforeEach(() => {
  cache = new Map<string, unknown>([["/__push_enabled", true], ["/__push_locale", { locale: "de", message: "Neue Nachricht", call: "Eingehender Anruf", deviceAdded: "Neues Gerät angemeldet" }]]);
  handlers = {};
  worker = {
    addEventListener: (type: string, callback: (event: any) => void) => { handlers[type] = callback; },
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn() },
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => []), openWindow: vi.fn() },
    location: { origin: "https://chat.example.com" },
  };
  new Function("self", "caches", source)(worker, {
    open: async () => ({ match: async (key: string) => cache.has(key) ? { json: async () => cache.get(key) } : undefined }),
  });
});
it("activates without caching application code", async () => {
  expect(Object.keys(handlers).sort()).toEqual(["activate", "fetch", "install", "notificationclick", "push"]);
  await dispatch("install"); await dispatch("activate");
  expect(worker.skipWaiting).toHaveBeenCalled(); expect(worker.clients.claim).toHaveBeenCalled();
});
it("displays translated generic message and call notifications without copying payload metadata", async () => {
  await dispatch("push", { data: { json: () => ({ type: "message", v: 1, senderName: "Alice", content: "Secret" }) } });
  expect(worker.registration.showNotification).toHaveBeenLastCalledWith("Neue Nachricht", {
    lang: "de", icon: "/apple-touch-icon.png", tag: "new-message", data: { url: "/?push=message" },
  });
  await dispatch("push", { data: { json: () => ({ type: "call", v: 1, callId: "call-1", senderName: "Bob" }) } });
  expect(worker.registration.showNotification).toHaveBeenLastCalledWith("Eingehender Anruf", expect.objectContaining({ data: { url: "/call/call-1?push=call" } }));
  expect(JSON.stringify(worker.registration.showNotification.mock.calls)).not.toMatch(/Secret|Alice|Bob/);
});
it("shows a generic device alert and opens the linked-device screen", async () => {
  await dispatch("push", { data: { json: () => ({ type: "device_added", v: 1, deviceName: "Private device" }) } });
  expect(worker.registration.showNotification).toHaveBeenCalledWith("Private Base", {
    body: "Neues Gerät angemeldet", lang: "de", icon: "/apple-touch-icon.png", tag: "device-added", data: { url: "/devices" },
  });
  await dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/devices" } } });
  expect(worker.clients.openWindow).toHaveBeenCalledWith("/devices");
});
it("handles an empty wake-up and uses English only when locale storage is absent", async () => {
  cache.delete("/__push_locale");
  await dispatch("push");
  expect(worker.registration.showNotification).toHaveBeenCalledWith("New message", expect.anything());
});
it("suppresses queued pushes after lock or sign-out", async () => {
  cache.set("/__push_enabled", false);
  await dispatch("push");
  expect(worker.registration.showNotification).not.toHaveBeenCalled();
});
it.each([{ type: "call", v: 1, callId: "../evil" }, { type: "message", v: 2 }, { type: "other", v: 1 }])("discards invalid payload %j", async (payload) => {
  await dispatch("push", { data: { json: () => payload } });
  expect(worker.registration.showNotification).not.toHaveBeenCalled();
});
it("focuses and messages a live client without reloading it", async () => {
  const client = { url: "https://chat.example.com/", navigate: vi.fn(), focus: vi.fn(), postMessage: vi.fn() };
  worker.clients.matchAll.mockResolvedValue([client]);
  const close = vi.fn();
  await dispatch("notificationclick", { notification: { close, data: { url: "/call/call-1?push=call" } } });
  expect(client.navigate).not.toHaveBeenCalled();
  expect(client.postMessage).toHaveBeenCalledWith({ type: "push-open", destination: "/call/call-1?push=call" });
  expect(worker.clients.openWindow).not.toHaveBeenCalled();
  expect(client.focus).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
});
it("skips passkey handoff tabs, which cannot route push-open", async () => {
  const handoff = { url: "https://chat.example.com/native/passkey/sign-in?state=x", navigate: vi.fn(), focus: vi.fn(), postMessage: vi.fn() };
  const app = { url: "https://chat.example.com/chat/c1", navigate: vi.fn(), focus: vi.fn(), postMessage: vi.fn() };
  worker.clients.matchAll.mockResolvedValue([handoff, app]);
  await dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?push=message" } } });
  expect(handoff.postMessage).not.toHaveBeenCalled();
  expect(app.postMessage).toHaveBeenCalledWith({ type: "push-open", destination: "/?push=message" });
  worker.clients.matchAll.mockResolvedValue([handoff]);
  await dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?push=message" } } });
  expect(worker.clients.openWindow).toHaveBeenCalledWith("/");
});
it.each(["/clients", "/clients/", "/clients/releases", "/Clients/Releases//", "/%63lients/%72eleases", "/clients/ios?platform=ios"])("skips download tabs at %s, which cannot route push-open", async (path) => {
  const downloads = { url: `https://chat.example.com${path}`, focus: vi.fn(), postMessage: vi.fn() };
  const app = { url: "https://chat.example.com/chat/c1", focus: vi.fn(), postMessage: vi.fn() };
  worker.clients.matchAll.mockResolvedValue([downloads, app]);
  await dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?push=message" } } });
  expect(downloads.focus).not.toHaveBeenCalled();
  expect(downloads.postMessage).not.toHaveBeenCalled();
  expect(app.focus).toHaveBeenCalled();
  expect(app.postMessage).toHaveBeenCalledWith({ type: "push-open", destination: "/?push=message" });
  expect(worker.clients.openWindow).not.toHaveBeenCalled();
  worker.clients.matchAll.mockResolvedValue([downloads]);
  await dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?push=message" } } });
  expect(downloads.focus).not.toHaveBeenCalled();
  expect(downloads.postMessage).not.toHaveBeenCalled();
  expect(worker.clients.openWindow).toHaveBeenCalledWith("/");
});
it("rejects external click targets and opens a fresh same-origin window", async () => {
  await dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "https://evil.example.com" } } });
  expect(worker.clients.openWindow).toHaveBeenCalledWith("/");
});
it("opens normal app routing without a destination when no app window exists", async () => {
  await dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?push=message" } } });
  expect(worker.clients.openWindow).toHaveBeenCalledWith("/");
});

it("routes a generic approval-disabled push to Privacy", async () => {
  await dispatch("push", { data: { json: () => ({ type: "approval_disabled", v: 1, actingDeviceName: "Private device" }) } });
  expect(worker.registration.showNotification).toHaveBeenCalledWith("Private Base", expect.objectContaining({
    body: "A security setting changed on your account. Open Private Base to review.",
    data: { url: "/settings?section=privacy" },
  }));
});
