import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { useLocale } from "../../i18n/index.js";
import { toErrorMessage } from "../shared/errors.js";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { capabilities } from "../../platform/capabilities.js";
import { isSameSession } from "../../services/session-identity.js";
import { cleanupCallBestEffort } from "../../services/call-cleanup.js";

export interface PendingLocalAcceptance { callId: string; epoch: number; deadline: number }

/** Owned by CallProvider: modal/route unmounts never cancel a local Accept. */
export function useCallInvitationOwner(enabled: boolean) {
  useLocale();
  const navigate = useNavigate();
  const { activeCallId, localCallEpoch, callStatus, keyReady } = useCallStore();
  const userId = useAuthStore((state) => state.user?.id);
  const deviceId = useAuthStore((state) => state.device?.id);
  const sessionId = useAuthStore((state) => state.sessionId);
  const legacyEpoch = useAuthStore((state) => !state.sessionId && !state.device?.id ? state.authEpoch : undefined);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const generation = useRef(0);
  const mounted = useRef(true);
  const busy = useRef(false);
  const waitingForKey = useRef<(() => void) | null>(null);
  const [loadingAction, setLoadingAction] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [pendingLocalAcceptance, setPendingLocalAcceptance] = useState<PendingLocalAcceptance | null>(null);
  const pendingAcceptanceRef = useRef<PendingLocalAcceptance | null>(null);
  const finishNativeCaptureWait = useCallback((callId: string, epoch: number) => {
    const pending = pendingAcceptanceRef.current;
    if (pending?.callId !== callId || pending.epoch !== epoch) return;
    pendingAcceptanceRef.current = null;
    setPendingLocalAcceptance(null);
  }, []);

  useEffect(() => {
    if (!pendingLocalAcceptance) return;
    const pending = pendingLocalAcceptance;
    const auth = useAuthStore.getState();
    let wasHidden = document.hidden;
    const current = () => {
      const call = useCallStore.getState();
      const now = useAuthStore.getState();
      return pendingAcceptanceRef.current === pending && enabledRef.current &&
        call.activeCallId === pending.callId && call.localCallEpoch === pending.epoch &&
        now.user?.id === auth.user?.id && isSameSession(auth, now);
    };
    const visibility = () => {
      if (!current()) return;
      const expiredWhileHidden = Date.now() >= pending.deadline && (wasHidden || document.hidden);
      wasHidden = document.hidden;
      if (expiredWhileHidden) {
        finishNativeCaptureWait(pending.callId, pending.epoch);
        useCallStore.getState().clearCall(pending.callId);
        void cleanupCallBestEffort(pending.callId, auth);
      } else if (!document.hidden && useCallStore.getState().localCallOwnership?.callId === pending.callId) {
        navigate(`/call/${encodeURIComponent(pending.callId)}`);
      }
    };
    const timer = window.setTimeout(visibility, Math.max(0, pending.deadline - Date.now()));
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [pendingLocalAcceptance, finishNativeCaptureWait, navigate]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  useLayoutEffect(() => {
    generation.current += 1;
    busy.current = false;
    waitingForKey.current = null;
    setLoadingAction(null);
    setError(null);
    pendingAcceptanceRef.current = null;
    setPendingLocalAcceptance(null);
  }, [enabled, activeCallId, localCallEpoch, userId, deviceId, sessionId, legacyEpoch]);

  const respond = async (action: "accept" | "decline", consent?: { callId: string; isCurrent: () => boolean; acceptDeadline?: number }) => {
    const call = useCallStore.getState();
    const activeCallId = call.activeCallId;
    if (consent && (consent.callId !== activeCallId || !consent.isCurrent() || call.callStatus !== "ringing")) return;
    if (!enabledRef.current || busy.current || !activeCallId || call.activeCallId !== activeCallId ||
        call.direction !== "incoming" || (call.callStatus !== "ringing" && call.callStatus !== "active") ||
        (action === "accept" && !capabilities.e2eeCalls)) return;
    const request = generation.current;
    const auth = useAuthStore.getState();
    const epoch = call.localCallEpoch;
    const isCurrent = () => {
      const currentCall = useCallStore.getState();
      const currentAuth = useAuthStore.getState();
      return mounted.current && enabledRef.current && generation.current === request &&
        (!consent || consent.isCurrent()) &&
        currentCall.activeCallId === activeCallId && currentCall.localCallEpoch === epoch &&
        (currentCall.callStatus === "ringing" || currentCall.callStatus === "active") &&
        currentAuth.user?.id === auth.user?.id && currentAuth.device?.id === auth.device?.id &&
        (consent ? isSameSession(auth, currentAuth) : currentAuth.sessionId === auth.sessionId);
    };
    if (action === "accept" && !call.keyReady) {
      if (!consent && call.callStatus === "ringing" && !waitingForKey.current) {
        // Keep this tab's click while the encrypted offer is being recovered.
        waitingForKey.current = () => {
          if (isCurrent() && useCallStore.getState().callStatus === "ringing") void respond("accept");
        };
        setLoadingAction("accept");
      }
      return;
    }
    waitingForKey.current = null;
    busy.current = true;
    setLoadingAction(action);
    setError(null);
    let pending: PendingLocalAcceptance | null = null;
    if (action === "accept" && consent?.acceptDeadline !== undefined) {
      pending = { callId: activeCallId, epoch, deadline: consent.acceptDeadline };
      pendingAcceptanceRef.current = pending;
      setPendingLocalAcceptance(pending);
    }
    try {
      await api.post(`/api/calls/${activeCallId}/${action}`);
      if (!isCurrent()) return;
      if (action === "accept") {
        if (useCallStore.getState().acceptLocalCall(activeCallId) && (!pending || !document.hidden)) navigate(`/call/${activeCallId}`);
      } else useCallStore.getState().updateCallStatus(activeCallId, "declined");
    } catch (err) {
      if (pending) finishNativeCaptureWait(pending.callId, pending.epoch);
      if (isCurrent()) setError(toErrorMessage(err, "couldNotRespondToCall"));
    } finally {
      if (mounted.current && generation.current === request) {
        busy.current = false;
        setLoadingAction(null);
      }
    }
  };

  useEffect(() => {
    const accept = waitingForKey.current;
    if (!accept) return;
    if (callStatus !== "ringing") {
      waitingForKey.current = null;
      setLoadingAction(null);
    } else if (keyReady) {
      waitingForKey.current = null;
      setLoadingAction(null);
      accept();
    }
  }, [callStatus, keyReady]);
  return { loadingAction, error: error ? renderMessage(error) : null, respond, pendingLocalAcceptance, finishNativeCaptureWait };
}
