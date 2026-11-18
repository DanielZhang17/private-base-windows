export type SessionSnapshot = {
  accessToken: string | null;
  device: { id: string } | null;
  authEpoch: number;
  sessionId: string | null;
};

/** Compare against the latest cross-tab write even before its storage event arrives. */
export function readAuthStorage(): string | null {
  try { return localStorage.getItem("e2ee-auth"); }
  catch { return null; }
}

type PersistedSession = {
  accessToken?: unknown;
  refreshToken?: unknown;
  sessionId?: unknown;
  user?: { id?: unknown } | null;
  device?: { id?: unknown } | null;
};

export function readPersistedSession(storage = readAuthStorage()): PersistedSession | undefined {
  try {
    const state = JSON.parse(storage ?? "null")?.state;
    return state && typeof state === "object" ? state : undefined;
  } catch { return undefined; }
}

/**
 * Whether `now` is still the session a request started in. The per-login sessionId decides:
 * it changes on every login (even on the same device) and on logout, but not on an idle lock,
 * a session-identity repair or a token rotation, and it is shared by all tabs of that login.
 * Sessions persisted before sessionId existed fall back to the device id, then to authEpoch
 * (which alone would also change on an idle lock and can coincide across tabs).
 */
export function isSameSession(before: SessionSnapshot, now: SessionSnapshot): boolean {
  if (!now.accessToken) return false;
  if (before.sessionId || now.sessionId) return before.sessionId === now.sessionId;
  if (before.device?.id && now.device?.id) return before.device.id === now.device.id;
  return before.authEpoch === now.authEpoch;
}

