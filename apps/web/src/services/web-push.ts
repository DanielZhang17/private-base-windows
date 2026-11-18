import { api } from "./api.js";
import { resolveApiUrl } from "./api-url.js";
import { useAuthStore } from "../stores/authStore.js";
import { isNative } from "../platform/environment.js";
import { pushSessionIdentity as sessionIdentity } from "./push-session.js";

export const PUSH_CACHE = "private-base-push-v1";
export interface PushSession { userId: string; deviceId: string; loginIdentity: string }
interface PushOwner extends PushSession { endpoint: string }
function currentPushSession(): PushSession | null {
  const auth = useAuthStore.getState();
  return auth.user && auth.device ? { userId: auth.user.id, deviceId: auth.device.id, loginIdentity: sessionIdentity(auth) } : null;
}
function ownerKey(session: PushSession): string {
  return `/__push_owner/${encodeURIComponent(session.userId)}/${encodeURIComponent(session.deviceId)}/${encodeURIComponent(session.loginIdentity)}`;
}
async function readOwner(key = "/__push_owner"): Promise<PushOwner | null> {
  const entry = await (await caches.open(PUSH_CACHE)).match(key);
  const owner = await entry?.json().catch(() => null) as Partial<PushOwner> | null | undefined;
  return owner && typeof owner.userId === "string" && typeof owner.deviceId === "string" && typeof owner.loginIdentity === "string" && typeof owner.endpoint === "string"
    ? owner as PushOwner : null;
}
function matchesOwner(owner: PushOwner | null, session: PushSession | null, endpoint: string | undefined): boolean {
  return !!owner && !!session && owner.userId === session.userId && owner.deviceId === session.deviceId && owner.loginIdentity === session.loginIdentity && owner.endpoint === endpoint;
}
async function recordOwner(owner: PushOwner): Promise<void> {
  const cache = await caches.open(PUSH_CACHE);
  // Retain each owner's endpoint so a stale tab never deletes the next account's endpoint.
  await cache.put(ownerKey(owner), new Response(JSON.stringify(owner)));
  await cache.put("/__push_owner", new Response(JSON.stringify(owner)));
}
export function iosPushHint(): boolean {
  return !isNative() && (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) &&
    !window.matchMedia("(display-mode: standalone)").matches && !(navigator as Navigator & { standalone?: boolean }).standalone;
}
export function supportsWebPush(): boolean {
  return !isNative() && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !iosPushHint();
}
export function showWebPushSettings(): boolean { return supportsWebPush() || iosPushHint(); }
export async function storePushLocale(locale: string, message: string, call: string, deviceAdded?: string, approvalDisabled?: string): Promise<void> {
  if (isNative() || !("caches" in window)) return;
  const cache = await caches.open(PUSH_CACHE);
  await cache.put("/__push_locale", new Response(JSON.stringify({ locale, message, call, deviceAdded, approvalDisabled })));
}
async function setDeliveryEnabled(enabled: boolean): Promise<void> {
  const cache = await caches.open(PUSH_CACHE);
  await cache.put("/__push_enabled", new Response(JSON.stringify(enabled)));
}
let generation = 0;
let operations: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.catch(() => undefined).then(async () => {
    if (navigator.locks?.request) return await navigator.locks.request("private-base-push", operation);
    return await operation(); // Older browsers retain tab-local sequencing and endpoint-scoped DELETE.
  });
  operations = result.catch(() => undefined);
  return result;
}
export async function webPushEnabled(): Promise<boolean> {
  if (!supportsWebPush()) return false;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  return matchesOwner(await readOwner(), currentPushSession(), subscription?.endpoint);
}
export function enableWebPush(): Promise<void> {
  if (!supportsWebPush()) return Promise.reject(new Error("Push unavailable"));
  const auth = useAuthStore.getState();
  const session = currentPushSession();
  if (!session) return Promise.reject(new Error("Session unavailable"));
  const version = ++generation;
  const current = () => {
    const next = useAuthStore.getState();
    return version === generation && !!next.accessToken && sessionIdentity(next) === session.loginIdentity &&
      next.user?.id === auth.user?.id && next.device?.id === auth.device?.id;
  };
  // Called directly by the switch gesture, before any asynchronous work (required on iOS).
  const permission = Notification.requestPermission();
  return permission.then((granted) => {
    if (granted !== "granted" || !current()) throw new Error("Permission or session unavailable");
    return serialize(async () => {
      if (!current()) return;
      const { publicKey } = await api.get<{ publicKey: string }>("/api/push/vapid-public-key");
      if (!current()) return;
      await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      const registration = await navigator.serviceWorker.ready;
      if (!current()) return;
      const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/"));
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !matchesOwner(await readOwner(), session, subscription.endpoint)) {
        if (!current()) return;
        // An explicit Enable gesture switches the browser subscription to this account.
        await subscription.unsubscribe();
        subscription = null;
      }
      if (!subscription) subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
      });
      try {
        if (!current()) return;
        await recordOwner({ ...session, endpoint: subscription.endpoint });
        if (!current()) return;
        await api.post("/api/push/subscribe", subscription.toJSON());
        if (current()) await setDeliveryEnabled(true);
      } catch (error) {
        // A different tab may have replaced the subscription while the API request was pending.
        const live = await registration.pushManager.getSubscription();
        if (matchesOwner(await readOwner(), session, live?.endpoint) && live?.endpoint === subscription.endpoint) {
          await setDeliveryEnabled(false);
          await live.unsubscribe();
        }
        throw error;
      }
    });
  });
}
export function disableWebPush(accessToken = useAuthStore.getState().accessToken,
  { accountTeardown = false, session = currentPushSession() }: { accountTeardown?: boolean; session?: PushSession | null } = {}): Promise<void> {
  const current = currentPushSession();
  if (session && current && session.userId === current.userId && session.deviceId === current.deviceId && session.loginIdentity === current.loginIdentity) {
    ++generation; // Only this login may invalidate its delayed permission/registration work.
  }
  if (isNative() || !("serviceWorker" in navigator)) return Promise.resolve();
  return serialize(async () => {
    let registration: ServiceWorkerRegistration | undefined;
    let subscription: PushSubscription | null | undefined;
    let lookupFailed = false;
    let owner: PushOwner | null = null;
    let activeOwner: PushOwner | null = null;
    try {
      owner = session ? await readOwner(ownerKey(session)) : null;
      activeOwner = await readOwner();
    } catch { lookupFailed = true; }
    try {
      registration = await navigator.serviceWorker.getRegistration("/");
      subscription = await registration?.pushManager.getSubscription();
    } catch { lookupFailed = true; }
    // Capture once under the lock. A delayed DELETE must never remove a replacement endpoint.
    const endpoint = owner?.endpoint;
    const ownsBrowser = matchesOwner(activeOwner, session, endpoint) && subscription?.endpoint === endpoint && !!endpoint;
    // Each cleanup runs even if storage, the browser push service, or the API is unavailable.
    const results = await Promise.allSettled([
      ownsBrowser ? setDeliveryEnabled(false) : Promise.resolve(),
      (async () => {
        if (!ownsBrowser) return;
        try { await subscription?.unsubscribe(); }
        finally { for (const notification of await registration?.getNotifications() ?? []) notification.close(); }
      })(),
      (async () => {
        if (!accessToken || !endpoint) return;
        // Reused endpoints can belong to a newer login on the same server-side device.
        if (activeOwner?.endpoint === endpoint && activeOwner.userId === session?.userId &&
            activeOwner.deviceId === session?.deviceId && activeOwner.loginIdentity !== session?.loginIdentity) return;
        // Captured credentials prevent teardown from deleting the next account's subscription.
        const response = await fetch(resolveApiUrl("/api/push/subscribe"), {
          method: "DELETE", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, keepalive: true,
          body: JSON.stringify(accountTeardown && ownsBrowser ? { all: true } : { endpoint }),
        });
        if (!response.ok) throw new Error("Push cleanup failed");
      })(),
    ]);
    if (lookupFailed || results.some((result) => result.status === "rejected")) throw new Error("Push cleanup failed");
  });
}
