import { useState } from "react";
import { t } from "../../i18n/index.js";
import ForgetLocalKeysDialog from "../../components/app/ForgetLocalKeysDialog.js";
import { Button, ConfirmDialog, Field, Icon, Input, Notice, Spinner } from "../../ui/index.js";
import type { useLoginFlow } from "./useLoginFlow.js";
import { AuthHeading } from "./AuthHeading.js";
import { unlockMethodInfo } from "./unlockMethods.js";

export function DeviceSetup({ flow }: { flow: ReturnType<typeof useLoginFlow> }) {
  const [confirmSkip, setConfirmSkip] = useState(false);
  const pending = flow.passkeySetup?.pending;
  const { error, loading, password, setPassword } = flow;
  const method = flow.setupUnlockMethod ?? "password";
  const info = unlockMethodInfo(method, flow.capabilities.biometricUnlock);

  if (flow.savedPasskeySetupId && !flow.setupScreen) return <>
    <AuthHeading title={t("passkeySetup.finishSetupTitle")} />
    <p className="text-ink-muted">{t("passkeySetup.finishSetupBody", { deviceName: pending?.deviceName ?? flow.savedSetupDeviceName })}</p>
    {flow.passkeyApproval
      ? <Notice tone="warning" title={t("passkeySetup.approvalTitle")}
        action={<Button variant="secondary" disabled={loading} onClick={flow.requestForgetSavedPasskeySetup}>{t("setUpThisDevice")}</Button>}>
        {t("passkeySetup.approvalBody")}
      </Notice>
      : error && <Notice tone="danger">{error}</Notice>}
    {flow.resumeMethods.filter(method => method !== "password").map(method => {
      const option = unlockMethodInfo(method, flow.capabilities.biometricUnlock);
      return <Button key={method} size="lg" leadingIcon={option.icon} disabled={loading}
        onClick={() => void flow.resumePasskeyUnlock(method)}>{option.label}</Button>;
    })}
    {flow.resumeMethods.includes("password") && <form onSubmit={flow.completePasskeySetupWithPassword} className="grid gap-4">
      <Field label={t("passkeySetup.accountPassword")}><Input type="password" value={password} onChange={event => setPassword(event.target.value)} required autoComplete="current-password" /></Field>
      <Button type="submit" size="lg" loading={loading}>{t("continue")}</Button>
    </form>}
    {!flow.passkeyApproval && <Button variant="danger-ghost" disabled={loading} onClick={flow.requestForgetSavedPasskeySetup}>{t("forgetThisDevice")}</Button>}
    <ForgetLocalKeysDialog open={flow.confirmingForgetSavedPasskeySetup} loading={loading} error={error}
      onCancel={flow.cancelForgetSavedPasskeySetup} onForget={flow.confirmForgetSavedPasskeySetup} />
  </>;

  if (flow.setupScreen === "progress") return <>
    <AuthHeading title={t("passkeySetup.settingUpTitle")} />
    <ol aria-live="polite" className="grid">
      {pending && <li className="flex min-h-11 items-center gap-3"><Icon name="check-circle" className="text-success" />
        {t("passkeySetup.stepPasskey", { username: pending.user.username })}</li>}
      <li className="flex min-h-11 items-center gap-3"><Icon name="check-circle" className="text-success" />{t("passkeySetup.stepKeys")}</li>
      <li className="flex min-h-11 items-center gap-3">
        {pending || error ? <Icon name={pending ? "check-circle" : "alert-circle"} className={pending ? "text-success" : "text-danger"} /> : <Spinner label={null} />}
        {t("passkeySetup.stepRegister", { deviceName: pending?.deviceName ?? flow.savedSetupDeviceName })}
      </li>
    </ol>
    <p className="text-sm text-ink-muted">{t("passkeySetup.keysStayHere")}</p>
    {pending && <p className="text-sm text-ink-muted">{t("passkeySetup.previewSignIn")}</p>}
    {error && <Notice tone="danger" action={<Button variant="secondary" onClick={() => void flow.retryPasskeySetup()}>{t("retry")}</Button>}>{error}</Notice>}
    {pending && method !== "passkey" && <Button size="lg" disabled={loading} onClick={flow.beginUnlockSetup}>{t("continue")}</Button>}
    <Button variant="ghost" disabled={loading} onClick={() => void flow.cancelPasskeySetup()}>{t("cancel")}</Button>
  </>;

  if (flow.setupScreen === "activation") return <>
    <AuthHeading title={t("passkeySetup.finishSetupTitle")} />
    {error && <Notice tone="danger">{error}</Notice>}
    <Button size="lg" loading={loading} onClick={() => void flow.retryPasskeySetup()}>
      {t(loading ? "passkeySetup.finishing" : "retry")}
    </Button>
    <Button variant="ghost" disabled={loading} onClick={() => void flow.cancelPasskeySetup()}>{t("cancel")}</Button>
  </>;

  if (flow.setupScreen === "backup") return <>
    <AuthHeading title={t("passkeySetup.addPasswordTitle")} />
    <p className="text-ink-muted">{t("passkeySetup.addPasswordBody", { method: info.name })}</p>
    {error && <Notice tone="danger">{error}</Notice>}
    <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void flow.finishWithBackupPassword(password); }}>
      <Field label={t("passkeySetup.accountPassword")}><Input type="password" autoComplete="current-password" required
        value={password} onChange={event => setPassword(event.target.value)} /></Field>
      <Button type="submit" size="lg" loading={loading}>{t(loading ? "passkeySetup.finishing" : "passkeySetup.addPasswordAction")}</Button>
    </form>
    <Button variant="ghost" disabled={loading} onClick={() => setConfirmSkip(true)}>{t("passkeySetup.skip")}</Button>
    <Button variant="ghost" disabled={loading} onClick={() => void flow.cancelPasskeySetup()}>{t("cancel")}</Button>
    <ConfirmDialog open={confirmSkip} title={t("passkeySetup.skipPasswordTitle")}
      description={t("passkeySetup.skipPasswordBody", { method: info.name })} confirmLabel={t("passkeySetup.skip")}
      cancelLabel={t("passkeySetup.addPasswordAction")} onCancel={() => setConfirmSkip(false)}
      onConfirm={() => { setConfirmSkip(false); void flow.finishWithBackupPassword(); }} />
  </>;

  if (flow.passwordOnly || flow.passkeyPasswordRequired) return <>
    <AuthHeading title={t("passkeySetup.passwordOnceTitle")} />
    <p className="text-ink-muted">{t(method === "password" && !flow.capabilities.nativePasskeyProvisioning
      ? "passkeySetup.passwordOnceBody" : "passkeySetup.choosePasswordBody")}</p>
    {error && <Notice tone="danger" action={flow.passkeySetup && !flow.passkeySetup.canUsePasswordFallback()
      ? <Button variant="secondary" onClick={() => void flow.retryPasskeySetup()}>{t("retry")}</Button> : undefined}>{error}</Notice>}
    <form onSubmit={flow.completePasskeySetupWithPassword} className="grid gap-4">
      <Field label={t("passkeySetup.accountPassword")}><Input type="password" value={password}
        onChange={event => setPassword(event.target.value)} required autoComplete="current-password" /></Field>
      <Button type="submit" size="lg" loading={loading}>{t(loading ? "passkeySetup.finishing" : "continue")}</Button>
    </form>
    <Button variant="ghost" disabled={loading} onClick={() => void flow.cancelPasskeySetup()}>{t("cancel")}</Button>
  </>;

  return <>
    {flow.capabilities.historyTransfer && <p className="text-sm font-semibold text-ink-subtle">{t("passkeySetup.stepOf", { current: 1, total: 2 })}</p>}
    <AuthHeading title={t(method === "passkey" ? "passkeySetup.unlockPasskeyTitle" : "passkeySetup.unlockBiometricTitle", { method: info.name })} />
    <p className="text-ink-muted">{t(method === "passkey" ? "passkeySetup.unlockPasskeyBody" : "passkeySetup.unlockBiometricBody", { method: info.name })}</p>
    <div className="grid size-16 place-items-center rounded-card bg-brand-soft text-on-brand-soft sm:hidden"><Icon name={info.icon} size={30} /></div>
    {method === "passkey" && <p role="status" className="flex items-center gap-2"><Icon name="check-circle" className="text-success" />{t("passkeySetup.passkeyUnlockOn")}</p>}
    {error && <Notice tone="danger">{t("passkeySetup.enrolFailed", { method: info.name })}</Notice>}
    <Button size="lg" loading={loading} onClick={() => void flow.enrollPasskeySetupUnlock()}>
      {t(method === "passkey" ? "continue" : "passkeySetup.useMethod", { method: info.name })}
    </Button>
    {method === "passkey"
      ? <Button variant="ghost" disabled={loading} onClick={() => void flow.cancelPasskeySetup()}>{t("cancel")}</Button>
      : <Button variant="ghost" disabled={loading} onClick={flow.chooseSetupPassword}>{t("passkeySetup.usePasswordOnly")}</Button>}
  </>;
}
