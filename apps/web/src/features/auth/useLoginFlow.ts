import { localized, renderMessage, LocalizedError, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { t, useLocale, getLocale } from "../../i18n/index.js";
import { clearRecoveryRetry, readRecoveryRetry, saveRecoveryRetry } from "./recoveryRetry.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import type {
  AuthResponse,
  DeviceLinkStatusResponse,
  PasskeyLoginOptionsResponse,
  RecoverDeviceLinkResponse,
  StartDeviceLinkResponse,
} from "@e2ee-chat/shared";
import { useAuthStore } from "../../stores/authStore.js";
import {
  buildDeviceLinkPublicBundle,
  decideLocalKeyAction,
  getLocalKeyOwner,
  hasLocalKeyMaterial,
  initializeKeys,
  resolveLocalKeyDeviceId,
  keysLoaded,
  lockLocalCryptoState,
  loadKeys,
  resetLocalCryptoState,
  setLocalKeyOwner,
  type LocalKeyOwner,
} from "../../lib/key-manager.js";
import { api } from "../../services/api.js";
import { buildDefaultDeviceName, signDeviceLinkCompletion } from "../../lib/device-link.js";
import { getPasskeyAssertion, PasskeyUnsupportedError } from "../../lib/webauthn.js";
import { capabilities } from "../../platform/capabilities.js";

interface PendingLinkState {
  deviceName: string;
  linkRequestId: string;
  shortCode: string | null;
  expiresAt: number;
  mode: "approved_link" | "recovery";
}

const PASSKEY_OPTIONS_MAX_AGE_MS = 4 * 60 * 1000;

interface CachedPasskeyLoginOptions {
  username: string;
  deviceId: string;
  challengeId: string;
  options: PasskeyLoginOptionsResponse["options"];
  fetchedAt: number;
}

export function useLoginFlow() {
  useLocale();
  const location = useLocation();
  const [recoveryRetry, setRecoveryRetry] = useState(readRecoveryRetry);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [username, setUsername] = useState(recoveryRetry?.username ?? (location.state as { username?: string } | null)?.username ?? "");
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [step, setStep] = useState<"sign-in" | "setup">("sign-in");
  const [setupMethod, setSetupMethod] = useState<"recovery" | null>(null);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingLink, setPendingLink] = useState<PendingLinkState | null>(null);
  const [cachedPasskeyOptions, setCachedPasskeyOptions] = useState<CachedPasskeyLoginOptions | null>(null);
  const [blockedOwner, setBlockedOwner] = useState<LocalKeyOwner | null | undefined>(undefined);
  const [linkCompleting, setLinkCompleting] = useState(false);
  const pollInFlight = useRef(false);
  const retryPendingLink = useRef<(() => void) | null>(null);
  const completionRequests = useRef(new Map<string, Promise<AuthResponse>>());
  const completedLinks = useRef(new Set<string>());
  // Cancelling wipes the keys a request is bound to; a completion that settles later must not sign in.
  const cancelledLinks = useRef(new Set<string>());
  // The status endpoint stops returning the nonce once a request is completed.
  const challengeNonces = useRef(new Map<string, string>());
  const prefetchedPasskeyOptions = useRef(new Set<string>());
  const usernameInput = useRef<HTMLInputElement>(null);
  const device = useAuthStore((state) => state.device);
  const applyAuthResponse = useAuthStore((state) => state.applyAuthResponse);
  const navigate = useNavigate();

  useEffect(() => {
    if (!recoveryRetry) return;
    const timer = window.setTimeout(() => {
      clearRecoveryRetry();
      setRecoveryRetry(null);
      setPendingLink(null);
      setError(localized("deviceLinkRequestExpired"));
    }, Math.max(0, recoveryRetry.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [recoveryRetry]);

  const completeDeviceLink = useCallback((
    linkRequestId: string,
    challengeNonce: string,
  ): Promise<AuthResponse> => {
    const existing = completionRequests.current.get(linkRequestId);
    if (existing) return existing;
    challengeNonces.current.set(linkRequestId, challengeNonce);
    const completion = (async () => {
      if (!keysLoaded()) await loadKeys(password);
      const possessionSignature = await signDeviceLinkCompletion(linkRequestId, challengeNonce);
      let auth: AuthResponse;
      try {
        auth = await api.post<AuthResponse>(
          `/api/device-links/${linkRequestId}/complete`,
          { possessionSignature },
        );
      } catch (completeError: any) {
        // An earlier attempt committed but its response was lost. The server names the device it
        // created to the holder of that device's identity key; sign in to it with the password.
        const deviceId = completeError?.status === 409 ? completeError.body?.deviceId : undefined;
        if (typeof deviceId !== "string" || !deviceId) throw completeError;
        auth = await api.post<AuthResponse>("/auth/login", { username, password, deviceId });
      }
      return auth;
    })();
    completionRequests.current.set(linkRequestId, completion);
    // A failed attempt must not be replayed to later polls or retries.
    completion.catch(() => {
      if (completionRequests.current.get(linkRequestId) === completion) {
        completionRequests.current.delete(linkRequestId);
      }
    });
    return completion;
  }, [password, username]);

  useEffect(() => {
    if (!pendingLink) return undefined;

    let cancelled = false;
    const poll = () => {
      if (pollInFlight.current || completedLinks.current.has(pendingLink.linkRequestId) || cancelledLinks.current.has(pendingLink.linkRequestId)) return;
      pollInFlight.current = true;
      void (async () => {
        try {
          if (pendingLink.expiresAt <= Date.now()) {
            clearRecoveryRetry();
            setRecoveryRetry(null);
            setPendingLink(null);
            setError(localized("deviceLinkRequestExpired"));
            return;
          }
          const status = await api.get<DeviceLinkStatusResponse>(`/api/device-links/${pendingLink.linkRequestId}/status`);
          if (cancelled) return;

          // "completed" without a session here means our completion's response was lost.
          const challengeNonce = status.status === "approved"
            ? status.challengeNonce
            : status.status === "completed" ? challengeNonces.current.get(pendingLink.linkRequestId) : null;
          if (challengeNonce) {
            saveRecoveryRetry({ ...pendingLink, challengeNonce, username });
            setLinkCompleting(true);
            const auth = await completeDeviceLink(
              pendingLink.linkRequestId,
              challengeNonce,
            );
            if (cancelled || cancelledLinks.current.has(pendingLink.linkRequestId)) return;

            await setLocalKeyOwner({ userId: auth.user.id, username: auth.user.username, deviceId: auth.device.id });
            if (cancelled) return;
            completedLinks.current.add(pendingLink.linkRequestId);
            clearRecoveryRetry();
            setRecoveryRetry(null);
            applyAuthResponse(auth);
            setPendingLink(null);
            navigate("/");
            return;
          }

          if (status.status === "expired" || status.status === "rejected") {
            clearRecoveryRetry();
            setRecoveryRetry(null);
            await resetLocalCryptoState().catch(() => undefined);
            setPendingLink(null);
            setError(status.status === "expired" ? localized("deviceLinkRequestExpired") : localized("deviceLinkRequestWasRejected"));
          }
        } catch (pollError: any) {
          if (pollError.status === 409 && /already completed/i.test(pollError.message ?? "") && completedLinks.current.has(pendingLink.linkRequestId)) return;
          if (!cancelled) {
            setError(toErrorMessage(pollError, "failedToCheckDeviceLinkStatus"));
          }
        } finally {
          pollInFlight.current = false;
          if (!cancelled) setLinkCompleting(false);
        }
      })();
    };
    retryPendingLink.current = poll;
    const interval = window.setInterval(poll, 1500);

    return () => {
      cancelled = true;
      retryPendingLink.current = null;
      window.clearInterval(interval);
    };
  }, [applyAuthResponse, completeDeviceLink, navigate, pendingLink, username]);

  const prefetchPasskeyOptions = useCallback(async (value: string) => {
    const normalizedUsername = value.trim();
    const deviceId = device?.id?.trim() ?? "";
    if (!capabilities.passkeys || !normalizedUsername || !deviceId) return;
    const cacheKey = JSON.stringify([normalizedUsername, deviceId]);
    if (prefetchedPasskeyOptions.current.has(cacheKey)) return;
    prefetchedPasskeyOptions.current.add(cacheKey);
    try {
      if (!await hasLocalKeyMaterial()) return;
      const { challengeId, options } = await api.post<PasskeyLoginOptionsResponse>(
        "/auth/passkey/login-options", { username: normalizedUsername, deviceId },
      );
      setCachedPasskeyOptions({ username: normalizedUsername, deviceId, challengeId, options, fetchedAt: Date.now() });
    } catch {
      // The button can still request fresh options when prefetch fails.
    }
  }, [device?.id]);

  useEffect(() => {
    // Read the input once after mount to include browser-autofilled usernames.
    const timer = window.setTimeout(() => {
      const value = usernameInput.current?.value ?? "";
      if (value) {
        setUsername(value);
        void prefetchPasskeyOptions(value);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [prefetchPasskeyOptions]);

  const loadFreshPasskeyOptions = async (normalizedUsername: string, deviceId: string): Promise<CachedPasskeyLoginOptions> => {
    const { challengeId, options } = await api.post<PasskeyLoginOptionsResponse>(
      "/auth/passkey/login-options",
      { username: normalizedUsername, deviceId },
    );
    const next = {
      username: normalizedUsername,
      deviceId,
      challengeId,
      options,
      fetchedAt: Date.now(),
    };
    setCachedPasskeyOptions(next);
    return next;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await performPasswordLogin(true, step === "setup", "recovery");
  };

  const performPasswordLogin = async (resumeRecovery = true, setupDevice = false, method: "recovery" | "approved_link" = "approved_link") => {
    if (submitting.current) return;
    submitting.current = true;
    setError(null);
    setLoading(true);

    let shouldResetLocalKeys = false;

    try {
      if (recoveryRetry && resumeRecovery) {
        const owner = await getLocalKeyOwner();
        if (owner && owner.username !== recoveryRetry.username) {
          setBlockedOwner(owner);
          return;
        }
        if (recoveryRetry.expiresAt <= Date.now()) {
          clearRecoveryRetry();
          setRecoveryRetry(null);
          throw new LocalizedError("deviceLinkRequestExpired");
        }
        if (username.trim() !== recoveryRetry.username) throw new LocalizedError("finishRecoveryAs", { username: recoveryRetry.username });
        await loadKeys(password);
        if (!mounted.current) return;
        const status = await api.get<DeviceLinkStatusResponse>(`/api/device-links/${recoveryRetry.linkRequestId}/status`);
        if (status.status === "expired" || status.status === "rejected") {
          clearRecoveryRetry();
          setRecoveryRetry(null);
          throw new LocalizedError(status.status === "expired" ? "deviceLinkRequestExpired" : "deviceLinkRequestWasRejected");
        }
        challengeNonces.current.set(recoveryRetry.linkRequestId, recoveryRetry.challengeNonce);
        // Showing the pending link exposes Cancel and starts the status poll. Hold both off until this
        // completion settles: Cancel wipes the keys the returned session belongs to.
        pollInFlight.current = true;
        setLinkCompleting(true);
        setPendingLink({ ...recoveryRetry, shortCode: null });
        let auth: AuthResponse;
        try {
          auth = await completeDeviceLink(recoveryRetry.linkRequestId, recoveryRetry.challengeNonce);
        } finally {
          pollInFlight.current = false;
          if (mounted.current) setLinkCompleting(false);
        }
        if (!mounted.current || cancelledLinks.current.has(recoveryRetry.linkRequestId)) return;
        await setLocalKeyOwner({ userId: auth.user.id, username: auth.user.username, deviceId: auth.device.id });
        completedLinks.current.add(recoveryRetry.linkRequestId);
        clearRecoveryRetry();
        setRecoveryRetry(null);
        setPendingLink(null);
        applyAuthResponse(auth);
        navigate("/");
        return;
      }
      const hasKeys = await hasLocalKeyMaterial();
      const owner = await getLocalKeyOwner();
      // The device id recorded with the keys wins: the auth store can lose its device (cleared
      // localStorage) or hold another one, and only a rejection of the keys' own device may wipe them.
      const deviceId = resolveLocalKeyDeviceId({
        owner,
        typedUsername: username,
        storedDevice: useAuthStore.getState().device,
      });
      const blockOtherOwner = () => {
        setBlockedOwner(owner);
      };
      if (decideLocalKeyAction({ hasKeys, owner, typedUsername: username, serverSaidUnknownDevice: false }) === "block-other-owner") {
        blockOtherOwner();
        return;
      }
      const canUseExistingDevice = !!deviceId && hasKeys;

      if (canUseExistingDevice) {
        let auth: AuthResponse | null = null;
        try {
          auth = await api.post<AuthResponse>("/auth/login", { username, password, deviceId });
        } catch (loginError: any) {
          if (!/Unknown device/i.test(loginError.message ?? "")) {
            throw loginError;
          }
        }
        if (auth) {
          await setLocalKeyOwner({ userId: auth.user.id, username: auth.user.username, deviceId: auth.device.id });
          // Local decryption does not make authenticated network calls.
          await loadKeys(password);
          applyAuthResponse(auth);
          navigate("/");
          return;
        }
      }

      // Wipe only when the server actually rejected this device. Without a device id we cannot
      // ask, so require the explicit "forget" confirmation instead of deleting usable keys.
      if (hasKeys && !canUseExistingDevice) {
        blockOtherOwner();
        return;
      }
      if (decideLocalKeyAction({ hasKeys, owner, typedUsername: username, serverSaidUnknownDevice: true }) === "block-other-owner") {
        blockOtherOwner();
        return;
      }

      // Choosing how to set up a device is explicit. Merely submitting credentials must never
      // generate or replace keys, nor start a link/recovery request.
      if (!setupDevice) {
        setStep("setup");
        setSetupMethod(null);
        return;
      }
      if (method === "recovery" && !recoveryKey.trim()) {
        setError(localized("enterYourRecoveryKey"));
        return;
      }

      await resetLocalCryptoState();
      useAuthStore.getState().logout({ forgetDevice: true });
      shouldResetLocalKeys = true;

      const deviceName = buildDefaultDeviceName(getLocale(), t("browser"));
      await initializeKeys(password);
      const bundle = buildDeviceLinkPublicBundle(deviceName);

      if (method === "recovery") {
        const recovery = await api.post<RecoverDeviceLinkResponse>("/api/device-links/recover", {
          username,
          password,
          recoveryKey,
          ...bundle,
        });
        shouldResetLocalKeys = false;
        let auth: AuthResponse;
        try {
          saveRecoveryRetry({ ...recovery, mode: "recovery", deviceName, username });
          auth = await completeDeviceLink(
            recovery.linkRequestId,
            recovery.challengeNonce,
          );
        } catch (completionError) {
          // The request is approved and bound to the keys just generated. Keep both and let the
          // status poll retry this same request instead of wiping the keys and starting over.
          setPendingLink({
            deviceName,
            linkRequestId: recovery.linkRequestId,
            shortCode: null,
            expiresAt: recovery.expiresAt,
            mode: "recovery",
          });
          throw completionError;
        }
        if (!mounted.current) return;
        await setLocalKeyOwner({ userId: auth.user.id, username: auth.user.username, deviceId: auth.device.id });
        completedLinks.current.add(recovery.linkRequestId);
        clearRecoveryRetry();
        setRecoveryRetry(null);
        applyAuthResponse(auth);
        navigate("/");
        return;
      }

      const start = await api.post<StartDeviceLinkResponse>("/api/device-links/start", {
        username,
        password,
        ...bundle,
      });
      shouldResetLocalKeys = false;
      setPendingLink({
        deviceName,
        linkRequestId: start.linkRequestId,
        shortCode: start.shortCode,
        expiresAt: start.expiresAt,
        mode: "approved_link",
      });
    } catch (submitError: any) {
      if (shouldResetLocalKeys) {
        await resetLocalCryptoState().catch(() => undefined);
      }
      setError(toErrorMessage(submitError, "loginFailed"));
    } finally {
      submitting.current = false;
      if (mounted.current) setLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    if (!capabilities.passkeys) {
      setError(toErrorMessage(new PasskeyUnsupportedError()));
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setError(null);
    setLoading(true);
    const deviceId = device?.id?.trim() ?? "";
    const normalizedUsername = username.trim();
    try {
      if (!deviceId || !await hasLocalKeyMaterial()) {
        setError(localized("passkeyLoginRequiresAPreviouslyLinkedDeviceOn"));
        return;
      }
      if (!normalizedUsername) {
        setError(localized("enterYourUsernameFirst"));
        return;
      }

      const loginOptions =
        cachedPasskeyOptions &&
        cachedPasskeyOptions.username === normalizedUsername &&
        cachedPasskeyOptions.deviceId === deviceId &&
        Date.now() - cachedPasskeyOptions.fetchedAt < PASSKEY_OPTIONS_MAX_AGE_MS
          ? cachedPasskeyOptions
          : await loadFreshPasskeyOptions(normalizedUsername, deviceId);
      const { challengeId, options } = loginOptions;

      const credential = await getPasskeyAssertion(options);

      const auth = await api.post<AuthResponse>("/auth/passkey/login", {
        challengeId,
        credential,
        username: normalizedUsername,
        deviceId,
      });

      lockLocalCryptoState();
      applyAuthResponse(auth);
      navigate("/");
    } catch (submitError: any) {
      if (submitError.name === "NotAllowedError") {
        if (normalizedUsername && deviceId) {
          await loadFreshPasskeyOptions(normalizedUsername, deviceId).catch(() => undefined);
        }
        setError(localized("passkeyAuthenticationWasCancelledOrDismissedCompleteThe"));
      } else {
        setError(toErrorMessage(submitError, "passkeyLoginFailed"));
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setLoading(false);
    }
  };

  const forgetLocalKeys = async () => {
    setLoading(true);
    setError(null);
    try {
      await resetLocalCryptoState();
      useAuthStore.getState().logout({ forgetDevice: true });
      setBlockedOwner(undefined);
      clearRecoveryRetry();
      setRecoveryRetry(null);
      await performPasswordLogin(false);
    } catch (forgetError: any) {
      setError(toErrorMessage(forgetError, "failedToForgetLocalKeys"));
    } finally {
      setLoading(false);
    }
  };

  const signInAsOwner = () => {
    clearRecoveryRetry();
    setRecoveryRetry(null);
    setUsername(blockedOwner?.username ?? "");
    setPassword("");
    setRecoveryKey("");
    setError(null);
    setBlockedOwner(undefined);
    setStep("sign-in");
    setSetupMethod(null);
  };

  const backToSignIn = () => {
    setStep("sign-in");
    setSetupMethod(null);
    setRecoveryKey("");
    setError(null);
  };

  const cancelLink = async () => {
    if (pollInFlight.current) return;
    const linkRequestId = pendingLink?.linkRequestId;
    if (linkRequestId) cancelledLinks.current.add(linkRequestId);
    try {
      await resetLocalCryptoState();
      clearRecoveryRetry();
      setRecoveryRetry(null);
      setPendingLink(null);
      setStep("setup");
      setSetupMethod(null);
      setRecoveryKey("");
    } catch (error: any) {
      if (linkRequestId) cancelledLinks.current.delete(linkRequestId);
      setError(toErrorMessage(error, "failedToCancelDeviceLink"));
    }
  };

  return {
    step,
    setupMethod,
    useRecoveryKey: () => { setSetupMethod("recovery"); setError(null); },
    approveFromAnotherDevice: () => performPasswordLogin(true, true, "approved_link"),
    backToSignIn,
    retryLink: () => retryPendingLink.current?.(),
    recoveryRetry,
    capabilities,
    passkeysSupported: capabilities.passkeys,
    signInAsOwner,
    cancelLink,
    forgetLocalKeys,
    username,
    setUsername,
    password,
    setPassword,
    recoveryKey,
    setRecoveryKey,
    error: error ? renderMessage(error) : "",
    loading,
    pendingLink,
    blockedOwner,
    linkCompleting,
    usernameInput,
    prefetchPasskeyOptions,
    handleSubmit,
    handlePasskeyLogin
  };
}
