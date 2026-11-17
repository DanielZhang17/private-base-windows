import { useLayoutEffect } from "react";
import { t, useLocale } from "../../i18n/index.js";
import { useIncomingCall } from "../../features/calls/useIncomingCall.js";
import { Button, Notice } from "../../ui/index.js";
import { OVERLAY_RANK, registerOverlay } from "../../ui/overlay-stack.js";
import UserAvatar from "../avatar/UserAvatar.js";

export default function IncomingCallModal() {
  useLocale();
  const call = useIncomingCall();
  useLayoutEffect(() => call.visible ? registerOverlay({ kind: "modal", rank: OVERLAY_RANK.incomingCall }) : undefined, [call.visible]);
  if (!call.visible) return null;
  return <section role="dialog" aria-label={t("incomingCall")} className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-6 bg-raised px-safe pt-safe pb-safe text-center text-ink shadow-overlay sm:inset-auto sm:top-[calc(var(--safe-top)+var(--titlebar-height)+1rem)] sm:end-4 sm:w-90 sm:rounded-card sm:border sm:border-line sm:p-6">
    <div className="flex flex-col items-center gap-3 p-4"><UserAvatar avatarUrl={call.callerAvatarUrl} displayName={call.callerName ?? t("unknownCaller")} size="xl" />
      <h2 className="text-xl font-semibold">{call.callerName ?? t("unknownCaller")}</h2><p className="text-ink-muted">{call.callType === "video" ? t("incomingVideoCall") : t("incomingVoiceCall")}</p>
      {!call.keyReady && <p role="status" className="text-sm text-ink-muted">{t("preparingSecureCallInvite")}</p>}
    </div>
    {call.callUnsupported && <Notice tone="warning">{t("encryptedCallsArenTSupportedOnThisDevice")}</Notice>}
    {call.error && <Notice tone="danger">{call.error}</Notice>}
    <div className="flex gap-4 pb-4"><Button variant="danger" leadingIcon="phone-off" size="lg" onClick={() => void call.respond("decline")} loading={call.loadingAction === "decline"} disabled={!!call.loadingAction}>{t("decline")}</Button>
      <Button leadingIcon="phone" size="lg" className="bg-ok text-on-ok hover:not-disabled:bg-ok" onClick={() => void call.respond("accept")} loading={call.loadingAction === "accept"} disabled={!!call.loadingAction || !call.keyReady || call.callUnsupported}>{t("accept")}</Button></div>
  </section>;
}
