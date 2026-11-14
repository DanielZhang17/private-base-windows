import { localized, renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { translateError, toErrorMessage } from "../shared/errors.js";
import { t, useLocale } from "../../i18n/index.js";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatSafetyNumber, fromBase64Url, generateSafetyNumber } from "@e2ee-chat/crypto";
import { getIdentityKeyPair } from "../../lib/key-manager.js";
import { useAuthStore } from "../../stores/authStore.js";
import { copyText } from "../../platform/clipboard.js";
import { resolveAvatarImageUrl } from "../settings/avatar.js";
import { api } from "../../services/api.js";

interface RemoteDevice {
  id: string;
  identityKey: string;
}

interface RemoteUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
}

export function useSafetyNumber() {
  useLocale();
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const localUser = useAuthStore((state) => state.user);
  const [verification, setVerification] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<LocalizedMessage | null>(null);
  const verificationKey = `private-base-verification:${localUser?.id ?? ""}:${userId ?? ""}`;
  useEffect(() => {
    setVerification(null);
    if (!localUser?.id || !userId) return;
    try { setVerification(window.localStorage.getItem(verificationKey)); } catch { /* Verification remains available in memory. */ }
  }, [verificationKey, localUser?.id, userId]);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [computedKey, setComputedKey] = useState<string | null>(null);
  const [error, setError] = useState<LocalizedMessage | null>(null);

  const { data: remoteDevice, error: deviceError, refetch: refetchDevice } = useQuery({
    queryKey: ["remoteDevice", userId],
    queryFn: async () => {
      const devices = await api.get<RemoteDevice[]>(`/api/devices/user/${userId}`);
      return devices[0] ?? null;
    },
    enabled: !!userId,
  });

  const { data: remoteUser, error: userError, refetch: refetchUser } = useQuery({
    queryKey: ["user", userId],
    queryFn: () => api.get<RemoteUser>(`/api/users/${userId}`),
    enabled: !!userId,
  });

  useEffect(() => {
    setSafetyNumber(null);
    setError(null);
    const device = remoteDevice;
    if (!device) return;
    const remoteIdentityKey = device.identityKey;
    let cancelled = false;

    async function computeSafetyNumber() {
      try {
        const localKeys = getIdentityKeyPair();
        const remoteIdentity = fromBase64Url(remoteIdentityKey);
        const raw = await generateSafetyNumber(localKeys.publicEd25519, remoteIdentity);
        if (!cancelled) {
          setSafetyNumber(formatSafetyNumber(raw));
          setComputedKey(`${userId}:${remoteIdentityKey}`);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(toErrorMessage(err, "couldNotGenerateSafetyNumber"));
        }
      }
    }

    void computeSafetyNumber();
    return () => {
      cancelled = true;
    };
  }, [remoteDevice, userId]);

  const currentNumber = computedKey === `${userId}:${remoteDevice?.identityKey}` ? safetyNumber : null;
  const verified = !!currentNumber && verification === currentNumber;
  const verificationChanged = !!currentNumber && !!verification && verification !== currentNumber;
  const toggleVerification = () => {
    if (!currentNumber || !localUser?.id) return false;
    try {
      if (verified) window.localStorage.removeItem(verificationKey);
      else window.localStorage.setItem(verificationKey, currentNumber);
      setVerification(verified ? null : currentNumber); setVerificationError(null);
      return true;
    } catch { setVerificationError(localized("couldNotSaveVerificationOnThisDeviceTry")); return false; }
  };
  return {
    localUser, localAvatarSrc: resolveAvatarImageUrl(localUser?.avatarUrl),
    remoteAvatarSrc: resolveAvatarImageUrl(remoteUser?.avatarUrl),
    groups: currentNumber?.replace(/\s/g, "").match(/.{1,5}/g) ?? [],
    verified, verificationChanged, verificationError: verificationError ? renderMessage(verificationError) : verificationError, toggleVerification,
    copySafetyNumber: async () => { if (currentNumber) await copyText(currentNumber); },
    noIdentity: remoteDevice === null,
    retry: () => { void refetchDevice(); void refetchUser(); },
    userId,
    navigate,
    safetyNumber: computedKey === `${userId}:${remoteDevice?.identityKey}` ? safetyNumber : null,
    error: (error ? renderMessage(error) : null) || (deviceError ? translateError(deviceError) : undefined) || (userError ? translateError(userError) : undefined) || (remoteDevice === null ? t("noActiveDeviceFoundForThisUser") : null),
    remoteUser
  };
}
