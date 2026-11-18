import { navigate } from "../platform/navigation.js";
import { clearAccountScopedState } from "../platform/session.js";
import { useAuthStore } from "../stores/authStore.js";
import { readPersistedSession } from "./session-identity.js";

export function endRevokedDeviceSession(replacementDeviceName?: string) {
  const auth = useAuthStore.getState();
  const persisted = readPersistedSession();
  if (persisted && ((persisted.sessionId ?? null) !== (auth.sessionId ?? null) ||
    (persisted.device?.id ?? null) !== (auth.device?.id ?? null) ||
    (persisted.user?.id ?? null) !== (auth.user?.id ?? null) ||
    (!auth.sessionId && persisted.accessToken !== auth.accessToken))) return;
  clearAccountScopedState();
  auth.logout();
  navigate("/session-ended", { replace: true, state: { replacementDeviceName } });
}
