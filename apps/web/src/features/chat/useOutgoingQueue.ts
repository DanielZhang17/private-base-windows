import { useEffect, useSyncExternalStore } from "react";
import { useAuthStore } from "../../stores/authStore.js";
import {
  discardOutgoing,
  getQueueSnapshot,
  refreshOutgoingQueue,
  retryOutgoing,
  startOutgoingQueue,
  subscribeQueue,
} from "./outgoingQueue.js";

export function useOutgoingQueue() {
  const userId = useAuthStore((state) => state.user?.id);
  const deviceId = useAuthStore((state) => state.device?.id);
  const sessionId = useAuthStore((state) => state.sessionId);
  const outgoing = useSyncExternalStore(subscribeQueue, getQueueSnapshot);
  useEffect(() => {
    void refreshOutgoingQueue().catch(console.error);
    return startOutgoingQueue();
  }, [userId, deviceId, sessionId]);
  return { outgoing: outgoing.filter((row) => row.userId === userId && row.deviceId === deviceId), retry: retryOutgoing, discard: discardOutgoing };
}
