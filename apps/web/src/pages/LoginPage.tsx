import { formatTime } from "../i18n/format.js";
import { t, useLocale } from "../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import ForgetLocalKeysPrompt from "../components/app/ForgetLocalKeysPrompt.js";
import ForgetLocalKeysDialog from "../components/app/ForgetLocalKeysDialog.js";
import { PASSKEY_OPTIONS_REFRESH_MS, useLoginFlow } from "../features/auth/useLoginFlow.js";
import { Button, Field, Icon, IconButton, Input, ListItem, Notice, Spinner, Textarea } from "../ui/index.js";

import { AuthHeading } from "../features/auth/AuthHeading.js";
import { DeviceSetup } from "../features/auth/DeviceSetup.js";
import { NativeHandoffWait } from "../features/auth/NativeHandoffWait.js";
import { ReplaceDevice } from "../features/auth/ReplaceDevice.js";

export default function LoginPage() {
  useLocale();
  const flow = useLoginFlow();
  const [showPassword, setShowPassword] = useState(false);
  const {
    recoveryRetry, capabilities, username, setUsername, password, setPassword,
    recoveryKey, setRecoveryKey, error, loading, pendingLink, blockedOwner,
    linkCompleting, usernameInput, handleSubmit,
    forgetLocalKeys, signInAsOwner, cancelLink,
    passkeyPasswordRequired,
    step, setupMethod, useRecoveryKey, approveFromAnotherDevice, backToSignIn, retryLink,
  } = flow;

  const [selection, setSelection] = useState<string | null>(null);
  const [earlyTap, setEarlyTap] = useState(false);
  const passkeyButton = useRef<HTMLButtonElement>(null);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const passkeyEntryVisible = flow.passkeysSupported && flow.entryState !== "unavailable" && !recoveryRetry && !pendingLink && step === "sign-in" &&
    !flow.setupScreen && !passkeyPasswordRequired && !flow.savedPasskeySetupId && !flow.nativeStage && !flow.nativeRestarting && !flow.revokedVault &&
    !flow.passkeyDeviceLimit && blockedOwner === undefined;
  useEffect(() => {
    if (!passkeyEntryVisible) return;
    const prepare = () => { if (flowRef.current.entryState !== "moved") void flowRef.current.preparePasskeyEntry(); };
    const idle = window.requestIdleCallback?.(prepare, { timeout: 700 });
    if (idle === undefined) prepare();
    const offline = () => flowRef.current.markPasskeyOffline();
    const refresh = () => void flowRef.current.preparePasskeyEntry(true);
    const timer = window.setInterval(refresh, PASSKEY_OPTIONS_REFRESH_MS);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", offline);
    return () => {
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
      clearInterval(timer);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", offline);
    };
  }, [passkeyEntryVisible]);
  useEffect(() => {
    if (passkeyEntryVisible && flow.entryState === "ready" && !flow.passkeyGesture && !earlyTap) return flowRef.current.startPasskeyAutofill();
  }, [passkeyEntryVisible, flow.entryState, flow.passkeyGesture, earlyTap]);
  useEffect(() => { if (flow.passkeyGesture) passkeyButton.current?.focus(); }, [flow.passkeyGesture]);
  const usingReplace = !!flow.passkeyDeviceLimit;
  const usingSetup = !!(flow.setupScreen || passkeyPasswordRequired || flow.savedPasskeySetupId);
  const preparationNotice = flow.entryState === "offline" || flow.entryState === "failed";
  const setupInOtherTab = flow.entryState === "other-tab";

  if (blockedOwner !== undefined) {
    return <ForgetLocalKeysPrompt owner={blockedOwner} sameAccount={!!blockedOwner && blockedOwner.username === username}
      error={error} loading={loading} onSignInInstead={signInAsOwner} onForget={forgetLocalKeys} />;
  }

  return (
    <main className="h-dvh overflow-y-auto bg-canvas text-ink px-safe pt-safe pb-safe">
      <div className="flex min-h-full flex-col items-center px-4 py-7 sm:justify-center">
        <section className={`flex min-h-[calc(100dvh-3.5rem)] w-full ${usingReplace ? "max-w-[30rem]" : "max-w-[26rem]"} flex-col gap-4 sm:min-h-0 sm:rounded-card sm:border sm:border-line sm:bg-surface sm:p-8 sm:shadow-raised`}>
          <img src="/brand/icon-rounded.svg" alt="Private Base" className="size-14 rounded-card" />
          {flow.nativeStage || flow.nativeRestarting ? <NativeHandoffWait stage={flow.nativeStage ?? "browser"} error={error}
            canRetry={!loading} restarting={flow.nativeRestarting}
            restart={() => void flow.cancelNativeHandoff(true)} cancel={() => void flow.cancelNativeHandoff()}
            retry={() => void flow.retryPasskeySetup()} />
            : usingReplace ? <ReplaceDevice flow={flow} selectedId={selection} select={setSelection} />
            : usingSetup ? <DeviceSetup flow={flow} />
            : pendingLink ? (
            <>
              <AuthHeading title={pendingLink.mode === "recovery" ? t("finishingRecovery") : flow.passkeyApproval ? t("passkeySetup.approvalTitle") : t("approveNewDevice")} />
              <p className="text-ink-muted">{pendingLink.mode === "recovery"
                ? t("yourRecoveryWasAcceptedButThisDeviceCould")
                : t(flow.passkeyApproval ? "passkeySetup.approvalBody" : "openTheLinkedDevicesScreenOnAnAlready")}</p>
              {pendingLink.mode !== "recovery" && <div className="secret-text rounded-control bg-sunken p-4 text-center text-[1.75rem] font-semibold" aria-label={t("deviceLinkVerificationCodeLabel")}>{pendingLink.shortCode?.match(/.{1,3}/g)?.join(" ") ?? t("waitingForCode")}</div>}
              <p className="text-sm text-ink-muted">{t("expires", { deviceName: pendingLink.deviceName, value: formatTime(pendingLink.expiresAt) })}</p>
              {!flow.linkAtDeviceLimit && <div role="status" className="flex items-center gap-2 text-sm text-ink-muted"><Spinner label={null} /><span>{pendingLink.mode === "recovery" ? t("stillWorking") : t("waitingForApproval2")}</span></div>}
              {error && <Notice tone="danger" action={<Button size="sm" variant="secondary" disabled={linkCompleting} onClick={retryLink}>{t("retry")}</Button>}>{error}</Notice>}
              {flow.passkeyApproval && <Button variant="ghost" onClick={() => { void Promise.resolve(cancelLink()).then(useRecoveryKey); }}>{t("passkeySetup.useRecoveryInstead")}</Button>}
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
              <AuthHeading title={recoveryRetry ? t("finishRecovery") : t("signInHeading")} focus={false} />
              {error && <Notice
                tone={error === t("passkeySetup.errorNotFinished") || error === t("passkeySetup.handoffCancelled") ? "info" : "danger"}
                action={error === t("passkeySetup.browserTimeout") || error === t("passkeySetup.browserTimeoutStart")
                  ? <Button variant="secondary" onClick={() => void flow.handlePasskeyEntry()}>{t("retry")}</Button> : undefined}>
                {error}
              </Notice>}
              {flow.interrupted && !error && <Notice tone="info">{t(capabilities.nativePasskeys ? "passkeySetup.handoffInterrupted" : "passkeySetup.errorInterrupted")}</Notice>}
              {passkeyEntryVisible && (setupInOtherTab || flow.entryState === "moved") && <Notice tone="info"
                action={setupInOtherTab ? <Button variant="secondary" onClick={flow.requestSetupTakeover}>{t("passkeySetup.useThisTab")}</Button> : undefined}>
                {t(setupInOtherTab ? "passkeySetup.setupOtherTab" : "passkeySetup.setupMoved")}
              </Notice>}
              {preparationNotice && passkeyEntryVisible && <Notice tone={flow.entryState === "offline" ? "warning" : "danger"}
                action={<Button variant="secondary" onClick={() => void flow.preparePasskeyEntry(true)}>{t("retry")}</Button>}>
                {t(flow.entryState === "offline" ? "passkeySetup.errorOffline" : "passkeySetup.errorPrepare")}
              </Notice>}
              {flow.revokedVault && <Notice tone="warning" action={<Button variant="secondary" disabled={loading}
                onClick={() => flow.setConfirmForgetRevokedVault(true)}>{t("forgetThisDevice")}</Button>}>
                {t("deviceAlert.sessionEnded")}
              </Notice>}
              <ForgetLocalKeysDialog open={flow.confirmForgetRevokedVault} error={error} loading={loading}
                onCancel={() => flow.setConfirmForgetRevokedVault(false)} onForget={flow.forgetRevokedPasskeyVault} />
              {passkeyEntryVisible && <>
                <Button ref={passkeyButton} size="lg" leadingIcon="passkey" disabled={preparationNotice || setupInOtherTab} loading={loading || earlyTap}
                  onClick={() => {
                    if (loading || earlyTap) return;
                    setEarlyTap(true);
                    void flow.handlePasskeyEntry().finally(() => setEarlyTap(false));
                  }}>{t(flow.passkeyGesture ? "passkeySetup.browserContinue" : "passkeySetup.signInWithPasskey")}</Button>
                {earlyTap && (flow.entryState === "preparing" || capabilities.nativePasskeys) && <span role="status" className="text-sm text-ink-muted">
                  {t(capabilities.nativePasskeys ? "passkeySetup.preparing" : "passkeySetup.preparingSignIn")}
                </span>}
                {flow.passkeyGesture && <span role="status" className="sr-only">{t("passkeySetup.browserContinue")}</span>}
                <p className="text-sm text-ink-muted">{t("passkeySetup.passkeyHelp")}</p>
                <div className="flex items-center gap-3 text-xs text-ink-subtle"><span className="h-px flex-1 bg-line" />{t("passkeySetup.orUsePassword")}<span className="h-px flex-1 bg-line" /></div>
              </>}
              {recoveryRetry && <p className="text-ink-muted">{t("enterYourPasswordToUnlockThisDeviceS")}</p>}
              <form onSubmit={handleSubmit}>
                <fieldset disabled={loading || (earlyTap && flow.entryState !== "preparing")} className="flex flex-col gap-4">
                <Field label={t("username")}>
                  <Input ref={usernameInput} placeholder={t("username")} value={username} readOnly={!!recoveryRetry} onChange={(e) => setUsername(e.target.value)} required autoComplete={passkeyEntryVisible && capabilities.passkeys ? "username webauthn" : "username"} autoCapitalize="none" spellCheck={false} leading={<Icon name="user" size={18} />} />
                </Field>
                <Field label={t("password")}>
                  <Input type={showPassword ? "text" : "password"} placeholder={t("password")} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" trailing={<IconButton icon={showPassword ? "eye-off" : "eye"} label={showPassword ? t("hidePassword") : t("showPassword")} size="sm" onClick={() => setShowPassword(!showPassword)} />} />
                </Field>
                <Button type="submit" variant={passkeyEntryVisible ? "secondary" : "primary"} loading={loading}>{recoveryRetry ? t("finishRecovery") : t("signInAction")}</Button>
                </fieldset>
              </form>
              <p className="text-center text-sm text-ink-muted">{t("newHere")} <Link to="/register" className="inline-flex min-h-11 items-center font-semibold text-brand hover:underline">{t("createAnAccount")}</Link></p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
