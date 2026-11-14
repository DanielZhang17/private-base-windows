import { t, useLocale } from "../../i18n/index.js";
import { useEffect } from "react";
import type { CallEventPayload, ConversationWithMembers } from "@e2ee-chat/shared";
import { api } from "../../services/api.js";
import { createNotificationWebSocket } from "../../services/notifications.js";
import { cleanupExpiredFileCache, cleanupExpiredPendingCalls, deletePendingCall, getPendingCall } from "../../db/index.js";
import { pruneExpiredPlaintext, resetMessageSyncState, syncMessages, runUnlockSync } from "../../lib/message-sync.js";
import { requestNotificationPermission } from "../../lib/browser-notifications.js";
import { refreshConversationList } from "../../lib/conversation-cache.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { usePresenceStore } from "../../stores/presenceStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { useConnectionStore } from "../../stores/connectionStore.js";

function getConversationName(conversation: ConversationWithMembers, localUserId: string): string {
  if (conversation.name) return conversation.name;
  return conversation.members
    .filter((member) => member.userId !== localUserId)
    .map((member) => member.user.displayName)
    .join(", ");
}

async function waitForCallOffer(callId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await syncMessages({ force: true });
    const pendingCall = await getPendingCall(callId);
    if (pendingCall) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 400));
  }
  return false;
}

export default function UnlockedAppEffects() {
  useLocale();
  const userId = useAuthStore((state) => state.user?.id);
  const deviceId = useAuthStore((state) => state.device?.id);
  const setOnline = useConnectionStore((state) => state.setOnline);

  useEffect(() => {
    if (!userId || !deviceId) return;

    let disposed = false;
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
        if (disposed) return;

        if (payload.event === "incoming") {
          const currentCall = useCallStore.getState();
          if (
            currentCall.activeCallId &&
            currentCall.activeCallId !== payload.callId &&
            (currentCall.callStatus === "ringing" || currentCall.callStatus === "active")
          ) {
            return;
          }

          const conversation = await api.get<ConversationWithMembers>(`/api/conversations/${payload.conversationId}`);
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

          const keyReady = await waitForCallOffer(payload.callId);
          if (!disposed && keyReady) {
            useCallStore.getState().markKeyReady(payload.callId, true);
          }
          return;
        }

        useCallStore.getState().updateCallStatus(payload.callId, payload.status);

        if (payload.event === "accepted") {
          return;
        }

        await deletePendingCall(payload.callId).catch(() => undefined);
        window.setTimeout(() => {
          if (disposed) return;
          const current = useCallStore.getState();
          if (current.activeCallId === payload.callId && current.callStatus === payload.status) {
            useCallStore.getState().clearCall();
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

    void requestNotificationPermission();

    void Promise.all([
      runUnlockSync(),
      refreshConversationList(),
    ]).catch((err) => {
      console.error("Failed to run unlock sync", err);
    });
    connect();

    return () => {
      disposed = true;
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
  }, [userId, deviceId, setOnline]);

  return null;
}
