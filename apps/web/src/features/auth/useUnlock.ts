import { localized, renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { t, useLocale } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore.js";
import { keysLoaded, loadKeys, resetLocalDevice, listLocalUnlockMethods, unlockLocalKeys } from "../../lib/key-manager.js";
import { clearRegisteredAccountState } from "../../platform/session-cleanup.js";
import type { UnlockMethod } from "../../lib/device-key-vault.js";
import { capabilities } from "../../platform/capabilities.js";
import { unlockMethodInfo } from "./unlockMethods.js";
import { clearUnlockAttempts, readUnlockAttempts, recordUnlockFailure } from "./unlockAttempt.js";
import { platformName } from "../../platform/environment.js";
import { NativeBiometricError } from "../../platform/biometric-unlock.js";
import { markUnlockOffer } from "./unlockOfferState.js";
import { authAvatarSrc } from "./avatar.js";

interface UnlockLocationState {
  from?: {
    pathname?: string;
    search?: string;
    hash?: string;
  };
}

export function useUnlock() {
  useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuthStore();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [methods, setMethods] = useState<UnlockMethod[]>([]);
  const [methodsRead, setMethodsRead] = useState<"reading" | "ready" | "failed">("reading");
  const [methodsReadAttempt, setMethodsReadAttempt] = useState(0);
  const [chosenPassword, setChosenPassword] = useState(false);
  const [unlockPhase, setUnlockPhase] = useState<"waiting" | "unlocking" | null>(null);
  const [failureKind, setFailureKind] = useState<"temporary" | "invalidated" | "failed">();
  const invalidatedDevice = useRef<string | undefined>(undefined);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(Date.now);
  const autoPrompted = useRef(false);
  const native = methods.includes("native") ? capabilities.biometricUnlock : undefined;
  const preferred: UnlockMethod | undefined = native ? "native" : methods.includes("passkey") && capabilities.passkeys ? "passkey" : undefined;
  const hasPassword = methods.includes("password");
  const showPassword = hasPassword && (!preferred || chosenPassword);
  const info = preferred && unlockMethodInfo(preferred, native);
  const retrySeconds = Math.max(0, Math.ceil((until - now) / 1000));
  const deviceId = auth.device?.id;
  useEffect(() => {
    if (!deviceId) return;
    let active = true;
    void readUnlockAttempts(deviceId).then(record => { if (active) setUntil(record?.until ?? 0); }).catch(() => undefined);
    return () => { active = false; };
  }, [deviceId]);
  useEffect(() => {
    if (!until || now >= until) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(1000, until - now));
    return () => clearTimeout(timer);
  }, [until, now]);
  useEffect(() => {
    let current = true;
    setMethods([]);
    setMethodsRead("reading");
    void listLocalUnlockMethods().then((stored) => {
      if (current) {
        setMethods(stored);
        setMethodsRead("ready");
      }
    }).catch(() => { if (current) setMethodsRead("failed"); });
    return () => { current = false; };
  }, [deviceId, methodsReadAttempt]);

  useEffect(() => {
    if (window.matchMedia?.("(min-width: 640px)").matches) passwordInput.current?.focus();
  }, [showPassword]);

  const returnTo = (() => {
    const state = location.state as UnlockLocationState | null;
    const from = state?.from;
    if (!from?.pathname) return "/";
    return `${from.pathname}${from.search ?? ""}${from.hash ?? ""}`;
  })();

  const redirectTo = !auth.accessToken || !auth.device ? "/login" : keysLoaded() ? returnTo : null;

  const handleUnlockWith = async (method: UnlockMethod) => {
    if (submitting.current) return;
    if (method === "password" && until > Date.now()) return;
    submitting.current = true;
    setLoading(true);
    setError(null);
    setFailureKind(undefined);
    setUnlockPhase(method === "password" ? "unlocking" : "waiting");
    try {
      if (method === "password") {
        if (deviceId) {
          const record = await readUnlockAttempts(deviceId).catch(() => undefined);
          if (record && record.until > Date.now()) { setUntil(record.until); setNow(Date.now()); return; }
        }
        await loadKeys(password);
        if (deviceId) {
          void clearUnlockAttempts(deviceId).catch(() => undefined);
          markUnlockOffer(deviceId, methods, invalidatedDevice.current === deviceId);
        }
      } else await unlockLocalKeys(method, undefined, () => setUnlockPhase("unlocking"));
      auth.bumpSessionState();
      navigate(returnTo, { replace: true });
    } catch (err) {
      if ((err as Error)?.name === "NotAllowedError" || (err instanceof NativeBiometricError && err.code === "cancelled")) return;
      if (method === "password") {
        if ((err as Error)?.name === "OperationError" && deviceId) {
          const record = await recordUnlockFailure(deviceId).catch(() => undefined);
          if (record) { setUntil(record.until); setNow(Date.now()); }
        }
        setError((err as Error)?.name === "OperationError" ? localized("thatPasswordIsNotCorrect") : toErrorMessage(err, "failedToUnlockThisDevice"));
        passwordInput.current?.focus();
        passwordInput.current?.select();
      } else if (method === "passkey") {
        setFailureKind("failed");
        setError(localized(hasPassword ? "unlock.prfFailedOrPassword" : "unlock.prfFailed"));
      } else if (info) {
        const params = { method: info.name, device: platformName() === "ios" ? "iPhone" : platformName() === "macos" ? "Mac" : t("passkeySetup.setupOtherDevice") };
        const code = err instanceof NativeBiometricError ? err.code : "failed";
        if (code === "invalidated" || code === "lockout") {
          if (code === "invalidated") invalidatedDevice.current = deviceId;
          setFailureKind(code === "invalidated" ? "invalidated" : "temporary");
          if (hasPassword) setChosenPassword(true);
          setError(localized(code === "invalidated" ? hasPassword ? "unlock.invalidated" : "unlock.invalidatedNoBackup"
            : hasPassword ? "unlock.lockout" : "unlock.lockoutNoPassword", params));
        } else {
          setFailureKind("failed");
          setError(localized(hasPassword ? "unlock.orUsePassword" : "unlock.notRecognised", params));
        }
      }
    } finally {
      submitting.current = false;
      setLoading(false);
      setUnlockPhase(null);
    }
  };
  const autoUnlock = useRef(handleUnlockWith);
  autoUnlock.current = handleUnlockWith;
  useEffect(() => {
    if (!native || redirectTo || autoPrompted.current) return;
    const prompt = () => {
      if (document.visibilityState !== "visible" || autoPrompted.current) return;
      autoPrompted.current = true;
      void autoUnlock.current("native");
    };
    prompt();
    document.addEventListener("visibilitychange", prompt);
    return () => document.removeEventListener("visibilitychange", prompt);
  }, [native, redirectTo]);

  const handleForgetDevice = async () => {
    if (!confirmForget) {
      setError(null);
      setConfirmForget(true);
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setError(null);
    try {
      await resetLocalDevice();
      clearRegisteredAccountState();
      auth.logout({ forgetDevice: true });
      navigate("/login", { replace: true });
    } catch (err: any) {
      setError(toErrorMessage(err, "failedToForgetThisDevice"));
      setLoading(false);
    } finally {
      submitting.current = false;
    }
  };

  return {
    avatarSrc: authAvatarSrc(auth.user?.avatarUrl),
    passwordInput,
    redirectTo,
    auth: { user: auth.user },
    password,
    setPassword,
    error: error ? renderMessage(error) : "",
    unlockPhase, failureKind, retrySeconds, preferred, info, hasPassword, showPassword,
    setChosenPassword,
    loading,
    confirmForget,
    setConfirmForget,
    methods,
    methodsRead,
    retryReadMethods: () => setMethodsReadAttempt(attempt => attempt + 1),
    passkeyUnlock: methods.includes("passkey") && capabilities.passkeys,
    biometricUnlock: methods.includes("native") ? capabilities.biometricUnlock : undefined,
    handleUnlock: (event: React.FormEvent) => { event.preventDefault(); return handleUnlockWith("password"); },
    handleUnlockWith,
    handleForgetDevice
  };
}
