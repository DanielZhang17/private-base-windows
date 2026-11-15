import { api } from "./api.js";
import { deletePendingCall } from "../db/index.js";
import { useAuthStore } from "../stores/authStore.js";

type CallCleanupSession = {
  user: { id: string } | null;
  device: { id: string } | null;
  sessionId: string | null;
};

/** Independent of routes and call ownership: only this call ID and login may be cleaned up. */
export async function cleanupCallBestEffort(callId: string, session: CallCleanupSession): Promise<void> {
  const end = async () => {
    // Three attempts total; the API client also handles an expired token's refresh/replay.
    const delays = [500, 1500];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const current = useAuthStore.getState();
      if (!current.accessToken || current.user?.id !== session.user?.id ||
          current.device?.id !== session.device?.id || current.sessionId !== session.sessionId) return;
      try {
        await api.post(`/api/calls/${callId}/end`);
        return;
      } catch (error) {
        const status = (error as { status?: number } | null)?.status;
        const transient = status === undefined || status === 0 || status === 408 || status === 429 || status >= 500;
        if (!transient || attempt === delays.length) return;
        await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  };
  // Key deletion never waits for a network request or requires an authenticated session.
  await Promise.all([deletePendingCall(callId).catch(() => undefined), end()]);
}
