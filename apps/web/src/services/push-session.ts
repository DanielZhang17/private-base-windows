import type { SessionSnapshot } from "./session-identity.js";

/** Push ownership only; never persisted credentials or shared auth/route state. */
export function pushSessionIdentity(session: Pick<SessionSnapshot, "sessionId" | "device" | "authEpoch">): string {
  if (session.sessionId) return `session:${session.sessionId}`;
  if (session.device?.id) return `legacy-device:${session.device.id}`;
  return `legacy-epoch:${session.authEpoch}`;
}
