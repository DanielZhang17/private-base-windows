import { useAuthStore } from "../../stores/authStore.js";
import { registerUnlockedSessionCleanup } from "../../platform/session-cleanup.js";

export function captureMessageActionSession() {
  const { user, device, sessionId } = useAuthStore.getState();
  return { userId: user?.id, deviceId: device?.id, sessionId };
}
export function isMessageActionSessionCurrent(session: ReturnType<typeof captureMessageActionSession>): boolean {
  const current = captureMessageActionSession();
  return !!session.userId && !!session.deviceId && session.userId === current.userId
    && session.deviceId === current.deviceId && session.sessionId === current.sessionId;
}
/** Survives the hidden bubble's unmount; retained only for the toast's five-second lifetime. */
export function trackMessageUndoToast(session: ReturnType<typeof captureMessageActionSession>, dismiss: () => void): () => void {
  let closed = false;
  const clear = () => {
    if (closed) return;
    closed = true; dismiss(); unsubscribe?.(); unregister(); clearTimeout(timer);
  };
  const unsubscribe = useAuthStore.subscribe?.(() => { if (!isMessageActionSessionCurrent(session)) clear(); });
  const unregister = registerUnlockedSessionCleanup(clear);
  const timer = setTimeout(clear, 5000);
  if (!isMessageActionSessionCurrent(session)) clear();
  return clear;
}
