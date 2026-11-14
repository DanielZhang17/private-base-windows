import { t, useLocale } from "../i18n/index.js";
import { useState } from "react";
import { Navigate } from "react-router-dom";
import ForgetLocalKeysDialog from "../components/app/ForgetLocalKeysDialog.js";
import { useUnlock } from "../features/auth/useUnlock.js";
import { Avatar, Button, Field, Icon, IconButton, Input } from "../ui/index.js";

export default function UnlockPage() {
  useLocale();
  const {
    redirectTo, auth, avatarSrc, passwordInput, password, setPassword, error,
    loading, confirmForget, setConfirmForget, handleUnlock, handleForgetDevice,
  } = useUnlock();
  const [showPassword, setShowPassword] = useState(false);

  if (redirectTo) return <Navigate to={redirectTo} replace />;

  return (
    <main className="h-dvh overflow-y-auto bg-canvas text-ink px-safe pt-safe pb-safe">
      <div className="flex min-h-full flex-col items-center px-4 py-7 sm:justify-center">
        <section className="flex w-full max-w-[26rem] flex-col gap-4 sm:rounded-card sm:border sm:border-line sm:bg-surface sm:p-8 sm:shadow-raised">
          <div className="flex items-center justify-between">
            <img src="/brand/icon-rounded.svg" alt="Private Base" className="size-12 rounded-card" />
            <Icon name="lock" className="text-ink-subtle" />
          </div>
          <div className="self-center"><Avatar name={auth.user?.displayName ?? auth.user?.username ?? t("yourAccount")} src={avatarSrc} size="lg" /></div>
          <h1 className="text-center text-[1.75rem] leading-tight font-semibold tracking-tight">{t("welcomeBackName", { name: auth.user?.displayName ?? auth.user?.username })}</h1>
          <p className="text-center text-ink-muted">{t("enterYourPasswordToUnlockYourMessagesOn")}</p>
          <form onSubmit={handleUnlock} className="flex flex-col gap-4">
            <Field label={t("password")} error={!confirmForget ? error : undefined}>
              <Input ref={passwordInput} type={showPassword ? "text" : "password"} placeholder={t("password")} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" trailing={<IconButton icon={showPassword ? "eye-off" : "eye"} label={showPassword ? t("hidePassword") : t("showPassword")} size="sm" onClick={() => setShowPassword(!showPassword)} />} />
            </Field>
            <Button type="submit" loading={loading} disabled={!password}>{t("unlock")}</Button>
          </form>
          <Button variant="danger-ghost" size="sm" className="mt-2 self-center" disabled={loading} onClick={() => void handleForgetDevice()}>{t("forgetThisDevice")}</Button>
        </section>
      </div>
      <ForgetLocalKeysDialog open={confirmForget} loading={loading} error={error} onForget={() => void handleForgetDevice()} onCancel={() => setConfirmForget(false)} />
    </main>
  );
}
