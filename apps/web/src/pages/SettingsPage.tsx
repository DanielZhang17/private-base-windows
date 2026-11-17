import { AboutUpdates } from "../features/updates/AboutUpdates.js";
import { localized, type LocalizedMessage } from "../i18n/messages.js";
import { LOCALES, type LocalePreference } from "../i18n/index.js";
import { formatDate } from "../i18n/format.js";
import { translateError } from "../features/shared/errors.js";
import { t, useLocale } from "../i18n/index.js";
import { AvatarPicker } from "../features/settings/AvatarPicker.js";
import { RecoveryKeyDialog } from "../features/settings/RecoveryKeyDialog.js";
import { SETTINGS_SECTIONS, SettingsFrame } from "../features/settings/SettingsFrame.js";
import { useSettings } from "../features/settings/useSettings.js";
import { Avatar, Badge, Button, ConfirmDialog, Dialog, Field, Select, Icon, IconButton, Input, ListItem, Notice, Spinner, TopBar, useToast } from "../ui/index.js";

function ColorField({ label, value, normalized, error, onChange }: { label: string; value: string; normalized: string; error?: string | null; onChange: (value: string) => void }) {
  const { locale } = useLocale();
  return <Field label={label} error={error}>
    <div className="flex items-center gap-3">
      <input
        type="color"
        aria-label={t("pickColour", { value: locale === "en" ? label.toLowerCase() : label })}
        className="size-11 shrink-0 cursor-pointer rounded-control border border-line bg-surface p-1"
        value={normalized}
        onChange={(event) => onChange(event.target.value)}
      />
      <Input
        aria-label={t("hexColour", { label: label })}
        value={value}
        placeholder="#14586e"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  </Field>;
}

function SettingsView({ s }: { s: ReturnType<typeof useSettings> }) {
  const locale = useLocale();
  const toast = useToast();
  function success(message: LocalizedMessage) { toast.show({ tone: "success", message }); }
  async function copyUsername() { try { await s.copyUsername(); success(localized("usernameCopied")); } catch { toast.show({ tone: "danger", message: localized("couldNotCopyUsername") }); } }
  const title = t(SETTINGS_SECTIONS.find(([key]) => key === s.section)?.[1] ?? "settings");
  return <>

    <TopBar
      title={title}
      onBack={s.closeSection}
      backOnPhoneOnly
    />

    <div className="min-h-0 grow overflow-y-auto pb-safe">
      <div className="mx-auto max-w-2xl space-y-7 p-4 sm:p-6">

        {s.section === "notifications" && s.webPush?.visible && <>
          {s.webPush.supported && <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input type="checkbox" role="switch" className="toggle" checked={s.webPush.enabled}
              disabled={s.webPush.busy} onChange={(event) => { void s.webPush.toggle(event.target.checked); }} />
            {t("webPush.allowClosed")}
          </label>}
          <p className="text-sm text-ink-muted">{t("webPush.privacy")}</p>
          {s.webPush.iosHint && <Notice tone="info">{t("webPush.iosHint")}</Notice>}
          {s.webPush.error && <Notice tone="danger">{t("webPush.error")}</Notice>}
        </>}

        {s.section === "notifications" && s.background.supported && <>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input type="checkbox" role="switch" className="toggle" checked={s.background.enabled}
              disabled={s.background.busy} onChange={(event) => { void s.background.setEnabled(event.target.checked); }} />
            {t("androidBackground.stayConnected")}
          </label>
          <p className="text-sm text-ink-muted">{t("androidBackground.battery")}</p>
          {s.background.error && <Notice tone="danger">{t("androidBackground.permission")}</Notice>}
          {s.background.enabled && s.background.status && !s.background.status.batteryExempt &&
            <Notice tone="warning">{t("androidBackground.doze")}</Notice>}
          {s.background.enabled && <Button variant="secondary" onClick={() => { void s.background.openSettings("battery"); }}>
            {t("androidBackground.batterySettings")}
          </Button>}
          {s.background.status && !s.background.status.fullScreen && <>
            <Notice tone="warning">{t("androidBackground.fullScreenFallback")}</Notice>
            <Button variant="secondary" onClick={() => { void s.background.openSettings("fullScreen"); }}>
              {t("androidBackground.fullScreenSettings")}
            </Button>
          </>}
        </>}

        {s.section === "about" && <AboutUpdates />}

        {s.section === "profile" && <>

          {s.profileError && <Notice tone="danger">
            {s.profileError}
          </Notice>}

          <div className="relative mx-auto w-fit">
            <Avatar
              name={s.user?.displayName ?? t("selfAvatarFallback")}
              src={s.avatarSrc}
              size="xl"
            />
            <IconButton
              icon="camera"
              label={t("changePicture")}
              variant="secondary"
              disabled={s.savingAvatar}
              className="absolute -end-2 bottom-0 rounded-full"
              onClick={() => s.setShowAvatarPicker(!s.showAvatarPicker)}
            />
          </div>

          {s.showAvatarPicker && <AvatarPicker value={s.user?.avatarUrl ?? null} onChange={(value) => { void s.handleAvatarChange(value).then((saved) => { if (saved) success(localized("profileSaved")); }); }} />}

          <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void s.handleSaveProfile().then((saved) => { if (saved) success(localized("profileSaved")); }); }}>

            <Field label={t("displayNameLabel")} required>
              <Input
                placeholder={t("displayNamePlaceholder")}
                maxLength={64}
                value={s.displayName}
                onChange={(event) => s.setDisplayName(event.target.value)}
              />
            </Field>

            <Field label={t("username")}>
              <Input
                value={`@${s.user?.username ?? ""}`}
                readOnly
                trailing={<IconButton
                  icon="copy"
                  label={t("copyUsername")}
                  onClick={() => void copyUsername()}
                />}
              />
            </Field>

            {s.profileChanged && <Button type="submit" loading={s.savingProfile}>{t("saveProfile")}</Button>}

          </form>

        </>}

        {s.section === "attachments" && <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
          <input type="checkbox" className="size-5 shrink-0 accent-[var(--primary)]" checked={s.compressAttachments}
            onChange={(event) => s.setCompressAttachments(event.target.checked)} />
          {t("compressAttachmentsByDefault")}
        </label>}

        {s.section === "privacy" && <>
          {s.privacy.loading && <Spinner label={t("loadingStatus")} />}
          {s.privacy.error && <Notice tone="danger">{s.privacy.error}
            <Button variant="ghost" onClick={s.privacy.retry}>{t("retry")}</Button>
          </Notice>}
          <section className="space-y-3">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <input type="checkbox" role="switch" className="toggle" checked={s.privacy.data?.discoverable === false}
                disabled={s.privacy.disabled} aria-describedby="hide-me-help"
                onChange={(event) => { void s.privacy.save({ discoverable: !event.target.checked }).then(saved => { if (saved) success(localized("privacySaved")); }); }} />
              {t("hideMe")}
            </label>
            <p id="hide-me-help" className="text-sm text-ink-muted">{t("hideMeHelp")}</p>
          </section>
          <Field label={t("groupInvitesLabel")}>
            <Select value={s.privacy.data?.groupInvites ?? "everyone"} disabled={s.privacy.disabled}
              onChange={(event) => { void s.privacy.save({ groupInvites: event.target.value as "everyone" | "contacts" | "nobody" }).then(saved => { if (saved) success(localized("privacySaved")); }); }}>
              <option value="everyone">{t("groupInvitesEveryone")}</option>
              <option value="contacts">{t("groupInvitesContacts")}</option>
              <option value="nobody">{t("groupInvitesNobody")}</option>
            </Select>
          </Field>
          {s.privacy.capture.capability && <section className="space-y-3 border-t border-line pt-6">
            {s.privacy.capture.enabled !== undefined && <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <input type="checkbox" role="switch" className="toggle" checked={s.privacy.capture.enabled}
                disabled={s.privacy.capture.busy} aria-describedby="capture-protection-help"
                onChange={(event) => { void s.privacy.capture.setEnabled(event.target.checked); }} />
              {t("captureProtectionLabel")}
            </label>}
            <p id="capture-protection-help" className="text-sm text-ink-muted">{t(s.privacy.capture.capability === "full" ? "captureProtectionFull" : s.privacy.capture.capability === "recording" ? "captureProtectionRecording" : "captureProtectionBestEffort")}</p>
            {s.privacy.capture.error && <Notice tone="danger">{s.privacy.capture.error}
              {s.privacy.capture.enabled === undefined && <Button variant="ghost" onClick={s.privacy.capture.retry}>{t("retry")}</Button>}
            </Notice>}
          </section>}
        </>}

        {s.section === "appearance" && <>
          <Field label={t("language")}>
            <Select className="select w-full min-w-0 bg-surface text-ink" value={locale.preference} onChange={(event) => { void locale.setPreference(event.target.value as LocalePreference); }}>
              <option value="system">{t("systemDefault", { language: locale.systemLabel })}</option>
              {LOCALES.map(({ code, label }) => <option key={code} value={code}>{label}</option>)}
            </Select>
          </Field>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t("theme")}</h2>
            <div className="flex rounded-control bg-sunken p-1">
              {([['light', t("themeLight"), 'sun'], ['dark', t("themeDark"), 'moon'], ['system', t("themeSystem"), 'monitor']] as const).map(([mode, label, icon]) => <Button
                key={mode}
                leadingIcon={icon}
                variant={s.appearanceDraft.themeMode === mode ? "secondary" : "ghost"}
                className="min-w-0 flex-1 px-2"
                aria-pressed={s.appearanceDraft.themeMode === mode}
                onClick={() => { s.handleThemeChange(mode); success(localized("themeSaved")); }}
              >
                {label}
              </Button>)}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold">{t("messageColours")}</h2>
            <p className="text-sm text-ink-muted">{t("savedOnlyOnThisBrowserAndDevice")}</p>

            <ColorField
              label={t("myMessages")}
              value={s.appearanceDraft.outgoingMessageColor}
              normalized={s.colorInputValue(s.appearanceDraft.outgoingMessageColor)}
              error={s.appearanceValidation.errors.outgoing}
              onChange={(value) => s.setAppearanceDraft((current) => ({ ...current, outgoingMessageColor: value }))}
            />

            <ColorField
              label={t("theirMessages")}
              value={s.appearanceDraft.incomingMessageColor}
              normalized={s.colorInputValue(s.appearanceDraft.incomingMessageColor)}
              error={s.appearanceValidation.errors.incoming}
              onChange={(value) => s.setAppearanceDraft((current) => ({ ...current, incomingMessageColor: value }))}
            />

            <ColorField
              label={t("sendButton")}
              value={s.appearanceDraft.sendButtonColor}
              normalized={s.colorInputValue(s.appearanceDraft.sendButtonColor)}
              error={s.appearanceValidation.errors.send}
              onChange={(value) => s.setAppearanceDraft((current) => ({ ...current, sendButtonColor: value }))}
            />

          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t("appearancePreviewHeading")}</h2>
            <div data-theme={s.previewTheme} className="space-y-3 rounded-card border border-line bg-canvas p-4">

              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-bubble rounded-bl-bubble-tail px-3 py-2 text-sm" style={{ backgroundColor: s.previewBubbleIncoming, color: s.previewIncomingText }}>{t("areWeStillOnForTomorrow")}</div>
              </div>

              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-bubble rounded-br-bubble-tail px-3 py-2 text-sm" style={{ backgroundColor: s.previewBubbleOutgoing, color: s.previewOutgoingText }}>{t("yesNineAtTheHarbour")}</div>
              </div>

              <div className="flex justify-end">
                <Button leadingIcon="send" style={{ backgroundColor: s.previewSend, color: s.previewSendText }}>{t("sendMessageAction")}</Button>
              </div>

            </div>
            <p className="text-xs text-ink-muted">{t("textColourIsPickedAutomaticallySoEveryBubble")}</p>
            <p className="text-xs text-ink-muted">{t("textContrastMyMessages1TheirMessages1", { outgoing: s.previewRatios.outgoing, incoming: s.previewRatios.incoming, send: s.previewRatios.send })}</p>

            {s.incomingEdgeWarning && <Notice tone="warning">{t("theirMessageColourIsCloseToTheBackground")}</Notice>}

          </section>

          {s.appearanceError && <Notice tone="danger">
            {s.appearanceError}
          </Notice>}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => { s.handleResetAppearance(); success(localized("appearanceReset")); }}>{t("resetToDefaults")}</Button>
            <Button onClick={() => { if (s.handleSaveAppearance()) success(localized("appearanceSaved")); }}>{t("saveAppearance")}</Button>
          </div>

        </>}

        {s.section === "security" && <>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t("deviceSecurity")}</h2>
            <p className="text-sm text-ink-muted">{t("yourPrivateKeysStayEncryptedOnThisDevice")}</p>
            <Button variant="secondary" onClick={s.handleLockNow}>{t("lockNow")}</Button>
          </section>

          <section className="space-y-4 border-t border-line pt-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">{t("recoveryKey")}</h2>
              <Badge tone={s.hasRecoveryKey ? "success" : "neutral"}>
                {s.hasRecoveryKey ? t("recoveryKeyEnrolledStatus") : t("notSetUp")}
              </Badge>
            </div>
            <p className="text-sm text-ink-muted">{t("keepItSomewhereSafeOfflineAndPrivateYou")}</p>
            {s.recoveryError && <Notice tone="danger">
              {s.recoveryError}
            </Notice>}
            {!s.hasRecoveryKey && <Button
              variant="secondary"
              leadingIcon="key"
              loading={s.enrollingRecovery}
              onClick={() => void s.handleEnrollRecoveryKey()}
            >{t("createRecoveryKey")}</Button>}
          </section>

          {(s.capabilities.passkeys || s.capabilities.nativePasskeys) && <section className="space-y-4 border-t border-line pt-6">
            <h2 className="font-semibold">{t("passkeys")}</h2>
            <p className="text-sm text-ink-muted">{t("signInWithYourDeviceLockBiometricsOr")}</p>
            {s.passkeyError && <Notice tone="danger">
              {s.passkeyError}
            </Notice>}
            {s.passkeysQuery.error && <Notice tone="danger">
              {translateError(s.passkeysQuery.error)}
            </Notice>}

            {s.passkeysQuery.isLoading ? <Spinner label={t("loadingPasskeys")} /> : <ul role="list">
              {(s.passkeysQuery.data ?? []).map((passkey) => <li key={passkey.id}>
                <ListItem
                  leading={<Icon name="passkey" />}
                  title={passkey.friendlyName}
                  subtitle={t("passkeyAddedDate", { value: formatDate(passkey.createdAt) })}
                  trailing={<IconButton
                    icon="trash"
                    variant="danger-ghost"
                    label={t("removePasskeyNamed", { friendlyName: passkey.friendlyName })}
                    onClick={() => s.requestDeletePasskey(passkey.id, passkey.friendlyName)}
                  />}
                />
              </li>)}
            </ul>}

            {!s.passkeysQuery.isLoading && s.passkeysQuery.data?.length === 0 && <p className="text-sm text-ink-muted">{t("noPasskeysRegisteredYet")}</p>}

            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void s.handleRegisterPasskey().then((saved) => { if (saved) success(localized("passkeyAdded")); }); }}>
              <Field label={t("passkeyName")}>
                <Input
                  value={s.passkeyName}
                  maxLength={64}
                  placeholder={t("passkeyNameEGMacbookTouchId")}
                  onChange={(event) => s.setPasskeyName(event.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="secondary"
                leadingIcon="plus"
                loading={s.registeringPasskey}
                disabled={s.preparingPasskey}
              >{t("addAPasskey")}</Button>
            </form>

          </section>}

          <section className="border-t border-line pt-6">
            <Button variant="danger-ghost" onClick={() => s.setShowForgetKeys(true)}>{t("forgetKeysOnThisDevice")}</Button>
          </section>

        </>}

        {s.section === "emoji" && <>

          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-ink-muted">{t("yourOwnImagesReadyToUseInAny")}</p>
            <Button leadingIcon="plus" onClick={() => s.setShowAddEmoji(true)}>{t("addEmoji")}</Button>
          </div>

          {s.emojiError && <Notice tone="danger">
            {s.emojiError}
          </Notice>}
          {s.customEmojisQuery.error && <Notice tone="danger">
            {translateError(s.customEmojisQuery.error)}
          </Notice>}

          {s.customEmojisQuery.isLoading ? <Spinner label={t("loadingCustomEmoji")} /> : s.customEmojis.length === 0 ? <p className="text-sm text-ink-muted">{t("noCustomEmojiUploadedYet")}</p> : <ul role="list" className="grid gap-3 xl:grid-cols-2">
            {s.customEmojis.map((emoji) => <li key={emoji.id} className="space-y-3 rounded-card border border-line p-3">
              <div className="flex items-center gap-3">
                <img
                  src={emoji.src}
                  alt={`:${emoji.shortcode}:`}
                  className="size-11 object-contain"
                />
                <Field label={t("shortcodeFor", { shortcode: emoji.shortcode })}>
                  <Input value={s.emojiDrafts[emoji.id] ?? emoji.shortcode} onChange={(event) => s.setEmojiDrafts((current) => ({ ...current, [emoji.id]: event.target.value }))} />
                </Field>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  disabled={s.emojiBusyId === emoji.id}
                  onClick={() => void s.handleRenameEmoji(emoji.id).then((saved) => { if (saved) success(localized("emojiRenamed")); })}
                >{t("rename")}</Button>
                <IconButton
                  icon="trash"
                  label={t("deleteEmojiNamedAction", { shortcode: emoji.shortcode })}
                  variant="danger-ghost"
                  onClick={() => s.requestDeleteEmoji(emoji.id, emoji.shortcode)}
                />
              </div>
            </li>)}
          </ul>}

        </>}

        {s.section === "account" && <>

          <section className="space-y-3">
            <h2 className="font-semibold">{t("signedInAs", { username: s.user?.username })}</h2>
            <p className="text-sm text-ink-muted">{t("yourKeysStayOnThisDeviceLockedWith")}</p>
            <Button
              variant="secondary"
              leadingIcon="logout"
              onClick={() => s.setShowSignOut(true)}
            >{t("signOut")}</Button>
          </section>

          <section className="space-y-3 border-t border-line pt-6">
            <h2 className="font-semibold">{t("deleteAccount")}</h2>
            <p className="text-sm text-ink-muted">{t("permanentlyDeleteYourAccountAndRevokeEveryLinked")}</p>
            <Button
              variant="danger-ghost"
              leadingIcon="trash"
              onClick={() => s.setShowDeleteAccount(true)}
            >{t("deleteAccount2")}</Button>
          </section>

        </>}

      </div>
    </div>

    <RecoveryKeyDialog
      recoveryKey={s.generatedRecoveryKey}
      onContinue={s.dismissRecoveryKey}
      onCopy={s.copyRecoveryKey}
      onSave={s.saveRecoveryKey}
      canSave={s.canSaveRecoveryKey}
    />

    <ConfirmDialog
      open={!!s.confirmation}
      title={s.confirmation?.kind === "passkey" ? t("removeThisPasskey") : t("deleteEmojiConfirmTitle", { name: s.confirmation?.name })}
      description={s.confirmation?.kind === "passkey" ? t("youCanAddItAgainLater") : t("olderMessagesWillStillShowIt")}
      confirmLabel={s.confirmation?.kind === "passkey" ? t("removePasskey") : t("deleteEmoji")}
      tone="danger"
      busy={!!s.deletingPasskeyId || !!s.emojiBusyId}
      error={s.confirmation?.kind === "passkey" ? s.passkeyError : s.emojiError}
      onCancel={s.closeConfirmation}
      onConfirm={() => { if (s.confirmation?.kind === "passkey") void s.handleDeletePasskey(s.confirmation.id).then((saved) => { if (saved) success(localized("passkeyRemoved")); }); else if (s.confirmation) void s.handleDeleteEmoji(s.confirmation.id).then((saved) => { if (saved) success(localized("emojiDeleted")); }); }}
    />

    <ConfirmDialog
      open={s.showSignOut}
      title={t("signOut2")}
      description={t("yourKeysStayOnThisDeviceLockedWith")}
      confirmLabel={t("signOut3")}
      onCancel={() => s.setShowSignOut(false)}
      onConfirm={s.handleLogout}
    />

    <ConfirmDialog
      open={s.showForgetKeys}
      title={t("forgetKeysOnThisDevice2")}
      description={t("messageHistoryOnThisDeviceWillBeLost")}
      confirmLabel={t("forgetKeys")}
      acknowledgeLabel={t("iUnderstandThisCannotBeUndone")}
      tone="danger"
      busy={s.forgettingKeys}
      error={s.forgetError}
      onCancel={() => s.setShowForgetKeys(false)}
      onConfirm={() => void s.handleForgetKeys()}
    />

    <ConfirmDialog
      open={s.showDeleteAccount}
      title={t("deleteYourAccount")}
      description={t("yourAccountAllLinkedDevicesAndYourMessages")}
      confirmLabel={t("deleteAccount")}
      acknowledgeLabel={t("iUnderstandThisCannotBeUndone")}
      tone="danger"
      busy={s.deletingAccount}
      error={s.dangerError}
      onCancel={() => s.setShowDeleteAccount(false)}
      onConfirm={() => void s.handleDeleteAccount()}
    >

      <Field label={t("currentPassword")} required>
        <Input
          type="password"
          placeholder={t("password")}
          autoComplete="current-password"
          value={s.deletePassword}
          onChange={(event) => s.setDeletePassword(event.target.value)}
        />
      </Field>

      <Field label={t("typeDeleteToConfirm")} required>
        <Input value={s.deleteConfirmation} onChange={(event) => s.setDeleteConfirmation(event.target.value)} />
      </Field>

    </ConfirmDialog>

    <Dialog
      open={s.showAddEmoji}
      onClose={s.closeAddEmoji}
      title={t("addEmoji")}
      footer={<>
        <Button
          variant="secondary"
          disabled={s.uploadingEmoji}
          onClick={s.closeAddEmoji}
        >{t("cancel")}</Button>
        <Button loading={s.uploadingEmoji} onClick={() => void s.handleUploadEmoji().then((saved) => { if (saved) success(localized("emojiAdded")); })}>{t("uploadEmojiAction")}</Button>
      </>}
    >

      <div className="space-y-4">
        {s.emojiError && <Notice tone="danger">
          {s.emojiError}
        </Notice>}
        <Field label={t("emojiShortcodeLabel")}>
          <Input
            placeholder={t("emojiShortcodePlaceholder")}
            value={s.emojiShortcode}
            onChange={(event) => s.setEmojiShortcode(event.target.value)}
          />
        </Field>
        <Field label={t("imageTypeLabel")} help={t("pngOrWebp")}>
          <Input
            type="file"
            accept="image/png,image/webp"
            onChange={(event) => s.setEmojiFile(event.target.files?.[0] ?? null)}
          />
        </Field>
      </div>

    </Dialog>

  </>;
}
export default function SettingsPage() {
  useLocale();
  const settings = useSettings();
  return <SettingsFrame
    onSignOut={settings.handleLogout}
    title={t("settings")}
    section={settings.selectedSection ?? undefined}
    detailActive={!!settings.selectedSection}
    detail={<SettingsView s={settings} />}
  />;
}
