import { localized, renderMessage, LocalizedError, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { t, useLocale, getLocale } from "../../i18n/index.js";
import { clearRecoveryRetry, readRecoveryRetry, saveRecoveryRetry } from "./recoveryRetry.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { MAX_ACTIVE_DEVICES } from "@e2ee-chat/shared";
import type {
  AuthResponse,
  DeviceLinkStatusResponse,
  DeviceLimitResponse,
  PasskeyLoginOptionsResponse,
  RecoverDeviceLinkResponse,
  StartDeviceLinkResponse,
} from "@e2ee-chat/shared";
import { useAuthStore } from "../../stores/authStore.js";
import {
  buildDeviceLinkPublicBundle,
  decideLocalKeyAction,
  getLocalKeyOwner,
  getLocalVaultKey,
  hasLocalKeyMaterial,
  initializeKeys,
  resolveLocalKeyDeviceId,
  keysLoaded,
  listLocalUnlockMethods,
  lockLocalCryptoState,
  loadKeys,
  resetLocalCryptoState,
  resetLocalDevice,
  setLocalKeyOwner,
  type LocalKeyOwner,
} from "../../lib/key-manager.js";
import { api } from "../../services/api.js";
import { readAuthStorage, readPersistedSession } from "../../services/session-identity.js";
import { sameLocalKey, type LocalKey } from "../../db/index.js";
import { buildDefaultDeviceName, signDeviceLinkCompletion } from "../../lib/device-link.js";
import type { UnlockMethod } from "../../lib/device-key-vault.js";
import {
  clearInterruptedPasskeySetup, clearPendingPasskeySetup, DeviceApprovalRequiredError,
  forgetSavedPasskeySetup, isInvalidSetupToken, PasskeySetupBusyError, passkeySetupDeviceLimit, preparePasskeyDeviceSetup,
  readPendingPasskeySetup, resumePasskeyDeviceSetup, type PasskeyReplacement, type ResumedSetupBackup,
} from "../../lib/passkey-provision.js";
import { signInWithNativePasskey } from "../../lib/native-passkeys.js";
import { getPasskeyAssertion, PasskeyUnsupportedError } from "../../lib/webauthn.js";
import { capabilities } from "../../platform/capabilities.js";
import { canUseNativeUnlock, isNativeEnrollmentUnsupported, isUnlockPromptCancelled, useNativeUnlockStatus } from "../../platform/biometric-unlock.js";
import { assertNotAborted } from "../../platform/native-wait.js";
import { waitForNativePasskeyHandoff } from "../../platform/passkeyHandoff.js";
import { clearRegisteredAccountState } from "../../platform/session-cleanup.js";
import { unlockMethodInfo } from "./unlockMethods.js";

interface PendingLinkState {
  deviceName: string;
  linkRequestId: string;
  shortCode: string | null;
  expiresAt: number;
  mode: "approved_link" | "recovery";
}

type PreparedSetup = Awaited<ReturnType<typeof preparePasskeyDeviceSetup>>;
type SetupAttempt = Awaited<ReturnType<PreparedSetup["authorize"]>>;
type ExistingPasskeyDevice = {
  deviceId: string;
  vaultKey: LocalKey;
  session: ReturnType<typeof useAuthStore.getState>;
  authStorage: string | null;
};
type ExistingPasskeyOptions = PasskeyLoginOptionsResponse & { device: ExistingPasskeyDevice };

export const PASSKEY_OPTIONS_REFRESH_MS = 4 * 60_000;

function isUnknownPasskeyDevice(error: unknown): boolean {
  const response = error as { status?: number; body?: { error?: string } } | undefined;
  return response?.status === 401 && response.body?.error === "Unknown device";
}

function availableUnlockMethods(methods: UnlockMethod[]) {
  return methods.filter(method => method === "password" || (
    method === "passkey" ? capabilities.passkeys : canUseNativeUnlock()
  ));
}

export function useLoginFlow() {
  useLocale();
  useNativeUnlockStatus();
  const location = useLocation();
  const [recoveryRetry, setRecoveryRetry] = useState(readRecoveryRetry);
  const submitting = useRef(false);
  const setupAttempt = useRef<SetupAttempt | null>(null);
  const preparedSetup = useRef<PreparedSetup | null>(null);
  const entryOptions = useRef<ExistingPasskeyOptions | undefined>(undefined);
  const optionsPreparedAt = useRef<number | undefined>(undefined);
  const preparationTimedOut = useRef(false);
  const preparingOptions = useRef<AbortController | undefined>(undefined);
  const preparation = useRef<Promise<boolean> | undefined>(undefined);
  const autofill = useRef<AbortController | undefined>(undefined);
  const nativeCeremony = useRef<AbortController | undefined>(undefined);
  const nativeUnlockAttempt = useRef<{ controller: AbortController; task: Promise<void> } | undefined>(undefined);
  const [nativeUnlockPending, setNativeUnlockPending] = useState(false);
  const webCeremony = useRef<AbortController | undefined>(undefined);
  const ceremonyTask = useRef<Promise<void> | undefined>(undefined);
  const [entryState, setEntryState] = useState<"ready" | "preparing" | "failed" | "offline" | "other-tab" | "moved" | "unavailable" | null>(null);
  const [revokedVault, setRevokedVault] = useState<ExistingPasskeyDevice>();
  const [confirmForgetRevokedVault, setConfirmForgetRevokedVault] = useState(false);
  const setupChannel = useRef<BroadcastChannel | undefined>(undefined);
  const [passkeyGesture, setPasskeyGesture] = useState(false);
  const [nativeStage, setNativeStage] = useState<"browser" | "redeeming" | null>(null);
  const [nativeRestarting, setNativeRestarting] = useState(false);
  const nativeRestart = useRef<AbortController | undefined>(undefined);
  const [nativeHidden, setNativeHidden] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [setupScreen, setSetupScreen] = useState<"progress" | "unlock" | "backup" | "activation" | null>(null);
  const [resumedBackup, setResumedBackup] = useState<ResumedSetupBackup>();
  const [approvalUsername, setApprovalUsername] = useState<string>();
  const [passwordOnly, setPasswordOnly] = useState(false);
  const [passkeySetupPrepared, setPasskeySetupPrepared] = useState(false);
  const [passkeySetupProblem, setPasskeySetupProblem] = useState<{ error: string; canContinue?: boolean }>();
  const [passkeyDeviceLimit, setPasskeyDeviceLimit] = useState<DeviceLimitResponse>();
  const [savedPasskeySetupId, setSavedPasskeySetupId] = useState<string>();
  const [forgetSavedSetupId, setForgetSavedSetupId] = useState<string>();
  const [passkeyPasswordRequired, setPasskeyPasswordRequired] = useState(false);
  const [savedMethods, setSavedMethods] = useState<UnlockMethod[]>([]);
  const resumeMethods = availableUnlockMethods(savedMethods);
  useEffect(() => {
    let active = true;
    void readPendingPasskeySetup().then(async (record) => {
      if (record?.stage === "unlockReady" || record?.stage === "complete") {
        if (active) {
          const methods = await listLocalUnlockMethods().catch(() => []);
          if (!active) return;
          setSavedPasskeySetupId(record.setupId);
          setSavedMethods(methods);
        }
      } else if (record && active) {
        if (await clearInterruptedPasskeySetup() && active) setInterrupted(true);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  useEffect(() => () => {
    autofill.current?.abort();
    preparingOptions.current?.abort();
    webCeremony.current?.abort();
    nativeCeremony.current?.abort();
    nativeUnlockAttempt.current?.controller.abort();
    nativeRestart.current?.abort();
    setupAttempt.current?.discard();
    void preparedSetup.current?.discard().catch(() => undefined);
  }, []);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [username, setUsername] = useState(recoveryRetry?.username ?? (location.state as { username?: string } | null)?.username ?? "");
  const passkeyApproval = approvalUsername !== undefined && approvalUsername === username.trim();
  const changeUsername = (value: string) => {
    setUsername(value);
    if (value.trim() !== approvalUsername) setApprovalUsername(undefined);
  };
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [step, setStep] = useState<"sign-in" | "setup">("sign-in");
  const [setupMethod, setSetupMethod] = useState<"recovery" | null>(null);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingLink, setPendingLink] = useState<PendingLinkState | null>(null);
  const [blockedOwner, setBlockedOwner] = useState<LocalKeyOwner | null | undefined>(undefined);
  const [linkCompleting, setLinkCompleting] = useState(false);
  const pollInFlight = useRef(false);
  const limitPausedLink = useRef<string | undefined>(undefined);
  const retryPendingLink = useRef<(() => void) | null>(null);
  const completionRequests = useRef(new Map<string, Promise<AuthResponse>>());
  const completedLinks = useRef(new Set<string>());
  // Cancelling wipes the keys a request is bound to; a completion that settles later must not sign in.
  const cancelledLinks = useRef(new Set<string>());
  // The status endpoint stops returning the nonce once a request is completed.
  const challengeNonces = useRef(new Map<string, string>());
  const usernameInput = useRef<HTMLInputElement>(null);
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
        if (completeError?.status === 409 && completeError.body?.error === "device_limit_reached") {
          limitPausedLink.current = linkRequestId;
          throw new LocalizedError("passkeySetup.errorDeviceLimitNoRecovery", { limit: MAX_ACTIVE_DEVICES });
        }
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
    const poll = (manual = false) => {
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
          if (!manual && limitPausedLink.current === pendingLink.linkRequestId) return;
          if (manual) setError(null);
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
    retryPendingLink.current = () => poll(true);
    const interval = window.setInterval(poll, 1500);

    return () => {
      cancelled = true;
      retryPendingLink.current = null;
      window.clearInterval(interval);
    };
  }, [applyAuthResponse, completeDeviceLink, navigate, pendingLink, username]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const value = usernameInput.current?.value;
      if (value) setUsername(value);
    }, 300);
    return () => window.clearTimeout(timer);
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    autofill.current?.abort();
    await performPasswordLogin(true, step === "setup" || passkeyApproval, step === "setup" ? "recovery" : "approved_link");
  };

  const discardPreparedPasskeyEntry = async () => {
    autofill.current?.abort();
    preparingOptions.current?.abort();
    await preparation.current;
    const prepared = preparedSetup.current;
    preparedSetup.current = null;
    entryOptions.current = undefined;
    optionsPreparedAt.current = undefined;
    setPasskeySetupPrepared(false);
    setEntryState(null);
    await prepared?.discard();
  };

  const passkeyDeviceId = async () => {
    const owner = await getLocalKeyOwner();
    return resolveLocalKeyDeviceId({
      owner, typedUsername: owner?.username ?? "", storedDevice: useAuthStore.getState().device,
    });
  };

  const readExistingPasskeyDevice = async (): Promise<ExistingPasskeyDevice | undefined> => {
    const session = useAuthStore.getState();
    const authStorage = readAuthStorage();
    const persisted = readPersistedSession(authStorage);
    if (persisted && ((persisted.sessionId ?? null) !== (session.sessionId ?? null) ||
      (persisted.user?.id ?? null) !== (session.user?.id ?? null) ||
      (persisted.device?.id ?? null) !== (session.device?.id ?? null))) return undefined;
    const vaultKey = await getLocalVaultKey();
    const deviceId = await passkeyDeviceId();
    return vaultKey && deviceId ? { deviceId, vaultKey, session, authStorage } : undefined;
  };
  const isInitialLoginSession = (device: ExistingPasskeyDevice) =>
    mounted.current && useAuthStore.getState() === device.session && readAuthStorage() === device.authStorage;
  const isCurrentPasskeyDevice = async (device: ExistingPasskeyDevice, signal: AbortSignal) =>
    !signal.aborted && isInitialLoginSession(device) && await passkeyDeviceId() === device.deviceId &&
    sameLocalKey(await getLocalVaultKey(), device.vaultKey) && !signal.aborted && isInitialLoginSession(device);
  const markRevokedPasskeyVault = async (device: ExistingPasskeyDevice, signal: AbortSignal) => {
    const owner = await getLocalKeyOwner();
    if (!await isCurrentPasskeyDevice(device, signal)) return;
    if (owner?.deviceId !== device.deviceId) {
      setEntryState("unavailable");
      setBlockedOwner(owner);
      return;
    }
    setRevokedVault(device);
    setEntryState(null);
  };

  const performPasswordLogin = async (resumeRecovery = true, setupDevice = false, method: "recovery" | "approved_link" = "approved_link") => {
    if (submitting.current) return;
    submitting.current = true;
    setError(null);
    setLoading(true);

    let newVaultId: string | undefined;

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
          if ((await listLocalUnlockMethods()).includes("password")) await loadKeys(password);
          else lockLocalCryptoState();
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
        await discardPreparedPasskeyEntry();
        setStep("setup");
        setSetupMethod(null);
        return;
      }
      if (method === "recovery" && !recoveryKey.trim()) {
        setError(localized("enterYourRecoveryKey"));
        return;
      }

      await discardPreparedPasskeyEntry();
      if (hasKeys) await resetLocalCryptoState();
      useAuthStore.getState().logout({ forgetDevice: true });
      newVaultId = crypto.randomUUID();

      const deviceName = buildDefaultDeviceName();
      await initializeKeys(password, newVaultId);
      const bundle = buildDeviceLinkPublicBundle(deviceName);

      if (method === "recovery") {
        const recovery = await api.post<RecoverDeviceLinkResponse>("/api/device-links/recover", {
          username,
          password,
          recoveryKey,
          ...bundle,
        });
        newVaultId = undefined;
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
      newVaultId = undefined;
      setPendingLink({
        deviceName,
        linkRequestId: start.linkRequestId,
        shortCode: start.shortCode,
        expiresAt: start.expiresAt,
        mode: "approved_link",
      });
    } catch (submitError: any) {
      if (newVaultId) {
        await resetLocalCryptoState(undefined, newVaultId).catch(() => undefined);
      }
      setError(toErrorMessage(submitError, "loginFailed"));
    } finally {
      submitting.current = false;
      if (mounted.current) setLoading(false);
    }
  };

  const showSavedPasskeySetup = async () => {
    const record = await readPendingPasskeySetup();
    const durable = record?.stage === "unlockReady" || record?.stage === "complete";
    setSavedPasskeySetupId(durable ? record.setupId : undefined);
    setSavedMethods(durable ? await listLocalUnlockMethods().catch(() => []) : []);
  };

  const applyPasskeySetup = async (auth: AuthResponse, setupId: string) => {
    if (!mounted.current) return;
    setupAttempt.current = null;
    setResumedBackup(undefined);
    setPasskeyDeviceLimit(undefined);
    setPasskeySetupProblem(undefined);
    setSavedPasskeySetupId(undefined);
    setSavedMethods([]);
    setPasskeyPasswordRequired(false);
    setSetupScreen(null);
    setPassword("");
    applyAuthResponse(auth);
    navigate("/", { state: { passkeySetup: auth.device } });
    await clearPendingPasskeySetup(setupId).catch(() => undefined);
  };

  const finishPasskeySetup = async (attempt: NonNullable<typeof setupAttempt.current>, fallback?: string) => {
    try {
      const auth = await attempt.complete(fallback);
      await applyPasskeySetup(auth, attempt.setupId);
    } catch (err) {
      if (err instanceof DeviceApprovalRequiredError) {
        await returnToSavedSetup(attempt);
        throw err;
      }
      if ((err as Error)?.name === "KeysLockedError" && !attempt.canUsePasswordFallback()) {
        await returnToSavedSetup(attempt);
        throw new LocalizedError("failedToUnlockThisDevice");
      }
      const reason = (err as { body?: { error?: string } }).body?.error;
      if (reason === "unknown_credential" && !attempt.canUsePasswordFallback()) {
        await returnToSavedSetup(attempt);
        throw err;
      }
      if (isInvalidSetupToken(err) && !attempt.canUsePasswordFallback()) {
        await returnToSavedSetup(attempt);
        return;
      }
      if (reason === "setup_expired" || reason === "setup_already_active" || reason === "setup_revoked") {
        if (reason === "setup_expired") await resetLocalCryptoState(attempt.setupId);
        else await clearPendingPasskeySetup(attempt.setupId);
        await returnToSavedSetup(attempt);
      }
      throw err;
    }
  };

  const returnToSavedSetup = async (attempt: SetupAttempt | null = null) => {
    attempt?.discard();
    setupAttempt.current = null;
    setResumedBackup(undefined);
    setSetupScreen(null);
    setPasskeyPasswordRequired(false);
    setPasskeyDeviceLimit(undefined);
    setPassword("");
    await showSavedPasskeySetup();
  };

  const cancelPasskeySetup = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setApprovalUsername(undefined);
    setLoading(true);
    const attempt = setupAttempt.current;
    const prepared = preparedSetup.current;
    setupAttempt.current = null;
    preparedSetup.current = null;
    setResumedBackup(undefined);
    setPasskeySetupPrepared(false);
    setSetupScreen(null);
    setPasswordOnly(false);
    setPasskeySetupProblem(undefined);
    setPasskeyPasswordRequired(false);
    setPasskeyDeviceLimit(undefined);
    setPassword("");
    setError(null);
    try {
      if (attempt?.canUsePasswordFallback()) await attempt.abandon();
      else attempt?.discard();
      await prepared?.discard();
    } catch {
      // Local ownership is released even if the server could not be reached.
      attempt?.discard();
    } finally {
      if (mounted.current) await showSavedPasskeySetup().catch(() => undefined);
      submitting.current = false;
      if (mounted.current) setLoading(false);
    }
  };

  const handlePasskeySetupError = (error: unknown) => {
    const body = (error as { body?: { error?: unknown; canContinue?: unknown; retryAfter?: unknown } })?.body;
    setPasskeySetupProblem(error instanceof DeviceApprovalRequiredError ? { error: "approval_required" }
      : typeof body?.error === "string" ? {
        error: body.error,
        ...(typeof body.canContinue === "boolean" ? { canContinue: body.canContinue } : {}),
      } : undefined);
    const limit = passkeySetupDeviceLimit(error);
    if (limit) {
      setPasskeyDeviceLimit(limit);
      setPasskeyPasswordRequired(false);
      setError(null);
      return;
    }
    if (body?.error === "limit_ticket_expired" && (savedPasskeySetupId ||
      (setupAttempt.current?.pending && !setupAttempt.current.canUsePasswordFallback()))) {
      setPasskeyDeviceLimit(current => current && { ...current, limitTicket: null });
    }
    if (setupAttempt.current?.closed) {
      setupAttempt.current = null;
      setSetupScreen(null);
      setPasskeyPasswordRequired(false);
    }
    if (error instanceof DeviceApprovalRequiredError) {
      setApprovalUsername(error.username);
      if (error.username) setUsername(error.username);
    }
    if (error instanceof LocalizedError && error.localizedMessage.key === "nativePasskeyUnsupported") setNativeHidden(true);
    if (error instanceof LocalizedError && error.localizedMessage.key === "nativePasskeyCancelled") return;
    if ((error as Error)?.name === "NotAllowedError") { setError(localized("passkeySetup.errorNotFinished")); return; }
    if (body?.error === "unknown_credential") { setError(localized("passkeySetup.errorUnknownCredential")); return; }
    if (body?.error === "device_capacity_changed") {
      setPasskeyDeviceLimit(undefined);
      setError(localized("passkeySetup.finishFailed"));
      return;
    }
    if (body?.error === "uv_required") { setError(localized("passkeySetup.errorUvRequired")); return; }
    if (nativeStage === "redeeming" && body?.error === "Invalid or expired code") {
      setError(localized("passkeySetup.browserTimeoutStart"));
      return;
    }
    if (body?.error === "setup_expired") { setError(localized("passkeySetup.setupExpired")); return; }
    if (typeof body?.retryAfter === "number" && body.retryAfter > 0) {
      const time = new Intl.NumberFormat(getLocale(), { style: "unit", unit: "minute", unitDisplay: "short" }).format(Math.ceil(body.retryAfter / 60));
      setError(localized("passkeySetup.errorRateLimited", { time }));
      return;
    }
    if (body?.error === "invalid_password") { setError(localized("thatPasswordIsNotCorrect")); return; }
    setError(error instanceof DeviceApprovalRequiredError
      ? localized("approveFromAnotherDevice") : toErrorMessage(error, "passkeyLoginFailed"));
  };

  const resumePasskeySetup = async (
    method: UnlockMethod, fallback?: string, replacement?: PasskeyReplacement, signal?: AbortSignal, onLocalUnlock?: () => void,
  ) => {
    const record = await readPendingPasskeySetup();
    try {
      const result = signal ? await resumePasskeyDeviceSetup(method, fallback, replacement, signal, onLocalUnlock)
        : await resumePasskeyDeviceSetup(method, fallback, replacement);
      assertNotAborted(signal);
      if ("backupMethod" in result) {
        if (!mounted.current) return;
        setResumedBackup(result);
        setSetupScreen("backup");
        setPasskeyDeviceLimit(undefined);
        setPasskeyPasswordRequired(false);
        setPassword("");
      } else if (record) await applyPasskeySetup(result, record.setupId);
    } catch (err) {
      if (!signal?.aborted) await showSavedPasskeySetup();
      throw err;
    }
  };

  const runPasskeySetup = async (operation: () => Promise<void>) => {
    if (submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setError(null);
    setPasskeySetupProblem(undefined);
    try { await operation(); }
    catch (err) { if (mounted.current) handlePasskeySetupError(err); }
    finally { submitting.current = false; if (mounted.current) setLoading(false); }
  };

  const runNativeSetupUnlock = (operation: (signal: AbortSignal, onLocalUnlock: () => void) => Promise<void>) => {
    if (submitting.current) return;
    const controller = new AbortController();
    const endTakeover = () => {
      if (nativeUnlockAttempt.current?.controller !== controller) return;
      nativeUnlockAttempt.current = undefined;
      if (mounted.current) setNativeUnlockPending(false);
    };
    const task = runPasskeySetup(async () => {
      try { await operation(controller.signal, endTakeover); }
      catch (error) { if (!controller.signal.aborted) throw error; }
    });
    nativeUnlockAttempt.current = { controller, task };
    setNativeUnlockPending(true);
    return task.finally(endTakeover);
  };

  const runSetupWithUnlock = async (
    method: UnlockMethod | undefined, operation: (signal?: AbortSignal, onLocalUnlock?: () => void) => Promise<void>,
  ) => {
    if (method === "native") return runNativeSetupUnlock(operation);
    const native = nativeUnlockAttempt.current;
    if (method === "password" && native) {
      native.controller.abort();
      await native.task;
    }
    return runPasskeySetup(() => operation());
  };

  const completePasskeySetupWithPassword = (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    return runSetupWithUnlock("password", async () => {
      if (setupAttempt.current) await finishPasskeySetup(setupAttempt.current, password);
      else if (resumeMethods.includes("password")) await resumePasskeySetup("password", password);
    });
  };

  const resumePasskeyUnlock = (method: UnlockMethod, password?: string) =>
    runSetupWithUnlock(method, (signal, onLocalUnlock) => resumePasskeySetup(method, password, undefined, signal, onLocalUnlock));
  const continuePasskeySetup = async (attempt: NonNullable<typeof setupAttempt.current>) => {
    if (!mounted.current) { attempt.discard(); return; }
    setupAttempt.current = attempt;
    if (attempt.deviceLimit) {
      setPasskeyDeviceLimit(attempt.deviceLimit);
      setPasskeyPasswordRequired(false);
      return;
    }
    if (attempt.authorizationError) {
      setSetupScreen("progress");
      throw attempt.authorizationError;
    }
    setPasskeyDeviceLimit(undefined);
    if (attempt.canUsePasswordFallback()) {
      setSetupScreen("progress");
      setPasswordOnly(false);
      if (attempt.method === "passkey" && attempt.pending) {
        await attempt.persistUnlock();
        if (mounted.current) setSetupScreen("unlock");
      }
    } else if (attempt.backupPending) await returnToSavedSetup(attempt);
    else await finishPasskeySetup(attempt);
  };

  const beginUnlockSetup = () => {
    setSetupScreen("unlock");
    setPasskeyPasswordRequired(passwordOnly || setupAttempt.current?.method === "password");
  };
  const enrollPasskeySetupUnlock = () => {
    const attempt = setupAttempt.current;
    if (!attempt) return;
    const enroll = async (signal?: AbortSignal) => {
      if (attempt.method !== "passkey") {
        try { await attempt.persistUnlock(undefined, signal); }
        catch (err) {
          if (signal?.aborted || isUnlockPromptCancelled(err)) return;
          if (isNativeEnrollmentUnsupported(err) && attempt.canUsePasswordFallback()) {
            setPasswordOnly(true);
            setPasskeyPasswordRequired(true);
            setError(localized("security.nativeEnrollmentUnsupported", { method: unlockMethodInfo("native").name }));
            return;
          }
          throw err;
        }
      }
      if (!signal?.aborted) setSetupScreen("backup");
    };
    return attempt.method === "native" ? runNativeSetupUnlock(enroll) : runPasskeySetup(() => enroll());
  };
  const handleBackupSetupFailure = async (err: unknown, attempt: SetupAttempt | null) => {
    const reason = (err as { body?: { error?: string } }).body?.error;
    const name = (err as Error)?.name;
    if (isInvalidSetupToken(err) || reason === "setup_expired" || reason === "unknown_credential" ||
      reason === "setup_revoked" || reason === "setup_already_active" || err instanceof DeviceApprovalRequiredError ||
      name === "KeysLockedError" || name === "StalePasskeySetupError") {
      await returnToSavedSetup(attempt);
      if (isInvalidSetupToken(err) || (attempt && reason === "setup_expired")) return;
      if (name === "KeysLockedError") throw new LocalizedError("failedToUnlockThisDevice");
    }
    throw err;
  };
  const finishBackupActivation = async () => {
    const attempt = setupAttempt.current;
    if (attempt) await finishPasskeySetup(attempt);
    else if (resumedBackup) {
      try { await applyPasskeySetup(await resumedBackup.complete(), resumedBackup.setupId); }
      catch (err) {
        if (passkeySetupDeviceLimit(err)) await returnToSavedSetup();
        await handleBackupSetupFailure(err, null);
      }
    }
  };
  const finishWithBackupPassword = (backup?: string) => runPasskeySetup(async () => {
    const attempt = setupAttempt.current;
    try {
      if (attempt) await attempt.chooseBackupPassword(backup);
      else if (resumedBackup) await resumedBackup.chooseBackupPassword(backup);
      else return;
    } catch (err) { await handleBackupSetupFailure(err, attempt); return; }
    setPassword("");
    setSetupScreen("activation");
    await finishBackupActivation();
  });

  const prepareFreshPasskeySetup = () => runPasskeySetup(async () => {
    if (preparedSetup.current || setupAttempt.current || savedPasskeySetupId) return;
    const startedAt = Date.now();
    const prepared = await preparePasskeyDeviceSetup(buildDefaultDeviceName());
    if (!mounted.current) { await prepared.discard(); return; }
    preparedSetup.current = prepared;
    optionsPreparedAt.current = startedAt;
    setPasskeySetupPrepared(true);
  });

  const authorizePreparedPasskeySetup = (assertion?: Awaited<ReturnType<NonNullable<typeof preparedSetup.current>["requestAutofill"]>>) => runPasskeySetup(async () => {
    const prepared = preparedSetup.current;
    if (!prepared) return;
    setApprovalUsername(undefined);
    autofill.current?.abort();
    preparedSetup.current = null;
    setEntryState(null);
    setPasskeySetupPrepared(false);
    const controller = new AbortController();
    nativeCeremony.current = controller;
    try {
      const attempt = await prepared.authorize({ assertion, signal: controller.signal, onHandoff: setNativeStage });
      if (controller.signal.aborted) { attempt.discard(); return; }
      // Ambiguous native redeem errors keep the controller available for an exact retry.
      if (capabilities.nativePasskeyProvisioning && attempt.authorizationError && !attempt.deviceLimit) {
        setupAttempt.current = attempt;
        return;
      }
      await continuePasskeySetup(attempt);
    } catch (err) {
      if (!controller.signal.aborted) throw err;
    } finally {
      nativeCeremony.current = undefined;
      if (!setupAttempt.current?.authorizationError || setupAttempt.current.deviceLimit) setNativeStage(null);
    }
  });

  const preparePasskeyEntry = (refresh = false): Promise<boolean> => {
    if (!capabilities.passkeys && !capabilities.nativePasskeys) return Promise.resolve(false);
    if (preparation.current) return preparation.current;
    if (submitting.current || setupAttempt.current || savedPasskeySetupId || nativeHidden || revokedVault) return Promise.resolve(false);
    preparationTimedOut.current = false;
    setPasskeyGesture(false);
    setEntryState("preparing");
    const controller = new AbortController();
    const startedAt = Date.now();
    preparingOptions.current = controller;
    const operation = (async () => {
      try {
        if (navigator.onLine === false) { setEntryState("offline"); return false; }
        if (refresh) {
          autofill.current?.abort();
          await preparedSetup.current?.discard();
          preparedSetup.current = null;
          entryOptions.current = undefined;
          optionsPreparedAt.current = undefined;
          setPasskeySetupPrepared(false);
        }
        const record = await readPendingPasskeySetup();
        if (record?.stage === "unlockReady" || record?.stage === "complete") {
          if (mounted.current) {
            await showSavedPasskeySetup();
            setEntryState(null);
          }
          return false;
        }
        if (await hasLocalKeyMaterial()) {
          const device = await readExistingPasskeyDevice();
          if (!device) { setEntryState("unavailable"); return false; }
          if (!capabilities.nativePasskeys && (!entryOptions.current || refresh)) {
            try {
              const options = await api.post<PasskeyLoginOptionsResponse>("/auth/passkey/login-options",
                { deviceId: device.deviceId }, { signal: controller.signal });
              if (!await isCurrentPasskeyDevice(device, controller.signal)) return false;
              entryOptions.current = { ...options, device };
            } catch (error) {
              if (!isUnknownPasskeyDevice(error)) throw error;
              await markRevokedPasskeyVault(device, controller.signal);
              return false;
            }
            optionsPreparedAt.current = startedAt;
          }
        } else {
          if (!capabilities.passkeys && !capabilities.nativePasskeyProvisioning) {
            setNativeHidden(true);
            setEntryState(null);
            setError(localized("nativePasskeyUnsupported"));
            return false;
          }
          if (!preparedSetup.current) {
            const prepared = await preparePasskeyDeviceSetup(buildDefaultDeviceName(), controller.signal);
            if (!mounted.current || submitting.current || controller.signal.aborted) { await prepared.discard(); return false; }
            preparedSetup.current = prepared;
            optionsPreparedAt.current = startedAt;
          }
          setPasskeySetupPrepared(true);
        }
        if (!mounted.current) return false;
        if (preparationTimedOut.current) return false;
        setEntryState("ready");
        return true;
      } catch (err) {
        if (!mounted.current || preparationTimedOut.current || controller.signal.aborted) return false;
        if (err instanceof PasskeySetupBusyError) { setEntryState("other-tab"); return false; }
        if ((err as { status?: number; body?: { error?: string } })?.status === 404 &&
          (err as { body?: { error?: string } }).body?.error === "No passkeys registered") {
          setEntryState("unavailable");
          return false;
        }
        setEntryState(navigator.onLine === false || err instanceof TypeError || (err as { status?: number })?.status === 0 ? "offline" : "failed");
        return false;
      }
    })().finally(() => { preparation.current = undefined; preparingOptions.current = undefined; });
    preparation.current = operation;
    return operation;
  };

  const signInWithPreparedDevice = (options: ExistingPasskeyOptions, assertion?: Awaited<ReturnType<typeof getPasskeyAssertion>>) =>
    runPasskeySetup(async () => {
      autofill.current?.abort();
      entryOptions.current = undefined;
      setEntryState(null);
      const controller = new AbortController();
      webCeremony.current = controller;
      const { device } = options;
      try {
        const credential = assertion ?? await getPasskeyAssertion(options.options, { signal: controller.signal });
        if (!await isCurrentPasskeyDevice(device, controller.signal)) return;
        const auth = await api.post<AuthResponse>("/auth/passkey/login", {
          credential, deviceId: device.deviceId, challengeId: options.challengeId,
        }, { signal: controller.signal });
        if (auth.device.id !== device.deviceId || !await isCurrentPasskeyDevice(device, controller.signal)) return;
        lockLocalCryptoState();
        applyAuthResponse(auth);
        navigate("/");
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!isUnknownPasskeyDevice(error)) throw error;
        await markRevokedPasskeyVault(device, controller.signal);
      } finally { webCeremony.current = undefined; }
    });

  const entryOptionsAreStale = () => optionsPreparedAt.current !== undefined &&
    Date.now() - optionsPreparedAt.current >= PASSKEY_OPTIONS_REFRESH_MS;

  const startPasskeyAutofill = () => {
    const prepared = preparedSetup.current;
    const existing = entryOptions.current;
    const controller = new AbortController();
    autofill.current = controller;
    void (async () => {
      if (!await globalThis.PublicKeyCredential?.isConditionalMediationAvailable?.() || controller.signal.aborted || submitting.current) return;
      if (entryOptionsAreStale()) { void preparePasskeyEntry(true); return; }
      const { signal } = controller;
      if (prepared?.requestAutofill) {
        const assertion = await prepared.requestAutofill(signal);
        if (assertion && !signal.aborted) await authorizePreparedPasskeySetup(assertion);
      } else if (existing) {
        const assertion = await getPasskeyAssertion({ ...existing.options, allowCredentials: [] }, { signal, mediation: "conditional" });
        if (!signal.aborted) await signInWithPreparedDevice(existing, assertion);
      }
    })().catch(() => undefined);
    return () => controller.abort();
  };

  const handlePasskeyEntry = async () => {
    if (!capabilities.passkeys && !capabilities.nativePasskeys) {
      setError(toErrorMessage(new PasskeyUnsupportedError()));
      return;
    }
    autofill.current?.abort();
    if (navigator.onLine === false && !setupAttempt.current) { setEntryState("offline"); return; }
    if (setupAttempt.current) return retryPasskeySetup();
    if (submitting.current) return;
    const stale = entryOptionsAreStale();
    if (stale || (!preparedSetup.current && !entryOptions.current && (!capabilities.nativePasskeys || entryState !== "ready"))) {
      let timer: number | undefined;
      const ready = await Promise.race([preparePasskeyEntry(stale), new Promise<false>(resolve => {
        timer = window.setTimeout(() => {
          setEntryState("failed");
          preparationTimedOut.current = true;
          preparingOptions.current?.abort();
          resolve(false);
        }, 3000);
      })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      if (!ready || entryOptionsAreStale()) return;
      if (/AppleWebKit/i.test(navigator.userAgent) && /Version\/[\d.]+.*Safari|iPhone|iPad|iPod/i.test(navigator.userAgent)
        && !capabilities.nativePasskeys) { setPasskeyGesture(true); return; }
    }
    setPasskeyGesture(false);
    const options = entryOptions.current;
    if (options) return signInWithPreparedDevice(options);
    if (preparedSetup.current) {
      const task = authorizePreparedPasskeySetup();
      ceremonyTask.current = task;
      try { await task; } finally { if (ceremonyTask.current === task) ceremonyTask.current = undefined; }
      return;
    }
    if (capabilities.nativePasskeys) {
      const task = runPasskeySetup(async () => {
        const controller = new AbortController();
        nativeCeremony.current = controller;
        try {
          const device = await readExistingPasskeyDevice();
          if (!device || !await isCurrentPasskeyDevice(device, controller.signal)) return;
          const { deviceId } = device;
          try {
            const auth = await signInWithNativePasskey(deviceId, { signal: controller.signal, onHandoff: setNativeStage });
            if (auth.device.id !== deviceId || !await isCurrentPasskeyDevice(device, controller.signal)) return;
            lockLocalCryptoState();
            applyAuthResponse(auth);
            navigate("/");
          } catch (error) {
            if (!await isCurrentPasskeyDevice(device, controller.signal)) return;
            if (!isUnknownPasskeyDevice(error)) throw error;
            // Redeem also returns Unknown device for a passkey from another account.
            try {
              await api.post("/auth/passkey/login-options", { deviceId }, { signal: controller.signal });
            } catch (failure) {
              if (isUnknownPasskeyDevice(failure)) {
                await markRevokedPasskeyVault(device, controller.signal);
                return;
              }
            }
            if (!controller.signal.aborted) throw new LocalizedError("passkeyLoginFailed");
          }
        } finally { nativeCeremony.current = undefined; setNativeStage(null); }
      });
      ceremonyTask.current = task;
      try { await task; } finally { if (ceremonyTask.current === task) ceremonyTask.current = undefined; }
    }
  };

  const cancelNativeHandoff = async (restart = false) => {
    if (nativeRestart.current) {
      if (!restart) nativeRestart.current.abort();
      return;
    }
    const controller = restart ? new AbortController() : undefined;
    nativeRestart.current = controller;
    if (controller) setNativeRestarting(true);
    nativeCeremony.current?.abort();
    try {
      await ceremonyTask.current;
      setNativeStage(null);
      await cancelPasskeySetup();
      if (controller) {
        await waitForNativePasskeyHandoff(controller.signal);
        assertNotAborted(controller.signal);
        setNativeRestarting(false);
        nativeRestart.current = undefined;
        if (mounted.current && await preparePasskeyEntry(true)) await handlePasskeyEntry();
      }
    } catch (error) {
      if (controller?.signal.aborted) return;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        if (mounted.current) setError(localized("passkeySetup.browserTimeout"));
        return;
      }
      throw error;
    } finally {
      if (nativeRestart.current === controller) {
        nativeRestart.current = undefined;
        setNativeRestarting(false);
      }
    }
  };

  const moveSetupAway = useRef<() => Promise<boolean>>(async () => false);
  const retryFromTakeover = useRef(() => preparePasskeyEntry(true));
  retryFromTakeover.current = () => preparePasskeyEntry(true);
  moveSetupAway.current = async () => {
    if (!preparation.current && !preparedSetup.current && !setupAttempt.current && !nativeCeremony.current) return false;
    if (submitting.current && !ceremonyTask.current) return false;
    preparingOptions.current?.abort();
    await preparation.current;
    await cancelNativeHandoff();
    if (mounted.current) setEntryState("moved");
    return true;
  };
  const takeoverRequested = useRef(false);
  const takeoverTimer = useRef<number | undefined>(undefined);
  const requestSetupTakeover = async () => {
    if (takeoverRequested.current) return;
    takeoverRequested.current = true;
    const ready = await preparePasskeyEntry(true);
    const channel = setupChannel.current;
    if (ready || !channel) { takeoverRequested.current = false; return; }
    channel.postMessage("take-over");
    takeoverTimer.current = window.setTimeout(() => {
      takeoverRequested.current = false;
      void retryFromTakeover.current();
    }, 1000);
  };
  useEffect(() => {
    if (typeof window.BroadcastChannel !== "function") return;
    const channel = new window.BroadcastChannel("pb-passkey-setup");
    setupChannel.current = channel;
    channel.onmessage = (event) => {
      if (event.data === "take-over") {
        void moveSetupAway.current().then(released => { if (released) channel.postMessage("released"); }).catch(() => undefined);
      } else if (event.data === "released" && takeoverRequested.current) {
        takeoverRequested.current = false;
        clearTimeout(takeoverTimer.current);
        void retryFromTakeover.current();
      }
    };
    return () => { clearTimeout(takeoverTimer.current); setupChannel.current = undefined; channel.close(); };
  }, []);

  const replacePasskeyDevice = (revokeDeviceId: string | null, recoveryKeyProof?: string,
    unlock?: { method: UnlockMethod; password?: string },
  ) => runSetupWithUnlock(unlock?.method, async (signal, onLocalUnlock) => {
    const attempt = setupAttempt.current;
    if (attempt) {
      await attempt.replace(revokeDeviceId, recoveryKeyProof);
      await continuePasskeySetup(attempt);
    } else {
      const limitTicket = passkeyDeviceLimit?.limitTicket;
      if (!unlock || !limitTicket) throw new Error("Unlock the saved setup before replacing a device");
      await resumePasskeySetup(unlock.method, unlock.password, { limitTicket, revokeDeviceId, recoveryKeyProof }, signal, onLocalUnlock);
    }
  });

  const retryPasskeySetup = () => runPasskeySetup(async () => {
    if (setupScreen === "activation") { await finishBackupActivation(); return; }
    const attempt = setupAttempt.current;
    if (!attempt) return;
    if (attempt.deviceLimit && attempt.pending) { await finishPasskeySetup(attempt); return; }
    if (!attempt.pending && !attempt.deviceLimit) {
      try { await attempt.retryAuthorization(); }
      catch (err) { if (attempt.closed || passkeySetupDeviceLimit(err)) setNativeStage(null); throw err; }
    }
    setNativeStage(null);
    await continuePasskeySetup(attempt);
  });

  const requestForgetSavedPasskeySetup = () => {
    if (submitting.current) return;
    const attempt = setupAttempt.current;
    setForgetSavedSetupId(savedPasskeySetupId ??
      (attempt?.pending && !attempt.canUsePasswordFallback() ? attempt.setupId : undefined));
  };
  const confirmForgetSavedPasskeySetup = () => runPasskeySetup(async () => {
    if (!forgetSavedSetupId) return;
    const attempt = setupAttempt.current;
    if (attempt?.setupId === forgetSavedSetupId) {
      attempt.discard();
      setupAttempt.current = null;
      setSetupScreen(null);
      await showSavedPasskeySetup();
    }
    if (await forgetSavedPasskeySetup(forgetSavedSetupId)) {
      useAuthStore.getState().logout({ forgetDevice: true });
      setApprovalUsername(undefined);
      setPasskeyDeviceLimit(undefined);
      setPasskeyPasswordRequired(false);
      setPassword("");
    }
    setForgetSavedSetupId(undefined);
    await showSavedPasskeySetup();
  });

  const forgetRevokedPasskeyVault = () => runPasskeySetup(async () => {
    if (!revokedVault || !confirmForgetRevokedVault) return;
    await discardPreparedPasskeyEntry();
    const owner = await getLocalKeyOwner();
    if (owner?.deviceId === revokedVault.deviceId && isInitialLoginSession(revokedVault) &&
        await resetLocalDevice(revokedVault.vaultKey) && isInitialLoginSession(revokedVault)) {
      clearRegisteredAccountState();
      useAuthStore.getState().logout({ forgetDevice: true });
    }
    setPassword("");
    setConfirmForgetRevokedVault(false);
    setRevokedVault(undefined);
  });

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
    setApprovalUsername(undefined);
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
    setApprovalUsername(undefined);
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
      setApprovalUsername(undefined);
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
    passkeysSupported: !nativeHidden && (capabilities.passkeys || capabilities.nativePasskeys),
    signInAsOwner,
    cancelLink,
    forgetLocalKeys,
    username,
    setUsername: changeUsername,
    password,
    setPassword,
    recoveryKey,
    setRecoveryKey,
    error: error ? renderMessage(error) : "",
    loading,
    pendingLink,
    blockedOwner,
    linkCompleting,
    linkAtDeviceLimit: !!pendingLink && limitPausedLink.current === pendingLink.linkRequestId,
    usernameInput,
    handleSubmit,
    handlePasskeyLogin: handlePasskeyEntry, passkeyPasswordRequired, completePasskeySetupWithPassword, cancelPasskeySetup,
    freshPasskeysSupported: capabilities.passkeys || capabilities.nativePasskeyProvisioning,
    passkeySetup: setupAttempt.current, passkeySetupProblem, passkeyDeviceLimit, replacePasskeyDevice, retryPasskeySetup,
    passkeySetupPrepared, prepareFreshPasskeySetup,
    authorizePreparedPasskeySetup: (assertion?: Parameters<typeof authorizePreparedPasskeySetup>[0]) =>
      preparedSetup.current && !assertion && entryOptionsAreStale() ? handlePasskeyEntry() : authorizePreparedPasskeySetup(assertion),
    entryState, passkeyGesture, preparePasskeyEntry, handlePasskeyEntry, startPasskeyAutofill, requestSetupTakeover,
    markPasskeyOffline: () => { autofill.current?.abort(); setEntryState("offline"); },
    nativeStage, nativeRestarting, cancelNativeHandoff, interrupted,
    revokedVault, confirmForgetRevokedVault, setConfirmForgetRevokedVault, forgetRevokedPasskeyVault,
    setupScreen, passwordOnly, passkeyApproval, beginUnlockSetup, enrollPasskeySetupUnlock, finishWithBackupPassword,
    setupUnlockMethod: setupAttempt.current?.method ?? resumedBackup?.backupMethod,
    savedSetupDeviceName: t("passkeySetup.setupOtherDevice"),
    nativeUnlockPending,
    chooseSetupPassword: () => {
      nativeUnlockAttempt.current?.controller.abort();
      setPasswordOnly(true);
      setPasskeyPasswordRequired(true);
    },
    savedPasskeySetupId, resumeMethods, resumePasskeyUnlock, requestForgetSavedPasskeySetup,
    confirmingForgetSavedPasskeySetup: !!forgetSavedSetupId,
    cancelForgetSavedPasskeySetup: () => setForgetSavedSetupId(undefined),
    confirmForgetSavedPasskeySetup,
  };
}
