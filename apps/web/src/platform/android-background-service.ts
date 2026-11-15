import { capabilities } from "./capabilities.js";
import { backgroundStatus, configureBackground, type BackgroundStatus } from "./android-background.js";
import { requestNotificationPermission } from "./notifications.js";
import { registerUnlockedSessionCleanup } from "./session-cleanup.js";

const preferenceKey = (userId: string) => `private-base:android-background:${userId}`;
const listeners = new Set<() => void>();
const initial = { enabled: false, busy: false, error: false, status: null as BackgroundStatus | null };
let snapshot = initial;
let session: { userId: string; current: () => boolean; revision: number } | null = null;
// All service mutations, including teardown from a previous session, share this queue.
let mutations: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const pending = mutations.then(operation);
  mutations = pending.catch(() => undefined);
  return pending;
}
function publish(value: Partial<typeof initial>) {
  snapshot = { ...snapshot, ...value };
  for (const listener of listeners) listener();
}
export const backgroundSnapshot = () => snapshot;
export function subscribeBackground(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function refreshBackgroundStatus(): Promise<void> {
  const owner = session;
  if (!owner?.current() || !capabilities.backgroundConnection) return;
  try {
    const status = await backgroundStatus();
    if (session === owner && owner.current()) publish({ status });
  } catch { /* Older/unavailable bridges cannot report status. */ }
}

export async function setStayConnected(enabled: boolean): Promise<boolean> {
  const owner = session;
  if (!owner?.current() || !capabilities.backgroundConnection) return false;
  const revision = ++owner.revision;
  const current = () => session === owner && owner.current() && owner.revision === revision;
  publish({ busy: true, error: false, ...(!enabled ? { enabled: false } : {}) });
  try {
    if (enabled && (!await requestNotificationPermission() || !current())) throw new Error("unavailable");
    return await serialize(async () => {
      if (!current()) return false;
      try {
        await configureBackground(enabled);
        if (!current()) {
          // A stop/lock may have invalidated an already-starting native service.
          if (enabled) await configureBackground(false);
          return false;
        }
        localStorage.setItem(preferenceKey(owner.userId), String(enabled));
        publish({ enabled });
        return true;
      } catch {
        await configureBackground(false).catch(() => undefined);
        if (current()) {
          try { localStorage.setItem(preferenceKey(owner.userId), "false"); } catch { /* Remain off in memory. */ }
          publish({ enabled: false, error: true });
        }
        return false;
      }
    });
  } catch {
    if (current()) {
      publish({ enabled: false, error: true });
      try { localStorage.setItem(preferenceKey(owner.userId), "false"); } catch { /* Remain off in memory. */ }
      await serialize(() => configureBackground(false)).catch(() => undefined);
    }
    return false;
  } finally {
    if (current()) { publish({ busy: false }); void refreshBackgroundStatus(); }
  }
}

export function startBackgroundSession(userId: string, isCurrent: () => boolean): () => void {
  if (!capabilities.backgroundConnection) return () => undefined;
  const owner = { userId, current: isCurrent, revision: 0 };
  session = owner;
  snapshot = initial;
  if (capabilities.backgroundConnection) {
    try { publish({ enabled: localStorage.getItem(preferenceKey(userId)) === "true" }); }
    catch { publish({ error: true }); }
  }
  const resume = () => {
    if (document.hidden || session !== owner || !owner.current()) return;
    void refreshBackgroundStatus();
    if (snapshot.enabled && !snapshot.busy) void setStayConnected(true);
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
  resume();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    owner.revision++;
    if (session === owner) { session = null; publish(initial); }
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("focus", resume);
    unregister();
    void serialize(() => configureBackground(false)).catch(() => undefined);
  };
  const unregister = registerUnlockedSessionCleanup(dispose);
  return dispose;
}
