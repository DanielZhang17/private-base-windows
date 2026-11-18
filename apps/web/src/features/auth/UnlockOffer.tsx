import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { PasskeyInfo } from "@e2ee-chat/shared";
import { t } from "../../i18n/index.js";
import { localized } from "../../i18n/messages.js";
import { bindAccountUnlockEnrollment, removeAccountNativeUnlock } from "../../lib/passkey-provision.js";
import { capabilities } from "../../platform/capabilities.js";
import { canEnrollNativeUnlock, isNativeEnrollmentUnsupported, isUnlockPromptCancelled, useNativeUnlockStatus } from "../../platform/biometric-unlock.js";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { Button, Notice, useToast } from "../../ui/index.js";
import { enrollPasskeyUnlock } from "../settings/UnlockSettings.js";
import { unlockMethodInfo } from "./unlockMethods.js";
import { dismissUnlockOffer, unlockOfferFor } from "./unlockOfferState.js";

export function UnlockOffer() {
  const id = useAuthStore(state => state.device?.id);
  const offer = id ? unlockOfferFor(id) : null;
  const { available } = useNativeUnlockStatus();
  const native = canEnrollNativeUnlock() ? available : undefined;
  const navigate = useNavigate();
  const toast = useToast();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const passkeys = useQuery({ queryKey: ["passkeys"], queryFn: () => api.get<PasskeyInfo[]>("/api/passkeys"),
    enabled: !!offer && !native && capabilities.passkeys });
  if (!id || !offer || dismissed || (!native && !(capabilities.passkeys && passkeys.data?.length))) return null;
  const info = unlockMethodInfo(native ? "native" : "passkey", native);
  const hide = () => { dismissUnlockOffer(id); setDismissed(true); };
  return <Notice tone="info" icon={info.icon} action={<div className="flex gap-2">
    <Button size="sm" variant="secondary" loading={busy} onClick={() => {
      if (!native && passkeys.data?.length !== 1) { hide(); navigate("/settings?section=security"); return; }
      setBusy(true);
      setError(false);
      void (async () => {
        if (native) {
          const enroll = bindAccountUnlockEnrollment();
          if (offer === "restore") await removeAccountNativeUnlock();
          try { await enroll({ method: "native" }); }
          catch (err) {
            if (!isNativeEnrollmentUnsupported(err)) throw err;
            toast.show({ tone: "warning", message: localized("security.nativeEnrollmentUnsupported", { method: info.name }) });
            return;
          }
        } else if (passkeys.data?.[0]) await enrollPasskeyUnlock(passkeys.data[0].credentialId);
        hide();
        toast.show({ tone: "success", message: localized("security.methodTurnedOn", { method: info.name }) });
      })().catch(err => { if (!isUnlockPromptCancelled(err)) setError(true); }).finally(() => setBusy(false));
    }}>{t(offer === "restore" ? "unlock.restoreAction" : "unlock.offerAction", { method: info.name })}</Button>
    <Button size="sm" variant="ghost" disabled={busy} onClick={hide}>{t("unlock.offerLater")}</Button>
  </div>}>
    {t("unlock.offerBody", { method: info.name })}
    {error && <p role="alert">{t("passkeySetup.enrolFailed", { method: info.name })}</p>}
  </Notice>;
}
