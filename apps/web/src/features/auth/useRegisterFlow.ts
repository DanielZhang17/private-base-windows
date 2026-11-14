import { localized, renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { t, useLocale, getLocale } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore.js";
import {
  getLocalKeyOwner,
  hasLocalKeyMaterial,
  initializeKeys,
  resetLocalCryptoState,
  setLocalKeyOwner,
  uploadPreKeyBundle,
  type LocalKeyOwner,
} from "../../lib/key-manager.js";

import { buildDefaultDeviceName, generateRecoveryKey } from "../../lib/device-link.js";
import { copyText } from "../../platform/clipboard.js";
import { capabilities } from "../../platform/capabilities.js";
import { saveFile } from "../../platform/files.js";
import { authAvatarSrc } from "./avatar.js";
import { useAvatarUpload } from "../settings/useAvatarUpload.js";

export function useRegisterFlow() {
  useLocale();
  const submitting = useRef(false);
  const mounted = useRef(true);
  const retryTimer = useRef<number | null>(null);
  const finishWait = useRef<(() => void) | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      finishWait.current?.();
    };
  }, []);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string>();
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState<string | null>(null);
  const [uploadWarning, setUploadWarning] = useState(false);
  const [blockedOwner, setBlockedOwner] = useState<LocalKeyOwner | null | undefined>(undefined);
  const register = useAuthStore((state) => state.register);
  const navigate = useNavigate();
  const avatarUpload = useAvatarUpload((uploadedUrl) => {
    useAuthStore.setState(({ user }) => user ? { user: { ...user, avatarUrl: uploadedUrl } } : {});
    setAvatarFile(null);
  });

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreview(undefined);
      return;
    }
    const preview = URL.createObjectURL(avatarFile);
    setAvatarPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [avatarFile]);

  const chooseAvatar = (url: string) => {
    setAvatarUrl(url);
    setAvatarFile(null);
    setShowAvatarPicker(false);
  };
  const chooseAvatarFile = (file: File) => {
    setAvatarFile(file);
    setAvatarUrl(null);
    setShowAvatarPicker(false);
  };
  const uploadAvatar = () => {
    if (avatarFile) void avatarUpload.uploadFile(avatarFile);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await performRegistration();
  };

  const performRegistration = async () => {
    if (submitting.current) return;
    setError(null);
    if (password !== confirmPassword) {
      setError(localized("passwordsDonTMatch"));
      return;
    }

    submitting.current = true;
    setLoading(true);
    let initialized = false;
    let registered = false;
    let recoveryKey: string | null = null;
    try {
      if (await hasLocalKeyMaterial()) {
        setBlockedOwner(await getLocalKeyOwner());
        return;
      }
      recoveryKey = generateRecoveryKey();
      const deviceName = buildDefaultDeviceName(getLocale(), t("browser"));
      initialized = true;
      const identityKey = await initializeKeys(password);
      await register(username, displayName, password, recoveryKey, deviceName, identityKey, avatarUrl);
      registered = true;
      const { user, device } = useAuthStore.getState();
      if (user) {
        await setLocalKeyOwner({ userId: user.id, username: user.username, deviceId: device?.id }).catch((ownerError) => {
          console.error("Failed to save local key owner", ownerError);
          setError(localized("yourAccountWasCreatedButThisBrowserCould"));
        });
      }
      for (const delay of [500, 1500, 3000]) {
        await new Promise<void>((resolve) => {
          finishWait.current = resolve;
          retryTimer.current = window.setTimeout(resolve, delay);
        });
        retryTimer.current = null;
        finishWait.current = null;
        if (!mounted.current) return;
        try {
          await uploadPreKeyBundle();
          return;
        } catch {
          // Keep this device's keys and retry; registration already succeeded.
        }
      }
      setUploadWarning(true);
    } catch (submitError: any) {
      if (initialized && !registered) await resetLocalCryptoState().catch(() => undefined);
      setError(toErrorMessage(submitError, registered ? "yourDeviceKeysWillFinishUploadingAutomatically" : "registrationFailed"));
    } finally {
      submitting.current = false;
      if (mounted.current) {
        if (registered && recoveryKey) {
          setGeneratedRecoveryKey(recoveryKey);
          uploadAvatar();
        }
        setLoading(false);
      }
    }
  };

  const forgetLocalKeys = async () => {
    setLoading(true);
    setError(null);
    try {
      await resetLocalCryptoState();
      useAuthStore.getState().logout({ forgetDevice: true });
      setBlockedOwner(undefined);
      await performRegistration();
    } catch (forgetError: any) {
      setError(toErrorMessage(forgetError, "failedToForgetLocalKeys"));
    } finally {
      setLoading(false);
    }
  };

  const copyRecoveryKey = async () => {
    if (generatedRecoveryKey) await copyText(generatedRecoveryKey);
  };

  const saveRecoveryKey = async () => {
    if (generatedRecoveryKey && capabilities.saveFile) {
      await saveFile(new Blob([generatedRecoveryKey], { type: "text/plain" }), "private-base-recovery-key.txt");
    }
  };

  return {
    capabilities,
    avatarSrc: avatarPreview ?? authAvatarSrc(avatarUrl),
    avatarFile,
    chooseAvatar,
    chooseAvatarFile,
    discardAvatar: () => setAvatarFile(null),
    uploadAvatar,
    avatarUploading: avatarUpload.uploading,
    avatarUploadError: avatarUpload.notice,
    saveRecoveryKey,
    copyRecoveryKey,
    forgetLocalKeys,
    username,
    setUsername,
    displayName,
    setDisplayName,
    password,
    setPassword,
    confirmPassword,
    setConfirmPassword,
    avatarUrl,
    showAvatarPicker,
    setShowAvatarPicker,
    error: error ? renderMessage(error) : "",
    loading,
    generatedRecoveryKey,
    uploadWarning,
    blockedOwner,
    navigate,
    handleSubmit
  };
}
