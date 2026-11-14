import { formatTime } from "../i18n/format.js";
import { t, useLocale } from "../i18n/index.js";
import { useState } from "react";
import { Link } from "react-router-dom";
import ForgetLocalKeysPrompt from "../components/app/ForgetLocalKeysPrompt.js";
import { useLoginFlow } from "../features/auth/useLoginFlow.js";
import { Button, Field, Icon, IconButton, Input, ListItem, Notice, Spinner, Textarea } from "../ui/index.js";

export default function LoginPage() {
  useLocale();
  const flow = useLoginFlow();
  const [showPassword, setShowPassword] = useState(false);
  const {
    recoveryRetry, capabilities, username, setUsername, password, setPassword,
    recoveryKey, setRecoveryKey, error, loading, pendingLink, blockedOwner,
    linkCompleting, usernameInput, prefetchPasskeyOptions, handleSubmit,
    forgetLocalKeys, handlePasskeyLogin, signInAsOwner, cancelLink,
    step, setupMethod, useRecoveryKey, approveFromAnotherDevice, backToSignIn, retryLink,
  } = flow;

  if (blockedOwner !== undefined) {
    return <ForgetLocalKeysPrompt owner={blockedOwner} sameAccount={!!blockedOwner && blockedOwner.username === username}
      error={error} loading={loading} onSignInInstead={signInAsOwner} onForget={forgetLocalKeys} />;
  }

  return (
    <main className="h-dvh overflow-y-auto bg-canvas text-ink px-safe pt-safe pb-safe">
      <div className="flex min-h-full flex-col items-center px-4 py-7 sm:justify-center">
        <section className="flex w-full max-w-[26rem] flex-col gap-4 sm:rounded-card sm:border sm:border-line sm:bg-surface sm:p-8 sm:shadow-raised">
          <img src="/brand/icon-rounded.svg" alt="Private Base" className="size-14 rounded-card" />
          {pendingLink ? (
            <>
              <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">{pendingLink.mode === "recovery" ? t("finishingRecovery") : t("approveNewDevice")}</h1>
              <p className="text-ink-muted">{pendingLink.mode === "recovery"
                ? t("yourRecoveryWasAcceptedButThisDeviceCould")
                : t("openTheLinkedDevicesScreenOnAnAlready")}</p>
              {pendingLink.mode !== "recovery" && <div className="secret-text rounded-control bg-sunken p-4 text-center text-[1.75rem] font-semibold" aria-label={t("deviceLinkVerificationCodeLabel")}>{pendingLink.shortCode?.match(/.{1,3}/g)?.join(" ") ?? t("waitingForCode")}</div>}
              <p className="text-sm text-ink-muted">{t("expires", { deviceName: pendingLink.deviceName, value: formatTime(pendingLink.expiresAt) })}</p>
              <div role="status" className="flex items-center gap-2 text-sm text-ink-muted"><Spinner label={null} /><span>{pendingLink.mode === "recovery" ? t("stillWorking") : t("waitingForApproval2")}</span></div>
              {error && <Notice tone="danger" action={<Button size="sm" variant="secondary" disabled={linkCompleting} onClick={retryLink}>{t("retry")}</Button>}>{error}</Notice>}
              <Button variant="ghost" disabled={linkCompleting} onClick={cancelLink}>{t("cancel")}</Button>
            </>
          ) : step === "setup" ? (
            <>
              <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">{t("setUpThisDevice")}</h1>
              <p className="text-ink-muted">{t("linkThisBrowserToToAccessYourEncrypted", { username: username })}</p>
              {error && <Notice tone="danger">{error}</Notice>}
              {setupMethod === "recovery" ? (
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                  <Field label={t("recoveryKey")} help={t("useTheKeyYouSavedWhenYouCreated")}>
                    <Textarea placeholder={t("recoveryKey")} value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} required autoComplete="off" spellCheck={false} className="font-mono" />
                  </Field>
                  <Button type="submit" loading={loading}>{t("continue")}</Button>
                  <Button variant="secondary" leadingIcon="devices" disabled={loading} onClick={() => void approveFromAnotherDevice()}>{t("approveFromAnotherDevice")}</Button>
                </form>
              ) : (
                <div className="overflow-hidden rounded-control border border-line" aria-busy={loading}>
                  <ListItem leading={<Icon name="devices" />} title={t("approveFromAnotherDevice")} subtitle={t("useADeviceWhereYouReAlreadySigned")} trailing={<Icon name="chevron-right" />} disabled={loading} onClick={() => void approveFromAnotherDevice()} />
                  <ListItem leading={<Icon name="key" />} title={t("useMyRecoveryKey")} subtitle={t("enterTheRecoveryKeyYouSaved")} trailing={<Icon name="chevron-right" />} disabled={loading} onClick={useRecoveryKey} />
                </div>
              )}
              {loading && setupMethod !== "recovery" && <Spinner label={t("settingUpThisDevice")} />}
              <Button variant="ghost" leadingIcon="arrow-left" disabled={loading} onClick={backToSignIn}>{t("backToSignIn")}</Button>
            </>
          ) : (
            <>
              <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">{recoveryRetry ? t("finishRecovery") : t("signInHeading")}</h1>
              {error && <Notice tone="danger">{error}</Notice>}
              {recoveryRetry && <p className="text-ink-muted">{t("enterYourPasswordToUnlockThisDeviceS")}</p>}
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <Field label={t("username")}>
                  <Input ref={usernameInput} placeholder={t("username")} value={username} readOnly={!!recoveryRetry} onChange={(e) => setUsername(e.target.value)} onBlur={(e) => void prefetchPasskeyOptions(e.target.value)} required autoComplete="username" autoCapitalize="none" spellCheck={false} leading={<Icon name="user" size={18} />} />
                </Field>
                <Field label={t("password")}>
                  <Input type={showPassword ? "text" : "password"} placeholder={t("password")} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" trailing={<IconButton icon={showPassword ? "eye-off" : "eye"} label={showPassword ? t("hidePassword") : t("showPassword")} size="sm" onClick={() => setShowPassword(!showPassword)} />} />
                </Field>
                <Button type="submit" loading={loading}>{recoveryRetry ? t("finishRecovery") : t("signInAction")}</Button>
              </form>
              {capabilities.passkeys && !recoveryRetry && <>
                <div className="flex items-center gap-3 text-xs text-ink-subtle"><span className="h-px flex-1 bg-line" />{t("or")}<span className="h-px flex-1 bg-line" /></div>
                <Button variant="secondary" leadingIcon="passkey" disabled={loading} onClick={() => void handlePasskeyLogin()}>{t("signInWithAPasskey")}</Button>
              </>}
              <p className="text-center text-sm text-ink-muted">{t("newHere")} <Link to="/register" className="inline-flex min-h-11 items-center font-semibold text-brand hover:underline">{t("createAnAccount")}</Link></p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
