import { getLocale, t, useLocale } from "../i18n/index.js";
import { useState } from "react";
import { Navigate } from "react-router-dom";
import ForgetLocalKeysDialog from "../components/app/ForgetLocalKeysDialog.js";
import { useUnlock } from "../features/auth/useUnlock.js";
import { Avatar, Button, Field, Icon, IconButton, Input, Notice } from "../ui/index.js";

export default function UnlockPage() {
  useLocale();
  const {
    redirectTo, auth, avatarSrc, passwordInput, password, setPassword, error,
    loading, confirmForget, setConfirmForget, handleUnlock, handleForgetDevice,
    methodsRead, retryReadMethods, nativeRecovery,
    unlockPhase, failureKind, retrySeconds, preferred, info, hasPassword, showPassword: usePassword, setChosenPassword, handleUnlockWith,
  } = useUnlock();
  const [showPassword, setShowPassword] = useState(false);

  const countdown = new Intl.NumberFormat(getLocale(), { style: "unit", unit: "second", unitDisplay: "short" }).format(retrySeconds);

  if (redirectTo) return <Navigate to={redirectTo} replace />;

  return (
    <main className="h-dvh overflow-y-auto bg-canvas text-ink px-safe pt-safe pb-safe">
      <div className="flex min-h-full flex-col items-center px-4 py-7 sm:justify-center">
        <section className="flex min-h-[calc(100dvh-3.5rem)] w-full max-w-[26rem] flex-col gap-4 sm:min-h-0 sm:rounded-card sm:border sm:border-line sm:bg-surface sm:p-8 sm:shadow-raised">
          <div className="flex items-center justify-between">
            <img src="/brand/icon-rounded.svg" alt="Private Base" className="size-12 rounded-card" />
            <Icon name="lock" className="text-ink-subtle" />
          </div>
          <div className="self-center"><Avatar name={auth.user?.displayName ?? auth.user?.username ?? t("yourAccount")} src={avatarSrc} size="lg" /></div>
          <h1 className="text-center text-[1.75rem] leading-tight font-semibold tracking-tight">{t("welcomeBackName", { name: auth.user?.displayName ?? auth.user?.username })}</h1>
          {methodsRead === "failed" && <Notice tone="danger" action={<Button variant="secondary" onClick={retryReadMethods}>{t("retry")}</Button>}>
            {t("failedToUnlockThisDevice")}
          </Notice>}
          {nativeRecovery && <Notice tone="warning">{nativeRecovery}</Notice>}
          {preferred && info && !usePassword && failureKind !== "invalidated" && <>
            <p className="text-center text-ink-muted">{preferred === "passkey" ? t("unlock.bodyPasskey") : t("unlock.bodyMethod", { method: info.name })}</p>
            {error && !confirmForget && <Notice tone={failureKind === "temporary" || failureKind === "unsupported" ? "warning" : "danger"}>{error}</Notice>}
            <Button className="mt-auto sm:mt-0" size="lg" leadingIcon={info.icon} loading={loading} onClick={() => void handleUnlockWith(preferred)}>
              {unlockPhase === "unlocking" ? t("unlock.unlocking") : failureKind ? t("unlock.tryAgain") : info.label}
            </Button>
            {hasPassword && <Button variant="ghost" disabled={loading && preferred !== "native"} onClick={() => setChosenPassword(true)}>{t("unlock.usePasswordInstead")}</Button>}
          </>}
          {unlockPhase === "waiting" && info && <p role="status" className="text-sm text-ink-muted">{t("unlock.waiting", { method: info.name })}</p>}
          {usePassword ? <>
            {failureKind && !confirmForget && <Notice tone={failureKind === "failed" ? "danger" : "warning"}>{error}</Notice>}
            <p className="text-center text-ink-muted">{t("enterYourPasswordToUnlockYourMessagesOn")}</p>
            <form onSubmit={handleUnlock} className="flex flex-col gap-4">
              <Field label={t("password")} error={!confirmForget && (retrySeconds ? t("unlock.tooManyAttempts", { time: countdown }) : !failureKind ? error : undefined)}>
                <Input ref={passwordInput} type={showPassword ? "text" : "password"} placeholder={t("password")} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" trailing={<IconButton icon={showPassword ? "eye-off" : "eye"} label={showPassword ? t("hidePassword") : t("showPassword")} size="sm" onClick={() => setShowPassword(!showPassword)} />} />
              </Field>
              <Button type="submit" size="lg" loading={loading} disabled={!password || !!retrySeconds} className="tabular-nums">
                {retrySeconds ? countdown : t(loading ? "unlock.unlocking" : "unlock")}
              </Button>
            </form>
            {preferred && info && failureKind !== "invalidated" && <Button variant="ghost" leadingIcon={info.icon} disabled={loading}
              onClick={() => { setChosenPassword(false); void handleUnlockWith(preferred); }}>{info.label}</Button>}
          </> : failureKind === "invalidated" && !confirmForget && <Notice tone="danger">{error}</Notice>}
          {methodsRead === "ready" && failureKind !== "temporary" && <Button variant={failureKind === "invalidated" && !hasPassword ? "primary" : "danger-ghost"}
            size={failureKind === "invalidated" && !hasPassword ? "lg" : "sm"} className={failureKind === "invalidated" && !hasPassword ? "mt-auto sm:mt-0" : "mt-2 self-center"} disabled={loading} onClick={() => void handleForgetDevice()}>
            {t(failureKind === "invalidated" && !hasPassword ? "unlock.resetDevice" : "forgetThisDevice")}
          </Button>}
        </section>
      </div>
      <ForgetLocalKeysDialog open={confirmForget} loading={loading} error={error} onForget={() => void handleForgetDevice()} onCancel={() => setConfirmForget(false)} />
    </main>
  );
}
