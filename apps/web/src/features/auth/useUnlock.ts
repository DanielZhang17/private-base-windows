import { localized, renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { useLocale } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore.js";
import { keysLoaded, loadKeys, resetLocalCryptoState } from "../../lib/key-manager.js";
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

  useEffect(() => {
    if (window.matchMedia?.("(min-width: 640px)").matches) passwordInput.current?.focus();
  }, []);

  const returnTo = (() => {
    const state = location.state as UnlockLocationState | null;
    const from = state?.from;
    if (!from?.pathname) return "/";
    return `${from.pathname}${from.search ?? ""}${from.hash ?? ""}`;
  })();

  const redirectTo = !auth.accessToken || !auth.device ? "/login" : keysLoaded() ? returnTo : null;

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setError(null);
    try {
      await loadKeys(password);
      auth.bumpSessionState();
      navigate(returnTo, { replace: true });
    } catch (err: any) {
      setError(err?.name === "OperationError" ? localized("thatPasswordIsNotCorrect") : toErrorMessage(err, "failedToUnlockThisDevice"));
      passwordInput.current?.focus();
      passwordInput.current?.select();
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  };

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
      await resetLocalCryptoState();
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
    loading,
    confirmForget,
    setConfirmForget,
    handleUnlock,
    handleForgetDevice
  };
}
