import { localized } from "../i18n/messages.js";
import { t, useLocale } from "../i18n/index.js";
import { useState } from "react";
import { Link } from "react-router-dom";
import AvatarPicker from "../components/avatar/AvatarPicker.js";
import ForgetLocalKeysPrompt from "../components/app/ForgetLocalKeysPrompt.js";
import { useRegisterFlow } from "../features/auth/useRegisterFlow.js";
import { Avatar, Button, Field, IconButton, Input, Notice, ToastProvider, useToast } from "../ui/index.js";

export default function RegisterPage() {
  return <ToastProvider><RegisterView /></ToastProvider>;
}

function RegisterView() {
  useLocale();
  const {
    copyRecoveryKey, saveRecoveryKey, capabilities, username, setUsername, displayName,
    setDisplayName, password, setPassword, confirmPassword, setConfirmPassword,
    avatarUrl, avatarSrc, showAvatarPicker, setShowAvatarPicker, avatarFile,
    chooseAvatar, chooseAvatarFile, discardAvatar, uploadAvatar, avatarUploading, avatarUploadError,
    error, loading, generatedRecoveryKey, uploadWarning, blockedOwner, navigate,
    handleSubmit, forgetLocalKeys,
  } = useRegisterFlow();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);

  const copy = async () => {
    try {
      await copyRecoveryKey();
      toast.show({ tone: "success", message: localized("recoveryKeyCopied") });
    } catch {
      toast.show({ tone: "danger", message: localized("couldNotCopyRecoveryKeyTryAgain"), action: { label: localized("retry"), onClick: () => void copy() } });
    }
  };
  const save = async () => {
    try { await saveRecoveryKey(); }
    catch { toast.show({ tone: "danger", message: localized("couldNotSaveRecoveryKeyTryAgain"), action: { label: localized("retry"), onClick: () => void save() } }); }
  };

  if (blockedOwner !== undefined) {
    return <ForgetLocalKeysPrompt owner={blockedOwner} error={error} loading={loading}
      onSignInInstead={() => navigate("/login", { state: { username: blockedOwner?.username ?? "" } })} onForget={forgetLocalKeys} />;
  }

  return (
    <main className="h-dvh overflow-y-auto bg-canvas text-ink px-safe pt-safe pb-safe">
      <div className="flex min-h-full flex-col items-center px-4 py-7 sm:justify-center">
        <section className="flex w-full max-w-[26rem] flex-col gap-4 sm:rounded-card sm:border sm:border-line sm:bg-surface sm:p-8 sm:shadow-raised">
          <img src="/brand/icon-rounded.svg" alt="Private Base" className="size-12 rounded-card" />
          {generatedRecoveryKey ? (
            <>
              <h1 className="text-[1.375rem] leading-tight font-semibold tracking-tight">{t("saveYourRecoveryKey")}</h1>
              <p className="text-ink-muted">{t("thisKeyIsTheOnlyWayBackInto")}</p>
              {error && <Notice tone="warning">{error}</Notice>}
              {uploadWarning && <Notice tone="warning">{t("yourDeviceKeysWillFinishUploadingAutomatically")}</Notice>}
              {avatarUploadError && <Notice tone="warning">
                <div className="flex flex-wrap items-center gap-2">
                  <span>{avatarUploadError}</span>
                  <Button variant="secondary" size="sm" onClick={uploadAvatar}>{t("retry")}</Button>
                </div>
              </Notice>}
              {avatarUploading && <p role="status" className="text-sm text-ink-muted">{t("uploadingImage")}</p>}
              <div className="mockup-code rounded-control !bg-sunken !p-4 !text-ink before:hidden">
                <code data-testid="recovery-key" className="secret-text block text-lg font-semibold">{generatedRecoveryKey.match(/.{1,5}/g)?.map((group, i) => <span className="inline-block" key={i}>{group}</span>)}</code>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" leadingIcon="copy" onClick={() => void copy()}>{t("copy")}</Button>
                {capabilities.saveFile && <Button variant="secondary" size="sm" leadingIcon="download" onClick={() => void save()}>{t("saveAsFile")}</Button>}
              </div>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm">
                <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" />
                <span>{t("iHaveSavedMyRecoveryKeySomewhereSafe")}</span>
              </label>
              <Button disabled={!saved || avatarUploading} onClick={() => navigate("/")}>{t("continue")}</Button>
            </>
          ) : (
            <>
              <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">{t("createAccount")}</h1>
              {error && error !== t("usernameTaken") && error !== t("passwordsDonTMatch") && <Notice tone="danger">{error}</Notice>}
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <Field label={t("username")} error={error === t("usernameTaken") ? error : undefined} help={t("332CharactersLettersNumbersUnderscoresAndHyphens")}>
                  <Input placeholder={t("username")} value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" autoCapitalize="none" spellCheck={false} />
                </Field>
                <Field label={t("displayNameLabel")}>
                  <Input placeholder={t("displayNamePlaceholder")} value={displayName} onChange={(e) => setDisplayName(e.target.value)} required autoComplete="name" />
                </Field>
                <Field label={t("password")} help={t("atLeast8CharactersALongerUniquePassword")}>
                  <Input type={showPassword ? "text" : "password"} placeholder={t("min8Characters")} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" trailing={<IconButton icon={showPassword ? "eye-off" : "eye"} label={showPassword ? t("hidePassword") : t("showPassword")} size="sm" onClick={() => setShowPassword(!showPassword)} />} />
                </Field>
                <Field label={t("confirmPasswordLabel")} error={error === t("passwordsDonTMatch") ? error : undefined}>
                  <Input type={showConfirmation ? "text" : "password"} placeholder={t("confirmPasswordPlaceholder")} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required autoComplete="new-password" trailing={<IconButton icon={showConfirmation ? "eye-off" : "eye"} label={showConfirmation ? t("hidePasswordConfirmation") : t("showPasswordConfirmation")} size="sm" onClick={() => setShowConfirmation(!showConfirmation)} />} />
                </Field>
                <div className="flex items-center gap-3">
                  <Avatar src={avatarSrc} name={displayName || username || t("yourAvatar")} size="lg" />
                  <Button variant="secondary" leadingIcon="camera" onClick={() => setShowAvatarPicker(!showAvatarPicker)} aria-expanded={showAvatarPicker}>{t("choosePicture")}</Button>
                  <span className="text-xs text-ink-muted">{t("optional")}</span>
                  {avatarFile && <Button variant="ghost" size="sm" onClick={discardAvatar}>{t("discard")}</Button>}
                </div>
                {showAvatarPicker && <AvatarPicker value={avatarUrl} onChange={chooseAvatar} onLocalFile={chooseAvatarFile} />}
                <Button type="submit" loading={loading}>{t("createAccount")}</Button>
              </form>
              <p className="text-center text-sm text-ink-muted">{t("alreadyHaveAnAccount")} <Link to="/login" className="inline-flex min-h-11 items-center font-semibold text-brand hover:underline">{t("signInAction")}</Link></p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
