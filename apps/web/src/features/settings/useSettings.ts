import { createPasskeyEnrollmentPayload } from "@e2ee-chat/shared";
import { localized, renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { t, useLocale } from "../../i18n/index.js";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CustomEmoji, PasskeyInfo, PasskeyRegistrationOptionsResponse } from "@e2ee-chat/shared";
import { api, resolveApiUrl } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useUiPreferencesStore } from "../../stores/uiPreferencesStore.js";

import { clearAll } from "../../db/index.js";
import { addAccountPasswordUnlock, bindAccountUnlockEnrollment } from "../../lib/passkey-provision.js";
import { signWithIdentityKey, isOnlyLocalPasskeyUnlock, localPasskeyUnlockId, listLocalUnlockMethods, enrollLocalUnlockMethod, removeLocalUnlockMethod, lockLocalCryptoState, resetLocalCryptoState } from "../../lib/key-manager.js";
import { generateRecoveryKey } from "../../lib/device-link.js";
import { addNativePasskey } from "../../lib/native-passkeys.js";
import { createPasskeyCredential, PasskeyUnsupportedError } from "../../lib/webauthn.js";
import { capabilities } from "../../platform/capabilities.js";
import { clearAccountScopedState } from "../../platform/session.js";
import { copyText } from "../../platform/clipboard.js";
import {
  getDefaultUiPreferences,
  getContrastRatio,
  getReadableTextColor,
  normalizeHexColor,
  resolveTheme,
  type UiPreferences,
  type ThemeMode,
} from "../../lib/ui-preferences.js";

import { saveFile } from "../../platform/files.js";
import { resolveAvatarImageUrl } from "./avatar.js";
import { SETTINGS_SECTIONS, type SettingsSection } from "./sections.js";
import { useBackgroundSettings } from "./useBackgroundSettings.js";
import { useWebPushSettings } from "./useWebPushSettings.js";
import { usePrivacySettings } from "./usePrivacySettings.js";
import { useSettingsBack } from "./useSettingsBack.js";

const PASSKEY_OPTIONS_MAX_AGE_MS = 4 * 60 * 1000;

interface CachedPasskeyRegistrationOptions {
  challengeId: string;
  options: PasskeyRegistrationOptionsResponse["options"];
  fetchedAt: number;
}

function buildInitialDraft(base: UiPreferences): UiPreferences {
  return {
    themeMode: base.themeMode,
    outgoingMessageColor: base.outgoingMessageColor,
    incomingMessageColor: base.incomingMessageColor,
    sendButtonColor: base.sendButtonColor,
  };
}

export function useSettings() {
  const { locale } = useLocale();
  const [searchParams] = useSearchParams();
  const closeSection = useSettingsBack();
  const sectionParam = searchParams.get("section");
  const background = useBackgroundSettings();
  const webPush = useWebPushSettings();
  const privacy = usePrivacySettings(sectionParam === "privacy");
  const selectedSection = SETTINGS_SECTIONS.some(([key]) => key === sectionParam) &&
    (sectionParam !== "notifications" || background.supported || webPush.visible) &&
    (sectionParam !== "about" || capabilities.autoUpdate || capabilities.otaUiAvailable) ? sectionParam as SettingsSection : null;
  const [confirmation, setConfirmation] = useState<{ kind: "passkey" | "emoji"; id: string; name: string } | null>(null);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [showForgetKeys, setShowForgetKeys] = useState(false);
  const [showSignOut, setShowSignOut] = useState(false);
  const [forgettingKeys, setForgettingKeys] = useState(false);
  const [forgetError, setForgetError] = useState<LocalizedMessage | null>(null);
  const [enrollingRecovery, setEnrollingRecovery] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [showAddEmoji, setShowAddEmoji] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, device, logout, updateProfile, bumpSessionState } = useAuthStore();
  const getPreferencesForUser = useUiPreferencesStore((state) => state.getPreferencesForUser);
  const savePreferencesForUser = useUiPreferencesStore((state) => state.savePreferencesForUser);
  const clearPreferencesForUser = useUiPreferencesStore((state) => state.clearPreferencesForUser);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const storedPreferences = getPreferencesForUser(user?.id, prefersDark);

  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [profileError, setProfileError] = useState<LocalizedMessage | null>(null);
  const [appearanceDraft, setAppearanceDraft] = useState<UiPreferences>(() => buildInitialDraft(storedPreferences));
  const [appearanceError, setAppearanceError] = useState<LocalizedMessage | null>(null);
  const [emojiShortcode, setEmojiShortcode] = useState("");
  const [emojiFile, setEmojiFile] = useState<File | null>(null);
  const [emojiError, setEmojiError] = useState<LocalizedMessage | null>(null);
  const [emojiBusyId, setEmojiBusyId] = useState<string | null>(null);
  const [uploadingEmoji, setUploadingEmoji] = useState(false);
  const [emojiDrafts, setEmojiDrafts] = useState<Record<string, string>>({});
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<LocalizedMessage | null>(null);
  const [dangerError, setDangerError] = useState<LocalizedMessage | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [passkeyName, setPasskeyName] = useState("");
  const [passkeyError, setPasskeyError] = useState<LocalizedMessage | null>(null);
  const [registeringPasskey, setRegisteringPasskey] = useState(false);
  const [deletingPasskeyId, setDeletingPasskeyId] = useState<string | null>(null);
  const [cachedPasskeyOptions, setCachedPasskeyOptions] = useState<CachedPasskeyRegistrationOptions | null>(null);
  const [preparingPasskey, setPreparingPasskey] = useState(false);

  useEffect(() => { setDisplayName(user?.displayName ?? ""); }, [user?.displayName]);

  const passkeysQuery = useQuery({
    enabled: capabilities.passkeys || capabilities.nativePasskeys,
    queryKey: ["passkeys"],
    queryFn: () => api.get<PasskeyInfo[]>("/api/passkeys"),
  });

  const customEmojisQuery = useQuery({
    queryKey: ["myCustomEmojis"],
    queryFn: () => api.get<CustomEmoji[]>("/api/emojis/mine"),
  });

  const recoveryStatusQuery = useQuery({
    queryKey: ["recoveryKeyStatus"],
    queryFn: () => api.get<{ enrolled: boolean }>("/api/device-links/recovery-key"),
  });

  useEffect(() => {
    setAppearanceDraft(buildInitialDraft(storedPreferences));
  }, [
    storedPreferences.themeMode,
    storedPreferences.outgoingMessageColor,
    storedPreferences.incomingMessageColor,
    storedPreferences.sendButtonColor,
  ]);

  useEffect(() => {
    if (!user || !capabilities.passkeys) {
      setCachedPasskeyOptions(null);
      return;
    }

    let cancelled = false;

    const preloadPasskeyOptions = async () => {
      setPreparingPasskey(true);
      try {
        const { challengeId, options } = await api.post<PasskeyRegistrationOptionsResponse>(
          "/api/passkeys/register-options",
          {},
        );
        if (!cancelled) {
          setCachedPasskeyOptions({ challengeId, options, fetchedAt: Date.now() });
        }
      } catch {
        if (!cancelled) {
          setCachedPasskeyOptions(null);
        }
      } finally {
        if (!cancelled) {
          setPreparingPasskey(false);
        }
      }
    };

    void preloadPasskeyOptions();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const loadFreshPasskeyOptions = async (): Promise<CachedPasskeyRegistrationOptions> => {
    setPreparingPasskey(true);
    try {
      const { challengeId, options } = await api.post<PasskeyRegistrationOptionsResponse>(
        "/api/passkeys/register-options",
        {},
      );
      const next = { challengeId, options, fetchedAt: Date.now() };
      setCachedPasskeyOptions(next);
      return next;
    } finally {
      setPreparingPasskey(false);
    }
  };

  const appearanceValidation = useMemo(() => {
    const outgoing = normalizeHexColor(appearanceDraft.outgoingMessageColor);
    const incoming = normalizeHexColor(appearanceDraft.incomingMessageColor);
    const send = normalizeHexColor(appearanceDraft.sendButtonColor);

    return {
      outgoing,
      incoming,
      send,
      errors: {
        outgoing: appearanceDraft.outgoingMessageColor && !outgoing ? t("enterAValidHexColorLike14586e") : null,
        incoming: appearanceDraft.incomingMessageColor && !incoming ? t("enterAValidHexColorLikeE3e9eb") : null,
        send: appearanceDraft.sendButtonColor && !send ? t("enterAValidHexColorLike14586e") : null,
      },
    };
  }, [
    appearanceDraft.incomingMessageColor,
    appearanceDraft.outgoingMessageColor,
    appearanceDraft.sendButtonColor,
    locale,
  ]);

  const previewTheme = resolveTheme(appearanceDraft.themeMode, prefersDark);
  const previewBubbleOutgoing = appearanceValidation.outgoing ?? storedPreferences.outgoingMessageColor;
  const previewBubbleIncoming = appearanceValidation.incoming ?? storedPreferences.incomingMessageColor;
  const previewSend = appearanceValidation.send ?? storedPreferences.sendButtonColor;

  const handleRegisterPasskey = async () => {
    if (!capabilities.passkeys && !capabilities.nativePasskeys) {
      setPasskeyError(toErrorMessage(new PasskeyUnsupportedError()));
      return;
    }
    if (!passkeyName.trim()) {
      setPasskeyError(localized("giveYourPasskeyAName"));
      return;
    }
    if (!device?.id) return false;
    setRegisteringPasskey(true);
    setPasskeyError(null);
    try {
      if (capabilities.nativePasskeys) {
        await addNativePasskey(passkeyName.trim(), device.id);
        setPasskeyName("");
        await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
        return true;
      }
      const registerOptions =
        cachedPasskeyOptions && Date.now() - cachedPasskeyOptions.fetchedAt < PASSKEY_OPTIONS_MAX_AGE_MS
          ? cachedPasskeyOptions
          : await loadFreshPasskeyOptions();
      const { challengeId, options } = registerOptions;
      const credential = await createPasskeyCredential(options);
      const { clientDataJSON, attestationObject } = credential.response;
      const deviceSignature = await signWithIdentityKey(createPasskeyEnrollmentPayload(device.id, {
        kind: "web", challengeId, clientDataJSON, attestationObject,
      }));
      await api.post("/api/passkeys/register", {
        challengeId,
        deviceSignature,
        credential,
        friendlyName: passkeyName.trim(),
      });
      setPasskeyName("");
      await loadFreshPasskeyOptions().catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
      return true;
    } catch (error: any) {
      if (error.name === "NotAllowedError") {
        setPasskeyError(localized("passkeyCreationWasCancelledOrDismissedCompleteThe"));
        await loadFreshPasskeyOptions().catch(() => undefined);
      } else {
        setPasskeyError(toErrorMessage(error, "failedToRegisterPasskey"));
      }
    } finally {
      setRegisteringPasskey(false);
    }
  };

  const handleDeletePasskey = async (passkeyId: string) => {

    const credential = passkeysQuery.data?.find(passkey => passkey.id === passkeyId);
    if (credential && await isOnlyLocalPasskeyUnlock(credential.credentialId)) {
      setPasskeyError(localized("addBackupUnlockBeforeRemovingPasskey"));
      return false;
    }
    setDeletingPasskeyId(passkeyId);
    setPasskeyError(null);
    try {
      await api.delete(`/api/passkeys/${passkeyId}`);
      if (credential && await localPasskeyUnlockId() === credential.credentialId) await removeLocalUnlockMethod("passkey").catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
      setConfirmation(null);
      return true;
    } catch (error: any) {
      setPasskeyError(toErrorMessage(error, "failedToRemovePasskey"));
    } finally {
      setDeletingPasskeyId(null);
    }
  };

  const handleLogout = () => {
    clearAccountScopedState();
    logout();
    navigate("/login");
  };

  const handleAvatarChange = async (avatarUrl: string) => {
    setSavingAvatar(true);
    setProfileError(null);
    try {
      await updateProfile({ avatarUrl });
      setShowAvatarPicker(false);
      return true;
    } catch (error: any) {
      setProfileError(toErrorMessage(error, "failedToUpdateAvatar"));
      return false;
    } finally {
      setSavingAvatar(false);
    }
  };

  const handleSaveAppearance = () => {
    if (!user?.id) return;
    if (!appearanceValidation.outgoing || !appearanceValidation.incoming || !appearanceValidation.send) {
      setAppearanceError(localized("fixTheColorValuesBeforeSaving"));
      return;
    }

    savePreferencesForUser(user.id, {
      ...storedPreferences,
      themeMode: appearanceDraft.themeMode,
      outgoingMessageColor: appearanceValidation.outgoing,
      incomingMessageColor: appearanceValidation.incoming,
      sendButtonColor: appearanceValidation.send,
    });
    setAppearanceError(null);
    return true;
  };

  const handleResetAppearance = () => {
    const defaults = getDefaultUiPreferences(resolveTheme("system", prefersDark));
    setAppearanceDraft(defaults);
    setAppearanceError(null);
    if (user?.id) {
      savePreferencesForUser(user.id, { ...storedPreferences, ...defaults });
    }
  };

  const handleUploadEmoji = async () => {
    if (!emojiFile) {
      setEmojiError(localized("chooseAnImageFileToUpload"));
      return;
    }

    const normalizedShortcode = emojiShortcode.trim().replace(/^:+|:+$/g, "").toLowerCase();
    if (!normalizedShortcode || !/^[a-z0-9_]{2,32}$/.test(normalizedShortcode)) {
      setEmojiError(localized("use232LowercaseLettersNumbersOrUnderscores"));
      return;
    }

    setUploadingEmoji(true);
    setEmojiError(null);
    try {
      const upload = await api.post<{ emojiId: string; uploadUrl: string }>("/api/emojis/upload-url", {
        shortcode: normalizedShortcode,
        mimeType: emojiFile.type,
        sizeBytes: emojiFile.size,
      });
      await api.put(upload.uploadUrl, await emojiFile.arrayBuffer());
      setEmojiFile(null);
      setEmojiShortcode("");
      setShowAddEmoji(false);
      await queryClient.invalidateQueries({ queryKey: ["myCustomEmojis"] });
      return true;
    } catch (error: any) {
      setEmojiError(toErrorMessage(error, "failedToUploadCustomEmoji"));
    } finally {
      setUploadingEmoji(false);
    }
  };

  const handleRenameEmoji = async (emojiId: string) => {
    const draft = (emojiDrafts[emojiId] ?? "").trim().replace(/^:+|:+$/g, "").toLowerCase();
    if (!draft || !/^[a-z0-9_]{2,32}$/.test(draft)) {
      setEmojiError(localized("emojiShortcodesMustUse232LowercaseLetters"));
      return;
    }

    setEmojiBusyId(emojiId);
    setEmojiError(null);
    try {
      await api.put(`/api/emojis/${emojiId}`, { shortcode: draft });
      await queryClient.invalidateQueries({ queryKey: ["myCustomEmojis"] });
      return true;
    } catch (error: any) {
      setEmojiError(toErrorMessage(error, "failedToRenameCustomEmoji"));
    } finally {
      setEmojiBusyId(null);
    }
  };

  const handleDeleteEmoji = async (emojiId: string) => {

    setEmojiBusyId(emojiId);
    setEmojiError(null);
    try {
      await api.delete(`/api/emojis/${emojiId}`);
      setConfirmation(null);
      await queryClient.invalidateQueries({ queryKey: ["myCustomEmojis"] });
      return true;
    } catch (error: any) {
      setEmojiError(toErrorMessage(error, "failedToDeleteCustomEmoji"));
    } finally {
      setEmojiBusyId(null);
    }
  };

  const handleEnrollRecoveryKey = async () => {
    if (enrollingRecovery || recoveryStatusQuery.data?.enrolled) return;
    setEnrollingRecovery(true);
    setRecoveryError(null);
    const recoveryKey = generateRecoveryKey();
    try {
      await api.post("/api/device-links/recovery-key", { recoveryKey });
      setGeneratedRecoveryKey(recoveryKey);
      await recoveryStatusQuery.refetch();
    } catch (error: any) {
      setRecoveryError(toErrorMessage(error, "failedToEnrollRecoveryKey"));
    } finally { setEnrollingRecovery(false); }
  };

  const handleDeleteAccount = async () => {
    if (!user?.id) return;
    setDeletingAccount(true);
    setDangerError(null);
    try {
      await api.post("/api/account/delete", {
        password: deletePassword,
        confirmationText: deleteConfirmation,
      });
      await resetLocalCryptoState().catch(() => undefined);
      await clearAll();
      clearPreferencesForUser(user.id);
      queryClient.clear();
      logout({ forgetDevice: true });
      navigate("/register", { replace: true });
    } catch (error: any) {
      setDangerError(toErrorMessage(error, "failedToDeleteAccount"));
      setDeletingAccount(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!displayName.trim() || savingProfile) return false;
    setSavingProfile(true); setProfileError(null);
    try { await updateProfile({ displayName: displayName.trim() }); return true; }
    catch (error: any) { setProfileError(toErrorMessage(error, "failedToSaveProfile")); return false; }
    finally { setSavingProfile(false); }
  };
  const handleLockNow = () => { lockLocalCryptoState(); bumpSessionState(); navigate("/unlock", { state: { from: { pathname: "/settings", search: "?section=security" } } }); };
  const handleForgetKeys = async () => {
    if (forgettingKeys) return;
    setForgettingKeys(true); setForgetError(null);
    try { await resetLocalCryptoState(); clearAccountScopedState(); logout({ forgetDevice: true }); navigate("/login", { replace: true }); }
    catch (error: any) { setForgetError(toErrorMessage(error, "couldNotForgetKeys")); setForgettingKeys(false); bumpSessionState(); }
  };
  const handleThemeChange = (themeMode: ThemeMode) => {
    const next = { ...appearanceDraft, themeMode };
    const defaults = getDefaultUiPreferences(previewTheme);
    if (next.outgoingMessageColor === defaults.outgoingMessageColor && next.incomingMessageColor === defaults.incomingMessageColor && next.sendButtonColor === defaults.sendButtonColor) {
      Object.assign(next, getDefaultUiPreferences(resolveTheme(themeMode, prefersDark)), { themeMode });
    }
    setAppearanceDraft(next);
    if (user?.id) savePreferencesForUser(user.id, {
      ...storedPreferences,
      ...next,
      outgoingMessageColor: normalizeHexColor(next.outgoingMessageColor) ?? storedPreferences.outgoingMessageColor,
      incomingMessageColor: normalizeHexColor(next.incomingMessageColor) ?? storedPreferences.incomingMessageColor,
      sendButtonColor: normalizeHexColor(next.sendButtonColor) ?? storedPreferences.sendButtonColor,
    });
  };
  const customEmojis = (customEmojisQuery.data ?? []).map((emoji) => ({ ...emoji, src: resolveApiUrl(emoji.downloadUrl) }));
  const hasRecoveryKey = recoveryStatusQuery.data?.enrolled ?? false;

  const copyRecoveryKey = async () => {
    if (generatedRecoveryKey) await copyText(generatedRecoveryKey);
  };

  return {
    privacy,
    localUnlock: {
      list: () => listLocalUnlockMethods(),
      enroll: (setup: Parameters<typeof enrollLocalUnlockMethod>[0]) =>
        setup.method === "password" ? addAccountPasswordUnlock(setup.password) : bindAccountUnlockEnrollment()(setup),
      remove: (method: Parameters<typeof removeLocalUnlockMethod>[0]) => removeLocalUnlockMethod(method),
      addAccountPassword: addAccountPasswordUnlock,
      isOnlyPasskey: (credentialId: string) => isOnlyLocalPasskeyUnlock(credentialId),
    },
    selectedSection, section: selectedSection ?? "appearance",
    compressAttachments: storedPreferences.compressAttachments ?? false,
    setCompressAttachments: (enabled: boolean) => {
      if (user?.id) savePreferencesForUser(user.id, { ...storedPreferences, compressAttachments: enabled });
    },
    closeSection,
    avatarSrc: resolveAvatarImageUrl(user?.avatarUrl),
    displayName, setDisplayName, savingProfile, handleSaveProfile,
    profileChanged: displayName.trim() !== user?.displayName,
    copyUsername: () => copyText(`@${user?.username ?? ""}`),
    handleLockNow, handleForgetKeys, forgettingKeys, forgetError: forgetError ? renderMessage(forgetError) : forgetError, showForgetKeys, setShowForgetKeys,
    showSignOut, setShowSignOut, showDeleteAccount, setShowDeleteAccount,
    confirmation, closeConfirmation: () => setConfirmation(null),
    requestDeletePasskey: (id: string, name: string) => { setPasskeyError(null); setConfirmation({ kind: "passkey", id, name }); },
    requestDeleteEmoji: (id: string, name: string) => { setEmojiError(null); setConfirmation({ kind: "emoji", id, name }); },
    showAddEmoji, setShowAddEmoji,
    closeAddEmoji: () => { setShowAddEmoji(false); setEmojiFile(null); },
    handleThemeChange, enrollingRecovery,
    dismissRecoveryKey: () => setGeneratedRecoveryKey(null),
    canSaveRecoveryKey: capabilities.saveFile,
    saveRecoveryKey: async () => { if (generatedRecoveryKey) await saveFile(new Blob([generatedRecoveryKey], { type: "text/plain" }), "private-base-recovery-key.txt"); },
    previewOutgoingText: getReadableTextColor(previewBubbleOutgoing),
    previewIncomingText: getReadableTextColor(previewBubbleIncoming),
    previewSendText: getReadableTextColor(previewSend),
    previewRatios: {
      outgoing: getContrastRatio(previewBubbleOutgoing, getReadableTextColor(previewBubbleOutgoing)).toFixed(2),
      incoming: getContrastRatio(previewBubbleIncoming, getReadableTextColor(previewBubbleIncoming)).toFixed(2),
      send: getContrastRatio(previewSend, getReadableTextColor(previewSend)).toFixed(2),
    },
    incomingEdgeWarning: getContrastRatio(previewBubbleIncoming, previewTheme === "dark" ? "#0e171c" : "#eef2f3") < 1.15,
    colorInputValue: (value: string) => normalizeHexColor(value) ?? "#000000",
    copyRecoveryKey,
    capabilities,
    background,
    webPush,
    passkeysSupported: capabilities.passkeys || capabilities.nativePasskeys,
    navigate,
    user,
    device,
    showAvatarPicker,
    setShowAvatarPicker,
    savingAvatar,
    profileError: profileError ? renderMessage(profileError) : profileError,
    appearanceDraft,
    setAppearanceDraft,
    appearanceError: appearanceError ? renderMessage(appearanceError) : appearanceError,
    emojiShortcode,
    setEmojiShortcode,
    setEmojiFile,
    emojiError: emojiError ? renderMessage(emojiError) : emojiError,
    emojiBusyId,
    uploadingEmoji,
    emojiDrafts,
    setEmojiDrafts,
    generatedRecoveryKey,
    recoveryError: recoveryError ? renderMessage(recoveryError) : recoveryError,
    dangerError: dangerError ? renderMessage(dangerError) : dangerError,
    deletingAccount,
    deletePassword,
    setDeletePassword,
    deleteConfirmation,
    setDeleteConfirmation,
    passkeyName,
    setPasskeyName,
    passkeyError: passkeyError ? renderMessage(passkeyError) : passkeyError,
    registeringPasskey,
    deletingPasskeyId,
    preparingPasskey,
    passkeysQuery,
    customEmojisQuery,
    appearanceValidation,
    previewTheme,
    previewBubbleOutgoing,
    previewBubbleIncoming,
    previewSend,
    handleRegisterPasskey,
    handleDeletePasskey,
    handleLogout,
    handleAvatarChange,
    handleSaveAppearance,
    handleResetAppearance,
    handleUploadEmoji,
    handleRenameEmoji,
    handleDeleteEmoji,
    handleEnrollRecoveryKey,
    handleDeleteAccount,
    customEmojis,
    hasRecoveryKey
  };
}
