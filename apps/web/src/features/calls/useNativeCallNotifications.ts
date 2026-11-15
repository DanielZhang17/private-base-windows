import { useEffect, useRef } from "react";
import type { GetCallResponse } from "@e2ee-chat/shared";
import { CALL_RING_TIMEOUT_MS } from "@e2ee-chat/shared";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { api } from "../../services/api.js";
import { isSameSession } from "../../services/session-identity.js";
import { getPendingCall } from "../../db/index.js";
import { capabilities } from "../../platform/capabilities.js";
import { cancelIncomingCall, showIncomingCall, takeNotificationActions, type NotificationAction } from "../../platform/android-background.js";
import { navigate } from "../../platform/navigation.js";
import { registerUnlockedSessionCleanup } from "../../platform/session-cleanup.js";
import type { useCallInvitationOwner } from "./useCallInvitationOwner.js";

type Respond = ReturnType<typeof useCallInvitationOwner>["respond"];
type Decision = { kind: "accept" | "decline"; id: string; epoch: number; responding: boolean };

/** One owner in CallProvider; only native queue decisions can invoke local consent here. */
export function useNativeCallNotifications(enabled: boolean, respond: Respond) {
  const respondRef = useRef(respond);
  respondRef.current = respond;
  const userId = useAuthStore((state) => state.user?.id);
  const deviceId = useAuthStore((state) => state.device?.id);
  const sessionId = useAuthStore((state) => state.sessionId);
  const legacyEpoch = useAuthStore((state) => !state.sessionId && !state.device?.id ? state.authEpoch : undefined);
  useEffect(() => {
    if (!enabled || !userId || !capabilities.nativeCallNotifications) return;
    let disposed = false;
    const identity = useAuthStore.getState();
    const current = () => {
      const auth = useAuthStore.getState();
      return !disposed && auth.user?.id === userId && isSameSession(identity, auth);
    };
    const decisions = new Map<string, Decision>();
    const pending: (Decision | { kind: "open-conversation"; id: string })[] = [];
    let posted: { id: string } | null = null;
    let retryTimer: number | undefined;
    let retriedCallId: string | null = null;
    let draining = false;
    let drainAgain = false;
    let responding = false;

    const ringing = (id: string) => {
      const call = useCallStore.getState();
      return current() && call.activeCallId === id && call.direction === "incoming" && call.callStatus === "ringing";
    };
    const validDecision = (decision: Decision) => {
      const call = useCallStore.getState();
      return current() && decisions.get(decision.id) === decision && call.localCallEpoch === decision.epoch &&
        call.activeCallId === decision.id && call.direction === "incoming" &&
        (call.callStatus === "ringing" || (decision.responding && call.callStatus === "active"));
    };
    const cancel = (id: string) => { void cancelIncomingCall(id).catch(() => undefined); };
    const syncCall = () => {
      const call = useCallStore.getState();
      if (posted && !ringing(posted.id)) { cancel(posted.id); posted = null; }
      if (retryTimer !== undefined && call.activeCallId !== retriedCallId) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      for (const [id, decision] of decisions) if (!validDecision(decision)) decisions.delete(id);
      if (!current() || !document.hidden || !call.activeCallId || !ringing(call.activeCallId) || posted || retryTimer !== undefined) return;
      const notification = { id: call.activeCallId };
      posted = notification;
      void showIncomingCall({ callId: notification.id, callerName: call.callerName ?? "", video: call.callType === "video" })
        .catch(() => false)
        .then((shown) => {
          // Cancellation can finish before the asynchronous show reaches native.
          if (!current() || posted !== notification || !ringing(notification.id)) {
            if (shown) cancel(notification.id);
            return;
          }
          if (shown) return;
          posted = null;
          if (retriedCallId === notification.id) return;
          retriedCallId = notification.id;
          retryTimer = window.setTimeout(() => {
            retryTimer = undefined;
            syncCall();
          }, 1000);
        });
    };
    const process = () => {
      if (!current() || draining || responding) return;
      syncCall();
      let decision: Decision | undefined;
      while (pending.length) {
        const action = pending[0];
        if (action.kind === "open-conversation") {
          if (document.hidden) return;
          pending.shift();
          navigate(`/chat/${encodeURIComponent(action.id)}`);
          continue;
        }
        if (!validDecision(action)) { pending.shift(); continue; }
        if (action.kind === "accept" && !capabilities.e2eeCalls) {
          pending.shift();
          decisions.delete(action.id);
          continue;
        }
        if (action.kind === "accept" && (document.hidden || !useCallStore.getState().keyReady)) {
          return;
        }
        pending.shift();
        decision = action;
        break;
      }
      if (!decision) return;
      const response = decision;
      responding = true;
      const valid = () => validDecision(response) &&
        (response.kind === "decline" || ((response.responding || !document.hidden) && capabilities.e2eeCalls && useCallStore.getState().keyReady));
      void (async () => {
        try {
          if (response.kind === "accept") {
            const invite = await getPendingCall(response.id);
            const call = useCallStore.getState();
            if (!valid() || !invite || invite.id !== response.id || invite.direction !== "incoming" ||
                invite.conversationId !== call.conversationId || invite.initiatorId !== call.initiatorId ||
                invite.callType !== call.callType || invite.expiresAt <= Date.now()) return;
            const info = await api.get<GetCallResponse>(`/api/calls/${encodeURIComponent(response.id)}`);
            if (!valid() || info.id !== response.id || info.status !== "ringing" ||
                info.conversationId !== invite.conversationId || info.initiatorId !== invite.initiatorId ||
                info.type !== invite.callType || invite.expiresAt <= Date.now()) return;
            const acceptDeadline = Math.min(invite.expiresAt, info.createdAt + CALL_RING_TIMEOUT_MS);
            if (!Number.isFinite(acceptDeadline) || acceptDeadline <= Date.now()) return;
            navigate(`/call/${encodeURIComponent(response.id)}`);
            response.responding = true;
            await respondRef.current("accept", { callId: response.id, isCurrent: valid, acceptDeadline });
          } else {
            cancel(response.id);
            await respondRef.current("decline", { callId: response.id, isCurrent: valid });
          }
        } catch { /* Shared invitation state owns response errors; native errors stay private. */ }
        finally {
          if (decisions.get(response.id) === response) {
            if (response.kind === "accept" && ringing(response.id) && capabilities.e2eeCalls &&
                (document.hidden || !useCallStore.getState().keyReady)) {
              response.responding = false;
              pending.unshift(response);
            } else decisions.delete(response.id);
          }
          responding = false;
          process();
        }
      })();
    };
    const receive = (actions: NotificationAction[]) => {
      for (const action of actions) {
        if (action.kind === "open-conversation") { pending.push({ kind: action.kind, id: action.id }); continue; }
        if (!ringing(action.id)) continue;
        const previous = decisions.get(action.id);
        if (previous?.kind === action.kind) continue;
        // Stage the complete batch first: a later Decline supersedes Accept before any media.
        const decision = { kind: action.kind, id: action.id, epoch: useCallStore.getState().localCallEpoch, responding: false };
        decisions.set(action.id, decision);
        const previousIndex = previous ? pending.indexOf(previous) : -1;
        if (previousIndex >= 0) pending[previousIndex] = decision;
        else pending.push(decision);
      }
    };
    const drain = async () => {
      if (!current()) return;
      drainAgain = true;
      if (draining) return;
      draining = true;
      try {
        do {
          drainAgain = false;
          const actions = await takeNotificationActions();
          if (!current()) return;
          receive(actions);
        } while (drainAgain && current());
      } catch { /* A later wake/resume can retry an unavailable bridge. */ }
      finally { draining = false; process(); }
    };
    const wake = () => { void drain(); };
    const visibility = () => { syncCall(); if (!document.hidden) wake(); };
    const unsubscribe = useCallStore.subscribe(() => { syncCall(); process(); });
    window.addEventListener("privatebase-notification-action", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", visibility);
    syncCall();
    wake();
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      decisions.clear(); pending.length = 0;
      unsubscribe(); unregister();
      window.removeEventListener("privatebase-notification-action", wake);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", visibility);
      if (posted) { cancel(posted.id); posted = null; }
    };
    const unregister = registerUnlockedSessionCleanup(dispose);
    return dispose;
  }, [enabled, userId, deviceId, sessionId, legacyEpoch]);
}
