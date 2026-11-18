import { useCallback, useEffect, useId, useState } from "react";
import type { PasskeyInfo } from "@e2ee-chat/shared";
import { t } from "../../i18n/index.js";
import { localized } from "../../i18n/messages.js";
import { hasPendingNativeUnlockRemoval, localPasskeyUnlockId, listLocalUnlockMethods, removeLocalUnlockMethod, retryNativeKeyCleanup } from "../../lib/key-manager.js";
import { bindAccountUnlockEnrollment, removeAccountNativeUnlock } from "../../lib/passkey-provision.js";
import { subscribeToUnlockMethodChanges } from "../../lib/unlock-method-changes.js";
import { evaluatePasskeyPrf } from "../../lib/webauthn.js";
import { unlockMethodAvailable, type UnlockMethod } from "../../lib/device-key-vault.js";
import { canEnrollNativeUnlock, canProbeNativeUnlock, canRemoveNativeUnlock, isNativeEnrollmentUnsupported, isUnlockPromptCancelled,
  nativeUnlockLabel, refreshNativeUnlockCapability, useNativeUnlockStatus } from "../../platform/biometric-unlock.js";
import { capabilities } from "../../platform/capabilities.js";
import { Button, ConfirmDialog, Dialog, Icon, Notice, useToast } from "../../ui/index.js";
import { unlockMethodInfo } from "../auth/unlockMethods.js";
import { PasswordUnlockDialog } from "./PasswordUnlockDialog.js";

export function useUnlockSettings(active: boolean) {
  const [methods, setMethods] = useState<UnlockMethod[]>([]);
  const [passkeyId, setPasskeyId] = useState<string>();
  const [nativeRemovalPending, setNativeRemovalPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!active) return;
    const unsubscribe = subscribeToUnlockMethodChanges(refresh);
    window.addEventListener("focus", refresh);
    return () => { unsubscribe(); window.removeEventListener("focus", refresh); };
  }, [active, refresh]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.all([listLocalUnlockMethods(), localPasskeyUnlockId(), hasPendingNativeUnlockRemoval()]).then(([list, id, pending]) => {
      if (!cancelled) { setMethods(list); setPasskeyId(id); setNativeRemovalPending(pending); }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, revision]);
  return { methods, passkeyId, nativeRemovalPending, refresh,
    isLastUsable: (method: UnlockMethod) => methods.includes(method) &&
      !methods.some(other => other !== method && unlockMethodAvailable(other)),
  };
}

export async function enrollPasskeyUnlock(credentialId: string, rpId: string = window.location.hostname) {
  const enroll = bindAccountUnlockEnrollment();
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const output = await evaluatePasskeyPrf(credentialId, rpId, salt);
  try { await enroll({ method: "passkey", credentialId, rpId, salt, output }); }
  finally { output.fill(0); }
}

export function UnlockSettings({ vault, passkeys, onLock, addPassword, closePassword, openPassword }: {
  vault: ReturnType<typeof useUnlockSettings>; passkeys: Pick<PasskeyInfo, "credentialId" | "friendlyName">[];
  onLock: () => void; addPassword: boolean; closePassword: () => void; openPassword: () => void;
}) {
  const help = useId();
  const toast = useToast();
  const [busy, setBusy] = useState<UnlockMethod>();
  const [error, setError] = useState("");
  const [prfUnsupported, setPrfUnsupported] = useState(false);
  useEffect(() => {
    void globalThis.PublicKeyCredential?.getClientCapabilities?.().then(values => setPrfUnsupported(values["extension:prf"] === false)).catch(() => undefined);
  }, []);
  const [confirmOff, setConfirmOff] = useState(false);
  const [choosePasskey, setChoosePasskey] = useState(false);
  const { available, unsupported: nativeUnsupported, probeFailed } = useNativeUnlockStatus();
  const canEnroll = canEnrollNativeUnlock();
  const canRemove = canRemoveNativeUnlock();
  const hasNative = vault.methods.includes("native");
  const showNative = canEnroll || nativeUnsupported || (canRemove && (hasNative || vault.nativeRemovalPending || probeFailed));
  const native = nativeUnlockLabel();
  const alternate = unlockMethodInfo(hasNative || showNative ? "native" : "passkey", native);
  const passkey = passkeys.find(item => item.credentialId === vault.passkeyId);
  const [retryingProbe, setRetryingProbe] = useState(false);

  async function change(method: UnlockMethod, on: boolean, credentialId?: string) {
    setBusy(method);
    setError("");
    const info = unlockMethodInfo(method, native);
    try {
      if (!on && method === "native") await removeAccountNativeUnlock();
      else if (!on) await removeLocalUnlockMethod(method);
      else if (method === "native") await bindAccountUnlockEnrollment()({ method: "native" });
      else if (credentialId) await enrollPasskeyUnlock(credentialId);
      toast.show({ tone: "success", message: localized(on ? "security.methodTurnedOn" : "security.methodTurnedOff", { method: info.name }) });
      setChoosePasskey(false);
      setConfirmOff(false);
    } catch (err) {
      if (!(on && method === "native" && isNativeEnrollmentUnsupported(err)) && !isUnlockPromptCancelled(err)) {
        setError(t("passkeySetup.enrolFailed", { method: info.name }));
      }
    } finally { vault.refresh(); setBusy(undefined); }
  }

  async function retryRemoval() {
    setBusy("native");
    setError("");
    try { await retryNativeKeyCleanup({ background: false }); }
    catch { setError(t("genericError")); }
    finally { vault.refresh(); setBusy(undefined); }
  }

  const methods: UnlockMethod[] = showNative ? ["native", "password"] : ["passkey", "password"];
  const isLast = (method: UnlockMethod) => vault.methods.includes(method) && !vault.methods.some(other => other !== method &&
    unlockMethodAvailable(other) && (other !== "passkey" || !prfUnsupported));
  return <section className="space-y-3">
    <h2 className="font-semibold">{t("security.unlockHeading")}</h2>
    <p className="text-sm text-ink-muted">{t("security.unlockBody")}</p>
    <div className="divide-y divide-line rounded-card border border-line">
      {methods.map(method => {
        const info = unlockMethodInfo(method, native);
        const on = vault.methods.includes(method);
        const last = isLast(method);
        const unsupported = method === "passkey" && !on && (!capabilities.passkeys || prfUnsupported);
        const detail = method === "password" ? t("security.passwordSubtitle") : method === "passkey"
          ? unsupported ? t("security.prfUnsupported") : passkey ? t("security.passkeyUses", { credentialName: passkey.friendlyName })
            : vault.passkeyId ? t("security.removedPasskeyInUse") : t("security.methodOff")
          : !on && nativeUnsupported ? t("security.nativeEnrollmentUnsupported", { method: info.name }) : t(on ? "security.methodOn" : "security.methodOff");
        return <label key={method} className="flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2" aria-busy={busy === method}>
          <Icon name={info.icon} /><span className="min-w-0 grow"><span className="block font-semibold">{info.name}</span>
            <span className="block text-sm text-ink-muted" aria-live={method === "native" ? "polite" : undefined}>{detail}</span></span>
          <input type="checkbox" role="switch" className="peer sr-only forced-colors:not-sr-only forced-colors:size-5 forced-colors:shrink-0" aria-label={info.name} checked={on}
            aria-describedby={last ? help : undefined} disabled={!!busy || last || unsupported || !vault.methods.length ||
              (method === "native" && (on ? !canRemove : vault.nativeRemovalPending || !canEnroll)) ||
              (method === "passkey" && !on && !passkeys.length)}
            onChange={event => {
              const next = event.target.checked;
              if (method === "password") { if (next) openPassword(); else setConfirmOff(true); }
              else if (method === "passkey" && next && passkeys.length > 1) setChoosePasskey(true);
              else void change(method, next, passkeys[0]?.credentialId);
            }} />
          <span aria-hidden="true" className="relative h-6 w-11 shrink-0 rounded-full bg-ink-subtle peer-checked:bg-brand peer-disabled:opacity-60 forced-colors:hidden
            peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus-ring)]
            before:absolute before:start-0.5 before:top-0.5 before:size-5 before:rounded-full before:bg-white before:shadow-sm
            peer-checked:before:translate-x-5 rtl:peer-checked:before:-translate-x-5" />
        </label>;
      })}
    </div>
    {methods.some(isLast) && <p id={help} className="text-sm text-ink-muted">{t("security.keepOne")}</p>}
    {canRemove && vault.nativeRemovalPending
      ? <Notice tone="warning" action={<Button variant="secondary" disabled={!!busy} onClick={() => void retryRemoval()}>{t("retry")}</Button>}>
        {t("genericError")}
      </Notice>
      : error && !confirmOff && !choosePasskey && <Notice tone="danger">{error}</Notice>}
    {!available && canProbeNativeUnlock() && (hasNative || probeFailed) && <Notice tone="warning" action={
      <Button variant="secondary" loading={retryingProbe} onClick={() => {
        setRetryingProbe(true);
        void refreshNativeUnlockCapability().finally(() => setRetryingProbe(false));
      }}>{t("unlock.tryAgain")}</Button>
    }>{t("unlock.nativeUnavailable", { method: alternate.name })}</Notice>}
    <Button variant="secondary" onClick={onLock}>{t("lockNow")}</Button>
    <PasswordUnlockDialog open={addPassword} method={alternate.name} onClose={closePassword} onSaved={vault.refresh} />
    <ConfirmDialog open={confirmOff} tone="danger" title={t("security.turnOffPasswordTitle")}
      description={t("security.turnOffPasswordBody", { method: alternate.name })} confirmLabel={t("security.turnOffPasswordConfirm")}
      busy={busy === "password"} error={error} onCancel={() => { setConfirmOff(false); setError(""); }}
      onConfirm={() => void change("password", false)} />
    <Dialog open={choosePasskey} title={t("unlock.withPasskey")} dismissible={!busy} onClose={() => setChoosePasskey(false)}>
      <div className="grid gap-2">{passkeys.map(item => <Button variant="secondary" key={item.credentialId} disabled={!!busy}
        onClick={() => void change("passkey", true, item.credentialId)}>{item.friendlyName}</Button>)}</div>
      {error && <Notice tone="danger">{error}</Notice>}
    </Dialog>
  </section>;
}
