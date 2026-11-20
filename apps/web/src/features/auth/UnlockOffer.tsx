import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { PasskeyInfo } from "@e2ee-chat/shared";
import { t } from "../../i18n/index.js";
import { localized } from "../../i18n/messages.js";
import { bindAccountUnlockEnrollment, removeAccountNativeUnlock } from "../../lib/passkey-provision.js";
import { capabilities } from "../../platform/capabilities.js";
import { canEnrollNativeUnlock, isNativeEnrollmentUnsupported, isUnlockPromptCancelled, useNativeUnlockStatus } from "../../platform/biometric-unlock.js";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { useAppObscured } from "../calls/call-surface.js";
import { Button, Dialog, Notice, useToast } from "../../ui/index.js";
import { getTopOverlay, subscribeToTopOverlay } from "../../ui/overlay-stack.js";
import { enrollPasskeyUnlock } from "../settings/UnlockSettings.js";
import { unlockMethodInfo } from "./unlockMethods.js";
import { dismissUnlockOffer, unlockOfferFor } from "./unlockOfferState.js";
import { UNLOCK_OFFER_IDLE_MS, unlockOfferRoute, useUnlockOfferHeld } from "./unlockOfferGate.js";

// Only the first mounted instance shows the dialog, even if the offer is rendered twice.
const slots: object[] = [];
const slotListeners = new Set<() => void>();
const notifySlots = () => slotListeners.forEach((listener) => listener());
const subscribeSlots = (listener: () => void) => { slotListeners.add(listener); return () => { slotListeners.delete(listener); }; };
const subscribeOverlays = (listener: () => void) => subscribeToTopOverlay(() => listener());
const overlayOpen = () => !!getTopOverlay();

/**
 * True while this instance may show the offer. It opens only when the user is at rest: on the chat list or a chat,
 * with no security alert, setup or transfer step, call or other overlay, for a short idle moment. Once open, later
 * modals stack above it, but an alert or setup step that appears closes it again (without dismissing the offer).
 */
function useOfferSlot(ready: boolean) {
  const [slot] = useState(() => ({}));
  useEffect(() => {
    slots.push(slot);
    notifySlots();
    return () => { slots.splice(slots.indexOf(slot), 1); notifySlots(); };
  }, [slot]);
  const owner = useSyncExternalStore(subscribeSlots, () => slots[0] === slot, () => false);
  const othersOpen = useSyncExternalStore(subscribeOverlays, overlayOpen, () => false);
  const { pathname } = useLocation();
  const held = useUnlockOfferHeld();
  const obscured = useAppObscured();
  const inCall = useCallStore((state) => !!state.activeCallId);
  const calm = owner && ready && unlockOfferRoute(pathname) && !held && !obscured && !inCall;
  const [settled, setSettled] = useState(false);
  // Once shown, the dialog's own layer is on the stack, so `othersOpen` no longer applies.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!calm) { setSettled(false); setOpened(false); return; }
    if (opened || othersOpen) { if (!opened) setSettled(false); return; }
    const timer = setTimeout(() => setSettled(true), UNLOCK_OFFER_IDLE_MS);
    return () => clearTimeout(timer);
  }, [calm, opened, othersOpen]);
  const visible = calm && (opened || (settled && !othersOpen));
  useLayoutEffect(() => { if (visible) setOpened(true); }, [visible]);
  return visible;
}

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
  const ready = !!id && !!offer && !dismissed && (!!native || !!(capabilities.passkeys && passkeys.data?.length));
  const visible = useOfferSlot(ready);
  if (!id || !offer || !visible) return null;
  const info = unlockMethodInfo(native ? "native" : "passkey", native);
  const hide = () => { dismissUnlockOffer(id); setDismissed(true); };
  // A small dialog rather than a banner pinned above the app, where it was easy to miss.
  return <Dialog open title={t("unlock.offerTitle", { method: info.name })} description={t("unlock.offerBody", { method: info.name })}
    dismissible={!busy} dismissOnBack onClose={hide}
    footer={<>
    <Button variant="secondary" disabled={busy} onClick={hide}>{t("unlock.offerLater")}</Button>
    <Button leadingIcon={info.icon} loading={busy} onClick={() => {
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
    </>}>
    {error && <Notice tone="danger">{t("passkeySetup.enrolFailed", { method: info.name })}</Notice>}
  </Dialog>;
}
