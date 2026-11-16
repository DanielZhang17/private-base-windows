import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Call, ConversationWithMembers } from "@e2ee-chat/shared";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { syncMessages } from "../../lib/message-sync.js";
import { getPendingCall } from "../../db/index.js";
import { isNative } from "../../platform/environment.js";
import { registerUnlockedSessionCleanup } from "../../platform/session-cleanup.js";
import { t } from "../../i18n/index.js";

/** A push tap opens a fresh page with no in-memory WebSocket invitation. Never auto-accept. */
export function usePushCallInvitation(enabled: boolean, callId: string | undefined) {
  const navigate = useNavigate();
  const pushTap = new URLSearchParams(useLocation().search).get("push") === "call";
  const sessionId = useAuthStore((state) => state.sessionId);
  useEffect(() => {
    if (!enabled || !pushTap || !callId || isNative() || useCallStore.getState().activeCallId) return;
    const auth = useAuthStore.getState();
    let disposed = false;
    const unregister = registerUnlockedSessionCleanup(() => { disposed = true; });
    const current = () => {
      const next = useAuthStore.getState();
      return !disposed && !!next.accessToken && next.user?.id === auth.user?.id && next.device?.id === auth.device?.id && next.sessionId === auth.sessionId;
    };
    void (async () => {
      const info = await api.get<Call>(`/api/calls/${encodeURIComponent(callId)}`);
      if (!current()) return;
      if (info.status !== "ringing" || info.initiatorId === auth.user?.id) {
        navigate(`/chat/${encodeURIComponent(info.conversationId)}`, { replace: true });
        return;
      }
      const conversation = await api.get<ConversationWithMembers>(`/api/conversations/${encodeURIComponent(info.conversationId)}`);
      if (!current() || useCallStore.getState().activeCallId) return;
      // The caller can end while conversation details are in flight. Revalidate before publishing.
      const latest = await api.get<Call>(`/api/calls/${encodeURIComponent(callId)}`);
      if (!current() || useCallStore.getState().activeCallId) return;
      if (latest.status !== "ringing") {
        navigate(`/chat/${encodeURIComponent(info.conversationId)}`, { replace: true });
        return;
      }
      const caller = conversation.members.find((member) => member.userId === info.initiatorId);
      useCallStore.getState().setIncomingCall({
        callId: info.id, conversationId: info.conversationId, callType: info.type,
        initiatorId: info.initiatorId, callerUserId: info.initiatorId,
        callerName: caller?.user.displayName ?? t("unknownCaller"), callerAvatarUrl: caller?.user.avatarUrl ?? null,
        conversationName: conversation.name ?? caller?.user.displayName ?? t("unknownCaller"), keyReady: false,
      });
      for (let attempt = 0; attempt < 5 && current(); attempt++) {
        const call = useCallStore.getState();
        if (call.activeCallId !== callId || call.callStatus !== "ringing") return;
        await syncMessages({ force: true });
        const pending = await getPendingCall(callId);
        if (!current()) return;
        if (pending && pending.expiresAt > Date.now()) {
          useCallStore.getState().markKeyReady(callId, true);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
    })().catch(() => { if (current()) navigate("/", { replace: true }); });
    return () => { disposed = true; unregister(); };
  }, [enabled, pushTap, callId, sessionId, navigate]);
}
