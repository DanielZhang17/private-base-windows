import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  native: false,
  auth: { accessToken: "token-bob", user: { id: "bob" }, device: { id: "bob-device" }, sessionId: "session-bob" },
  get: vi.fn(), post: vi.fn(),
}));
vi.mock("../platform/environment.js", () => ({ isNative: () => mocks.native }));
vi.mock("../stores/authStore.js", () => ({ useAuthStore: { getState: () => mocks.auth } }));
vi.mock("./api.js", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("./api-url.js", () => ({ resolveApiUrl: (path: string) => `https://api.example.com${path}` }));
import { disableWebPush, enableWebPush, iosPushHint, showWebPushSettings, storePushLocale, supportsWebPush, webPushEnabled } from "./web-push.js";

let active: object | null;
const subscription = { endpoint: "https://push.example.org/opaque", toJSON: () => ({ endpoint: "https://push.example.org/opaque", keys: { p256dh: "public", auth: "auth" } }), unsubscribe: vi.fn(async () => { active = null; return true; }) };
const registration = {
  pushManager: { getSubscription: vi.fn(async () => active), subscribe: vi.fn(async () => { active = subscription; return subscription; }) },
  getNotifications: vi.fn(async () => []),
};
let serviceWorker: { register: ReturnType<typeof vi.fn>; getRegistration: ReturnType<typeof vi.fn>; ready: Promise<typeof registration> };
let cache: Map<string, Response>;
let requestPermission: ReturnType<typeof vi.fn>;
beforeEach(() => {
  active = null; mocks.native = false;
  mocks.auth = { accessToken: "token-bob", user: { id: "bob" }, device: { id: "bob-device" }, sessionId: "session-bob" };
  cache = new Map();
  vi.stubGlobal("caches", { open: vi.fn(async () => ({
    put: async (key: string, response: Response) => { cache.set(key, response); },
    match: async (key: string) => cache.get(key)?.clone(),
  })) });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  requestPermission = vi.fn(async () => "granted");
  vi.stubGlobal("Notification", { requestPermission });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  serviceWorker = { register: vi.fn(async () => registration), getRegistration: vi.fn(async () => registration), ready: Promise.resolve(registration) };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
  mocks.get.mockResolvedValue({ publicKey: "BA".padEnd(87, "A") });
  mocks.post.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  await disableWebPush().catch(() => undefined);
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks();
  Reflect.deleteProperty(navigator, "serviceWorker");
});
it("requests permission in the gesture and subscribes with the API VAPID key", async () => {
  const enabled = enableWebPush();
  expect(requestPermission).toHaveBeenCalledTimes(1);
  await enabled;
  expect(serviceWorker.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
  expect(registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) });
  expect(mocks.post).toHaveBeenCalledWith("/api/push/subscribe", subscription.toJSON());
  expect(await webPushEnabled()).toBe(true);
  expect(await cache.get("/__push_enabled")!.json()).toBe(true);
  expect(await cache.get("/__push_owner")!.json()).toEqual({ userId: "bob", deviceId: "bob-device", loginIdentity: "session:session-bob", endpoint: subscription.endpoint });
});
it("off unsubscribes, deletes using captured credentials and clears displayed notifications", async () => {
  await enableWebPush();
  const close = vi.fn(); registration.getNotifications.mockResolvedValueOnce([{ close }] as never);
  mocks.auth.accessToken = "new-account-token";
  await disableWebPush("captured-token");
  expect(subscription.unsubscribe).toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledWith("https://api.example.com/api/push/subscribe", { method: "DELETE", headers: { Authorization: "Bearer captured-token", "Content-Type": "application/json" }, keepalive: true, body: JSON.stringify({ endpoint: subscription.endpoint }) });
  expect(close).toHaveBeenCalled();
  expect(await webPushEnabled()).toBe(false);
  expect(await cache.get("/__push_enabled")!.json()).toBe(false);
});
it("a denied permission creates no subscription", async () => {
  requestPermission.mockResolvedValue("denied");
  await expect(enableWebPush()).rejects.toThrow();
  expect(serviceWorker.register).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});
it.each(["lock", "account-change"])("invalidates a delayed permission grant on %s", async (reason) => {
  let grant!: (value: string) => void;
  requestPermission.mockReturnValue(new Promise((resolve) => { grant = resolve; }));
  const enabling = enableWebPush().catch(() => undefined);
  const teardown = reason === "lock" ? disableWebPush() : Promise.resolve();
  if (reason === "account-change") mocks.auth = { ...mocks.auth, sessionId: "new-session" };
  await teardown; // Cleanup cannot wait for a user to answer the permission prompt.
  grant("granted");
  await enabling; await teardown;
  expect(serviceWorker.register).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});
it("still removes the server subscription if the browser unsubscribe fails", async () => {
  await enableWebPush();
  subscription.unsubscribe.mockRejectedValueOnce(new Error("Browser push service unavailable"));
  await expect(disableWebPush()).rejects.toThrow("Push cleanup failed");
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/push/subscribe"), expect.objectContaining({ method: "DELETE" }));
  expect(await cache.get("/__push_enabled")!.json()).toBe(false);
});
it("rolls back browser subscription when API registration fails", async () => {
  mocks.post.mockRejectedValueOnce(new Error("Registration failed"));
  await expect(enableWebPush()).rejects.toThrow("Registration failed");
  expect(subscription.unsubscribe).toHaveBeenCalled();
  expect(await webPushEnabled()).toBe(false);
});
it("stores only translated generic strings and locale for the worker", async () => {
  await storePushLocale("de", "Neue Nachricht", "Eingehender Anruf");
  expect(await cache.get("/__push_locale")!.json()).toEqual({ locale: "de", message: "Neue Nachricht", call: "Eingehender Anruf" });
});
it("hides Web Push in Tauri and shows the iOS Home Screen hint", () => {
  mocks.native = true;
  expect(supportsWebPush()).toBe(false); expect(showWebPushSettings()).toBe(false);
  mocks.native = false;
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  expect(iosPushHint()).toBe(true); expect(supportsWebPush()).toBe(false); expect(showWebPushSettings()).toBe(true);
});
it.each([true, false])("keeps a replacement endpoint during two-tab Off/On interleaving (Web Locks: %s)", async (withLocks) => {
  let lockQueue: Promise<unknown> = Promise.resolve();
  const lockRequest = vi.fn((_name: string, operation: () => Promise<void>) => {
    const result = lockQueue.then(operation);
    lockQueue = result.catch(() => undefined);
    return result;
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: withLocks ? { request: lockRequest } : undefined });
  try {
    // Import independent module instances to model two tabs, sharing only browser APIs and locks.
    vi.resetModules();
    const tabA = await import("./web-push.js");
    vi.resetModules();
    const tabB = await import("./web-push.js");
    const replacement = { ...subscription, endpoint: "https://push.example.org/replacement",
      toJSON: () => ({ ...subscription.toJSON(), endpoint: "https://push.example.org/replacement" }) };
    const stored = new Set<string>();
    mocks.post.mockImplementation(async (_path, body) => { stored.add(body.endpoint); });
    await tabA.enableWebPush();
    expect(stored.has(subscription.endpoint)).toBe(true);
    let finishDelete!: () => void;
    vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
      const { endpoint } = JSON.parse(init!.body as string);
      expect(endpoint).toBe(subscription.endpoint);
      await new Promise<void>((resolve) => { finishDelete = resolve; });
      stored.delete(endpoint);
      return new Response("{}");
    });
    const off = tabA.disableWebPush();
    await vi.waitFor(() => expect(finishDelete).toBeDefined());
    registration.pushManager.subscribe.mockImplementationOnce(async () => { active = replacement; return replacement; });
    const on = tabB.enableWebPush();
    if (withLocks) {
      await vi.waitFor(() => expect(lockRequest).toHaveBeenCalledTimes(3));
      expect(stored.has(replacement.endpoint)).toBe(false);
    } else {
      await on; // Without Web Locks, the delayed DELETE must still affect only the old endpoint.
      expect(stored.has(replacement.endpoint)).toBe(true);
    }
    finishDelete(); await off; await on;
    expect(stored).toEqual(new Set([replacement.endpoint]));
    if (withLocks) expect(lockRequest.mock.calls.every(([name]) => name === "private-base-push")).toBe(true);
  } finally { Reflect.deleteProperty(navigator, "locks"); }
});
it("uses device-wide deletion only for explicit lock/sign-out teardown", async () => {
  await enableWebPush();
  await disableWebPush("token", { accountTeardown: true });
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ all: true }) }));
});
it("deletes only the session's recorded endpoint when browser ownership cannot be verified", async () => {
  await enableWebPush();
  serviceWorker.getRegistration.mockRejectedValueOnce(new Error("Browser storage unavailable"));
  await expect(disableWebPush("token", { accountTeardown: true })).rejects.toThrow("Push cleanup failed");
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ endpoint: subscription.endpoint }) }));
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
  expect(await cache.get("/__push_enabled")!.json()).toBe(true);
});
it.each([
  { userId: "alice", deviceId: "alice-device", sameEndpoint: false },
  { userId: "alice", deviceId: "alice-device", sameEndpoint: true },
  { userId: "bob", deviceId: "bob-new-device", sameEndpoint: true },
])("a stale session leaves $userId/$deviceId push intact (same endpoint: $sameEndpoint)", async ({ userId, deviceId, sameEndpoint }) => {
  const oldSession = { userId: "bob", deviceId: "bob-device", loginIdentity: "session:session-bob" };
  await enableWebPush();
  const replacement = { endpoint: sameEndpoint ? subscription.endpoint : "https://push.example.org/alice",
    toJSON: () => ({ ...subscription.toJSON(), endpoint: sameEndpoint ? subscription.endpoint : "https://push.example.org/alice" }),
    unsubscribe: vi.fn(async () => { active = null; return true; }),
  };
  mocks.auth = { accessToken: "token-alice", user: { id: userId }, device: { id: deviceId }, sessionId: "session-alice" };
  registration.pushManager.subscribe.mockImplementationOnce(async () => { active = replacement; return replacement; });
  await enableWebPush();
  vi.clearAllMocks();
  await disableWebPush("token-bob", { accountTeardown: true, session: oldSession });
  expect(active).toBe(replacement);
  expect(replacement.unsubscribe).not.toHaveBeenCalled();
  expect(registration.getNotifications).not.toHaveBeenCalled();
  expect(await webPushEnabled()).toBe(true);
  expect(await cache.get("/__push_enabled")!.json()).toBe(true);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.example.com/api/push/subscribe", expect.objectContaining({
    headers: { Authorization: "Bearer token-bob", "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }));
});
it("does not unsubscribe when the browser endpoint differs from the recorded owner endpoint", async () => {
  await enableWebPush();
  const replacement = { ...subscription, endpoint: "https://push.example.org/unrecorded", unsubscribe: vi.fn() };
  active = replacement;
  await disableWebPush();
  expect(replacement.unsubscribe).not.toHaveBeenCalled();
  expect(active).toBe(replacement);
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ endpoint: subscription.endpoint }) }));
});
it.each([false, true])("an older login cannot tear down a new login on the same user/device (reused endpoint: %s)", async (sameEndpoint) => {
  await enableWebPush();
  const oldSession = { userId: "bob", deviceId: "bob-device", loginIdentity: "session:session-bob" };
  const replacement = { ...subscription, endpoint: sameEndpoint ? subscription.endpoint : "https://push.example.org/new-login",
    toJSON: () => ({ ...subscription.toJSON(), endpoint: sameEndpoint ? subscription.endpoint : "https://push.example.org/new-login" }),
    unsubscribe: vi.fn(async () => { active = null; return true; }),
  };
  mocks.auth = { ...mocks.auth, sessionId: "second-login", accessToken: "new-token" };
  registration.pushManager.subscribe.mockImplementationOnce(async () => { active = replacement; return replacement; });
  await enableWebPush();
  vi.clearAllMocks();
  await disableWebPush("token-bob", { accountTeardown: true, session: oldSession });
  expect(replacement.unsubscribe).not.toHaveBeenCalled();
  expect(registration.getNotifications).not.toHaveBeenCalled();
  expect(active).toBe(replacement);
  expect(await webPushEnabled()).toBe(true);
  expect(await cache.get("/__push_enabled")!.json()).toBe(true);
  if (sameEndpoint) expect(fetch).not.toHaveBeenCalled();
  else expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ endpoint: subscription.endpoint }) }));
});
it("uses the legacy device identity for sessions without sessionId and survives token rotation", async () => {
  mocks.auth = { ...mocks.auth, sessionId: null as never };
  await enableWebPush();
  expect(await cache.get("/__push_owner")!.clone().json()).toMatchObject({ loginIdentity: "legacy-device:bob-device" });
  mocks.auth = { ...mocks.auth, accessToken: "rotated-token" };
  expect(await webPushEnabled()).toBe(true);
  await disableWebPush();
  expect(subscription.unsubscribe).toHaveBeenCalled();
});
