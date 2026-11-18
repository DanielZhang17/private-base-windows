import { useState } from "react";
import { t } from "../../i18n/index.js";
import { formatRelativeTimestamp } from "../../i18n/format.js";
import ForgetLocalKeysDialog from "../../components/app/ForgetLocalKeysDialog.js";
import type { UnlockMethod } from "../../lib/device-key-vault.js";
import { Button, Field, Icon, Input, Notice, Select, Textarea } from "../../ui/index.js";
import { deviceIcon, linkMethodLabel } from "../devices/devicePresentation.js";
import type { useLoginFlow } from "./useLoginFlow.js";
import { AuthHeading } from "./AuthHeading.js";
import { unlockMethodInfo } from "./unlockMethods.js";

export function ReplaceDevice({ flow, selectedId, select }: {
  flow: ReturnType<typeof useLoginFlow>; selectedId: string | null; select: (id: string | null) => void;
}) {
  const cap = flow.passkeyDeviceLimit!;
  const [step, setStep] = useState<"notice" | "choose" | "confirm">("notice");
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [selectedUnlock, setUnlock] = useState<UnlockMethod>();
  const unlock = selectedUnlock && flow.resumeMethods.includes(selectedUnlock) ? selectedUnlock : flow.resumeMethods[0];
  const unlockLoading = flow.loading && !(unlock === "password" && flow.nativeUnlockPending);
  const selected = cap.devices.find(device => device.id === selectedId);
  const problem = flow.passkeySetupProblem;
  const replacementUnchanged = problem?.error === "replacement_not_needed";
  const replacementUnavailable = replacementUnchanged || problem?.error === "replacement_device_gone";
  const resume = flow.savedPasskeySetupId ? { method: unlock, password: unlock === "password" ? password : undefined } : undefined;
  const durable = !!flow.savedPasskeySetupId || (!!flow.passkeySetup?.pending && !flow.passkeySetup.canUsePasswordFallback());
  const canReplace = !!cap.limitTicket;
  const cancel = () => { select(null); void flow.cancelPasskeySetup(); };
  const restart = async () => {
    await flow.cancelPasskeySetup();
    await flow.preparePasskeyEntry(true);
  };
  const resumeFields = flow.savedPasskeySetupId && <>
    {flow.resumeMethods.length > 1 && <Field label={t("passkeySetup.chooseUnlock")}>
      <Select value={unlock} onChange={event => setUnlock(event.target.value as UnlockMethod)}>
        {flow.resumeMethods.map(method => <option key={method} value={method}>{unlockMethodInfo(method).name}</option>)}
      </Select>
    </Field>}
    {unlock === "password" && <Field label={t("passkeySetup.accountPassword")}>
      <Input type="password" required value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" />
    </Field>}
  </>;
  if (step === "notice" || !canReplace) return <>
    <AuthHeading title={t("signInHeading")} />
    <Notice tone="warning">{cap.slotsToFree > 1
      ? t("passkeySetup.freeSlots", { count: cap.slotsToFree })
      : t(canReplace ? "passkeySetup.errorDeviceLimit" : "passkeySetup.errorDeviceLimitNoRecovery", { limit: cap.limit })}</Notice>
    {!canReplace && resumeFields}
    {!canReplace && flow.error && problem?.error !== "limit_ticket_expired" && <Notice tone="danger">{flow.error}</Notice>}
    {canReplace
      ? <Button variant="secondary" onClick={() => setStep("choose")}>{t("replace.action")}</Button>
      : <Button variant="secondary" loading={unlockLoading}
        disabled={!!flow.savedPasskeySetupId && (!unlock || (unlock === "password" && !password))} onClick={() => {
        if (flow.savedPasskeySetupId) void flow.resumePasskeyUnlock(unlock, password);
        else if (flow.passkeySetup?.pending) void flow.retryPasskeySetup();
        else void restart();
      }}>{t("unlock.tryAgain")}</Button>}
    {!canReplace && durable && <>
      <Button variant="danger-ghost" disabled={flow.loading} onClick={flow.requestForgetSavedPasskeySetup}>{t("forgetThisDevice")}</Button>
      <ForgetLocalKeysDialog open={flow.confirmingForgetSavedPasskeySetup} loading={flow.loading} error={flow.error}
        onCancel={flow.cancelForgetSavedPasskeySetup} onForget={flow.confirmForgetSavedPasskeySetup} />
    </>}
    <Button variant="ghost" onClick={cancel} disabled={flow.loading}>{t("cancel")}</Button>
  </>;

  if (step === "choose" || !selected) return <>
    <AuthHeading title={t("replace.title")} />
    <p className="text-ink-muted" id="replace-help">{t("replace.body")}</p>
    <div role="radiogroup" aria-label={t("replace.title")} aria-describedby="replace-help"
      className="divide-y divide-line rounded-card border border-line bg-surface">
      {cap.devices.map(device => {
        const time = formatRelativeTimestamp(device.lastActiveAt);
        return <label key={device.id} className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2">
          <Icon name={deviceIcon(device.platform)} />
          <span className="min-w-0 grow"><span className="block break-words font-semibold">{device.name}</span>
            <span className="block text-sm text-ink-muted">{t("replace.rowMeta", { time, linkMethod: linkMethodLabel(device.linkMethod) })}</span></span>
          <input type="radio" name="replace-device" aria-label={`${device.name}, ${t("replace.rowMeta", { time, linkMethod: linkMethodLabel(device.linkMethod) })}`}
            checked={selectedId === device.id} onChange={() => select(device.id)} className="size-5 accent-[var(--brand)]" />
        </label>;
      })}
    </div>
    <p className="text-sm text-ink-muted">{t("replace.caption")}</p>
    <div className="mt-auto grid gap-2 pt-4">
      <Button size="lg" disabled={!selected} onClick={() => setStep("confirm")}>{t("continue")}</Button>
      <Button variant="ghost" onClick={cancel}>{t("cancel")}</Button>
    </div>
  </>;

  return <>
    <AuthHeading title={t("replace.confirmTitle")} />
    {!replacementUnchanged && <Notice tone="warning" title={t("replace.willSignOut", { deviceName: selected.name })}>{t("replace.willSignOutDetail")}</Notice>}
    {problem?.error === "limit_ticket_expired" && <Notice tone="warning" action={<Button variant="secondary" onClick={() => void restart()}>
      {t("replace.usePasskey")}</Button>}>{t("replace.ticketExpired")}</Notice>}
    {replacementUnavailable && <Notice tone="warning" action={problem?.canContinue
      ? <Button variant="secondary" loading={unlockLoading} onClick={() => void flow.replacePasskeyDevice(null, undefined, resume)}>{t("continue")}</Button> : undefined}>
      {t(replacementUnchanged ? "replace.slotAvailable" : problem?.canContinue ? "replace.alreadyGone" : "deviceAlert.alreadyRemoved", { deviceName: selected.name })}
    </Notice>}
    <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void flow.replacePasskeyDevice(selected.id, key.trim(), resume); }}>
      <Field label={t("recoveryKey")} help={t("replace.recoveryHelp")}
        error={problem?.error === "invalid_recovery_key" ? t("replace.wrongKey") : problem?.error === "limit_ticket_expired" || replacementUnavailable ? undefined : flow.error}>
        <Textarea value={key} onChange={event => setKey(event.target.value)} autoComplete="off" spellCheck={false} required />
      </Field>
      {resumeFields}
      <Button type="submit" variant="danger" size="lg" loading={unlockLoading} disabled={problem?.error === "limit_ticket_expired" || replacementUnchanged}>
        {t("replace.confirm", { deviceName: selected.name })}
      </Button>
    </form>
    <Button variant="ghost" onClick={() => { setKey(""); setStep("choose"); }} disabled={flow.loading}>{t("replace.chooseAnother")}</Button>
    <Button variant="ghost" onClick={cancel} disabled={flow.loading}>{t("cancel")}</Button>
  </>;
}
