import { t, useLocale } from "../../i18n/index.js";
import { useEffect } from "react";
import type { CallEventPayload, ConversationWithMembers } from "@e2ee-chat/shared";
import { api } from "../../services/api.js";
import { createNotificationWebSocket } from "../../services/notifications.js";
import { cleanupExpiredFileCache, cleanupExpiredPendingCalls, deletePendingCall, getPendingCall } from "../../db/index.js";
import { pruneExpiredPlaintext, resetMessageSyncState, syncMessages, runUnlockSync } from "../../lib/message-sync.js";
import { requestNotificationPermission } from "../../lib/browser-notifications.js";
import { isNative } from "../../platform/environment.js";
import { refreshConversationList } from "../../lib/conversation-cache.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { usePresenceStore } from "../../stores/presenceStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { useConnectionStore } from "../../stores/connectionStore.js";
import { startBackgroundSession } from "../../platform/android-background-service.js";
import { registerUnlockedSessionCleanup } from "../../platform/session-cleanup.js";

function getConversationName(conversation: ConversationWithMembers, localUserId: string): string {
  if (conversation.name) return conversation.name;
  return conversation.members
    .filter((member) => member.userId !== localUserId)
    .map((member) => member.user.displayName)
    .join(", ");
}

async function waitForCallOffer(callId: string, isCurrent: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!isCurrent()) return false;
    await syncMessages({ force: true });
    if (!isCurrent()) return false;
    const pendingCall = await getPendingCall(callId);
    if (!isCurrent()) return false;
    if (pendingCall && pendingCall.expiresAt > Date.now()) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 400));
  }
  return false;
}

export default function UnlockedAppEffects() {
  useLocale();
  const userId = useAuthStore((state) => state.user?.id);
  const deviceId = useAuthStore((state) => state.device?.id);
  const sessionId = useAuthStore((state) => state.sessionId);
  const setOnline = useConnectionStore((state) => state.setOnline);

  useEffect(() => {
    if (!userId || !deviceId) return;

    let disposed = false;
    const current = () => {
      const auth = useAuthStore.getState();
      return !disposed && !!auth.accessToken && auth.user?.id === userId && auth.device?.id === deviceId && auth.sessionId === sessionId;
    };
    const stopBackground = startBackgroundSession(userId, current);
    const unregister = registerUnlockedSessionCleanup(() => { disposed = true; });
    const retiredCallIds = new Set<string>();
    let socketDispose: (() => void) | null = null;
    let messageSyncTimer: number | null = null;
    const cleanupTimer = window.setInterval(() => {
      void cleanupExpiredPendingCalls();
      void pruneExpiredPlaintext();
      void cleanupExpiredFileCache();
    }, 5_000);

    const syncPollTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void syncMessages().catch(() => undefined);
      }
    }, 30_000);

    const handleCallEvent = async (payload: CallEventPayload) => {
      try {
        if (!current()) return;

        if (payload.event === "incoming") {
          const currentCall = useCallStore.getState();
          if (
            retiredCallIds.has(payload.callId) ||
            currentCall.pendingCallStart ||
            (currentCall.activeCallId && (currentCall.callStatus === "ringing" || currentCall.callStatus === "active"))
          ) {
            return;
          }

          const conversation = await api.get<ConversationWithMembers>(`/api/conversations/${payload.conversationId}`);
          if (!current() || retiredCallIds.has(payload.callId)) return;
          const latest = useCallStore.getState();
          if (latest.pendingCallStart || (latest.activeCallId &&
              (latest.callStatus === "ringing" || latest.callStatus === "active"))) return;
          const caller = conversation.members.find((member) => member.userId === payload.fromUserId);

          useCallStore.getState().setIncomingCall({
            callId: payload.callId,
            conversationId: payload.conversationId,
            callType: payload.callType,
            initiatorId: payload.initiatorId,
            callerUserId: payload.fromUserId,
            callerName: caller?.user.displayName ?? t("unknownCaller"),
            callerAvatarUrl: caller?.user.avatarUrl ?? null,
            conversationName: getConversationName(conversation, userId),
            keyReady: false,
          });

          const keyReady = await waitForCallOffer(payload.callId, () => current() && !retiredCallIds.has(payload.callId) &&
            useCallStore.getState().activeCallId === payload.callId && useCallStore.getState().callStatus === "ringing");
          if (current() && !retiredCallIds.has(payload.callId) && keyReady) {
            useCallStore.getState().markKeyReady(payload.callId, true);
          }
          return;
        }

        retiredCallIds.add(payload.callId);
        useCallStore.getState().updateCallStatus(payload.callId, payload.status);

        if (payload.event === "accepted") {
          return;
        }

        await deletePendingCall(payload.callId).catch(() => undefined);
        window.setTimeout(() => {
          if (disposed) return;
          const current = useCallStore.getState();
          if (current.activeCallId === payload.callId && current.callStatus === payload.status) {
            useCallStore.getState().clearCall(payload.callId);
          }
        }, 1500);
      } catch (err) {
        console.error("Failed to handle call event", err);
      }
    };

    const scheduleMessageSync = () => {
      if (disposed || messageSyncTimer !== null) return;
      messageSyncTimer = window.setTimeout(() => {
        messageSyncTimer = null;
        void syncMessages({ force: true }).catch(() => undefined);
      }, 250);
    };

    const connect = () => {
      if (disposed) return;

      const socket = createNotificationWebSocket({
        onCallEvent: (payload) => {
          void handleCallEvent(payload);
        },
        onConversationEvent: () => {
          void refreshConversationList().catch(() => undefined);
        },
        onMessageEvent: (payload) => {
          const activeConversationId = useChatStore.getState().activeConversationId;
          const isVisibleActiveConversation =
            document.visibilityState === "visible" &&
            activeConversationId === payload.conversationId;
          if (!isVisibleActiveConversation) {
            scheduleMessageSync();
          }
        },
        onProfileEvent: () => {
          void refreshConversationList().catch(() => undefined);
        },
        onPresenceEvent: (userId, status) => {
          if (status === "online") {
            usePresenceStore.getState().setUserOnline(userId);
          } else {
            usePresenceStore.getState().setUserOffline(userId);
          }
        },
        onOpen: () => {
          void Promise.all([
            syncMessages(),
            refreshConversationList(),
          ]).catch(() => undefined);
        },
      });
      socketDispose = socket.dispose;
    };

    const handleOnline = () => {
      setOnline(true);
      void syncMessages().catch(() => undefined);
    };
    const handleOffline = () => setOnline(false);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void pruneExpiredPlaintext();
        void syncMessages().catch(() => undefined);
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (isNative()) void requestNotificationPermission().catch(() => undefined);

    void Promise.all([
      runUnlockSync(),
      refreshConversationList(),
    ]).catch((err) => {
      console.error("Failed to run unlock sync", err);
    });
    connect();

    return () => {
      disposed = true;
      unregister();
      stopBackground();
      window.clearInterval(cleanupTimer);
      window.clearInterval(syncPollTimer);
      if (messageSyncTimer !== null) {
        window.clearTimeout(messageSyncTimer);
      }
      socketDispose?.();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resetMessageSyncState();
    };
  }, [userId, deviceId, sessionId, setOnline]);

  return null;
}
