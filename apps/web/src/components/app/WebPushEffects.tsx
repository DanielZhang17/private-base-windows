import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useLocale, t } from "../../i18n/index.js";
import { useAuthStore } from "../../stores/authStore.js";
import { registerUnlockedSessionCleanup } from "../../platform/session-cleanup.js";
import { disableWebPush, storePushLocale } from "../../services/web-push.js";
import { api } from "../../services/api.js";
import { pushSessionIdentity } from "../../services/push-session.js";
import { isSameSession } from "../../services/session-identity.js";
import { refreshGroupInvitations } from "../../features/calls/group-call-store.js";
import { keysLoaded } from "../../lib/key-manager.js";

function validDestination(value: unknown): value is string {
  return typeof value === "string" && (value === "/?push=message" || value === "/?push=group-call" || value === "/devices" || value === "/settings?section=privacy" ||
    /^\/(chat|call)\/[A-Za-z0-9_-]{1,128}$/.test(value) ||
    /^\/call\/[A-Za-z0-9_-]{1,128}\?push=call$/.test(value));
}

export default function WebPushEffects({ unlocked }: { unlocked: boolean }) {
  const { locale } = useLocale();
  const location = useLocation();
  const navigate = useNavigate();
  const sessionId = useAuthStore((state) => state.sessionId);
  const userId = useAuthStore((state) => state.user?.id);
  const deviceId = useAuthStore((state) => state.device?.id);
  const accessToken = useAuthStore((state) => state.accessToken);
  const live = useRef(unlocked);
  live.current = unlocked;
  const requestEpoch = useRef(0);
  const queryHandled = useRef(false);
  const pendingGroupTap = useRef<ReturnType<typeof useAuthStore.getState> | null>(null);
  useLayoutEffect(() => { requestEpoch.current++; }, [location]);
  useEffect(() => {
    if (!unlocked) requestEpoch.current++;
  }, [unlocked]);
  useEffect(() => () => { requestEpoch.current++; }, []);

  const resolveMessage = useCallback(() => {
    const auth = useAuthStore.getState();
    if (!live.current || !keysLoaded() || !auth.accessToken) return;
    const epoch = ++requestEpoch.current;
    const current = () => {
      const next = useAuthStore.getState();
      return requestEpoch.current === epoch && live.current && keysLoaded() && isSameSession(auth, next) &&
        next.user?.id === auth.user?.id && next.device?.id === auth.device?.id;
    };
    void api.get<{ conversationId: string | null }>("/api/push/target").then(({ conversationId }) => {
      if (current()) navigate(conversationId ? `/chat/${encodeURIComponent(conversationId)}` : "/");
    }).catch(() => { if (current()) navigate("/"); });
  }, [navigate]);

  const resolveGroupCall = useCallback(() => {
    const auth = useAuthStore.getState();
    if (!live.current || !keysLoaded() || !auth.accessToken) return;
    const epoch = ++requestEpoch.current;
    // Let the unlocked CallProvider start its runtime before querying.
    void Promise.resolve().then(refreshGroupInvitations).then((invitations) => {
      const next = useAuthStore.getState();
      if (epoch !== requestEpoch.current || !live.current || !keysLoaded() || !isSameSession(auth, next)
        || next.user?.id !== auth.user?.id || next.device?.id !== auth.device?.id) return;
      const groups = [...new Set(invitations.filter(({ ringUntil }) => ringUntil > Date.now())
        .map(({ conversationId }) => conversationId))];
      const target = groups.length === 1 ? groups[0] : undefined;
      navigate(target ? `/chat/${encodeURIComponent(target)}` : "/", { replace: true });
    });
  }, [navigate]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const worker = navigator.serviceWorker;
    const open = (event: MessageEvent) => {
      if (!useAuthStore.getState().accessToken || event.data?.type !== "push-open" ||
          !validDestination(event.data.destination)) return;
      const destination = event.data.destination;
      if (destination === "/?push=group-call") {
        if (live.current && keysLoaded()) resolveGroupCall();
        else pendingGroupTap.current = useAuthStore.getState();
        return;
      }
      // These generic routes carry no account data. The route guard preserves the
      // destination in the unlock route's state and opens it only after unlocking.
      if (destination !== "/devices" && destination !== "/settings?section=privacy" && (!live.current || !keysLoaded())) return;
      requestEpoch.current++;
      if (destination === "/?push=message") resolveMessage();
      else navigate(destination);
    };
    worker.addEventListener("message", open);
    return () => worker.removeEventListener("message", open);
  }, [navigate, resolveMessage, resolveGroupCall]);
  useEffect(() => {
    void storePushLocale(locale, t("webPush.newMessage"), t("webPush.incomingCall"), t("deviceSignInPush"), t("deviceApprovalChangedPush")).catch(() => undefined);
  }, [locale]);
  useEffect(() => {
    // Explicit lock/sign-out clears subscriptions. Closing the tab keeps delivery enabled.
    if (!unlocked) return;
    const session = userId && deviceId ? { userId, deviceId, loginIdentity: pushSessionIdentity(useAuthStore.getState()) } : null;
    return registerUnlockedSessionCleanup(() => {
      requestEpoch.current++;
      void disableWebPush(accessToken, { accountTeardown: true, session }).catch(() => undefined);
    });
  }, [unlocked, userId, deviceId, accessToken, sessionId]);
  useEffect(() => useAuthStore.subscribe((next, previous) => {
    if (previous.accessToken && (next.sessionId !== previous.sessionId || next.user?.id !== previous.user?.id || next.device?.id !== previous.device?.id)) {
      const session = previous.user && previous.device ? { userId: previous.user.id, deviceId: previous.device.id, loginIdentity: pushSessionIdentity(previous) } : null;
      void disableWebPush(previous.accessToken, { accountTeardown: true, session }).catch(() => undefined);
    }
  }), []);
  useEffect(() => {
    const search = new URLSearchParams(location.search);
    if (search.get("push") !== "message") return;
    // Consume this legacy URL hint once, even when the base router forwards it through unlock.
    search.delete("push");
    const resolve = !queryHandled.current && unlocked && keysLoaded() && !!useAuthStore.getState().accessToken;
    queryHandled.current = true;
    // Successful lookup navigation consumes the hint; do not cancel it with an interim route change.
    if (resolve) resolveMessage();
    else navigate({ pathname: location.pathname, search: search.size ? `?${search}` : "", hash: location.hash }, { replace: true });
  }, [location.pathname, location.search, location.hash, unlocked, sessionId, userId, deviceId, navigate, resolveMessage]);
  useEffect(() => {
    if (!unlocked) return;
    const hadTap = pendingGroupTap.current;
    pendingGroupTap.current = null;
    if (new URLSearchParams(location.search).get("push") === "group-call"
      || (hadTap && isSameSession(hadTap, useAuthStore.getState()))) resolveGroupCall();
  }, [unlocked, location.search, resolveGroupCall]);
  return null;
}
