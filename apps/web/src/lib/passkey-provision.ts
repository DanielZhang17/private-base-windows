import { toBase64Url } from "@e2ee-chat/crypto";
import {
  createDeviceActionPayload, createPasskeyProvisionPayload, serializeSignedPasskeyProvisionBundle,
  type AuthResponse, type DeviceLimitResponse, type PasskeyLoginOptionsResponse, type PendingPasskeySetup,
} from "@e2ee-chat/shared";
import { claimPasskeySetupLease, matchesPendingSetup, releasePasskeySetupLease, readPendingSetupRecord, updatePendingSetupRecord, type PendingSetupRecord } from "../db/index.js";
import { bindLocalUnlockEnrollment, buildDeviceLinkPublicBundle, getUnlockGeneration, KeysLockedError, keysLoaded, listLocalUnlockMethods, prepareDeviceKeySetup, resetLocalCryptoState, signWithIdentityKey, unlockLocalKeys } from "./key-manager.js";
import type { UnlockMethod, UnlockSetup } from "./device-key-vault.js";
import { authorizeNativePasskeyProvision } from "./native-passkeys.js";
import { getPasskeyAssertionWithPrf, PasskeyUnsupportedError } from "./webauthn.js";
import { capabilities } from "../platform/capabilities.js";
import { platformName } from "../platform/environment.js";
import { api } from "../services/api.js";
import { isSameSession } from "../services/session-identity.js";
import { useAuthStore } from "../stores/authStore.js";

export class DeviceApprovalRequiredError extends Error {
  constructor(readonly username?: string) {
    super("This account requires approval from an existing device");
    this.name = "DeviceApprovalRequiredError";
  }
}

export function passkeySetupDeviceLimit(error: unknown): DeviceLimitResponse | undefined {
  const body = errorBody(error);
  return body?.error === "device_limit" ? body as DeviceLimitResponse : undefined;
}

class StalePasskeySetupError extends Error {
  constructor() { super("Device setup changed"); this.name = "StalePasskeySetupError"; }
}

type WebAssertion = Awaited<ReturnType<typeof getPasskeyAssertionWithPrf>>;
export interface SetupCeremony {
  assertion?: WebAssertion;
  signal?: AbortSignal;
  onHandoff?: (stage: "browser" | "redeeming") => void;
}

function isTerminalAuthorizationFailure(error: unknown) {
  const status = (error as { status?: number })?.status;
  return error instanceof DeviceApprovalRequiredError || error instanceof StalePasskeySetupError ||
    (typeof status === "number" && status >= 400 && status < 500 && !passkeySetupDeviceLimit(error));
}

function errorBody(error: unknown) {
  return (error as { body?: { error?: string; username?: string } })?.body;
}

export function isInvalidSetupToken(error: unknown): boolean {
  if ((error as { status?: number })?.status !== 401) return false;
  const code = errorBody(error)?.error;
  return code === "Invalid setup token" || code === "Invalid token";
}

export async function verifySetupPassword(password: string, setupToken?: string) {
  const response = setupToken
    ? await api.post<{ verified: true }>("/auth/password/verify", { password }, { bearerToken: setupToken })
    : await api.post<{ verified: true }>("/auth/password/verify", { password });
  if (response.verified !== true) throw new Error("Account password could not be verified");
}

export function bindAccountUnlockEnrollment() {
  const session = useAuthStore.getState();
  return bindLocalUnlockEnrollment(() => {
    const current = useAuthStore.getState();
    return isSameSession(session, current) && session.user?.id === current.user?.id &&
      session.device?.id === current.device?.id;
  });
}

export async function addAccountPasswordUnlock(password: string) {
  const enroll = bindAccountUnlockEnrollment();
  await verifySetupPassword(password);
  await enroll({ method: "password", password });
}

export class PasskeySetupBusyError extends Error {
  constructor() { super("Device setup is already running in another tab"); this.name = "PasskeySetupBusyError"; }
}

let setupBusy = false;
let leaseRelease = Promise.resolve();
const SETUP_LEASE_MS = 4 * 60_000;
async function acquireSetupLock(): Promise<() => void> {
  if (setupBusy) throw new Error("Device setup is already running");
  setupBusy = true;
  let relinquish: () => void = () => undefined;
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    setupBusy = false;
    relinquish();
  };
  try {
    if (navigator.locks) {
      const released = new Promise<void>(resolve => { relinquish = resolve; });
      await new Promise<void>((resolve, reject) => {
        void navigator.locks.request("pb-setup", { ifAvailable: true }, (lock) => {
          if (!lock) {
            reject(new PasskeySetupBusyError());
            return;
          }
          resolve();
          return released;
        }).catch(reject);
      });
    } else {
      await leaseRelease;
      const owner = crypto.randomUUID();
      if (!await claimPasskeySetupLease(owner, SETUP_LEASE_MS)) throw new PasskeySetupBusyError();
      const heartbeat = setInterval(() => {
        void claimPasskeySetupLease(owner, SETUP_LEASE_MS, true).catch(() => undefined);
      }, SETUP_LEASE_MS / 4);
      relinquish = () => {
        clearInterval(heartbeat);
        leaseRelease = releasePasskeySetupLease(owner).catch(() => undefined);
      };
    }
    return release;
  } catch (err) { release(); throw err; }
}

async function withSetupLock<T>(task: () => Promise<T>): Promise<T> {
  const release = await acquireSetupLock();
  try { return await task(); }
  finally { release(); }
}

export { readPendingSetupRecord as readPendingPasskeySetup };

/** Reconcile a checkpoint left before any local key was made durable. */
export function clearInterruptedPasskeySetup() {
  return withSetupLock(async () => {
    const record = await readPendingSetupRecord();
    if (!record || record.stage === "unlockReady" || record.stage === "complete") return false;
    // No setup token or private key survives a restart here. The server expires or supersedes it.
    return updatePendingSetupRecord(undefined, record);
  });
}

export async function clearPendingPasskeySetup(setupId: string) {
  await updatePendingSetupRecord(undefined, setupId);
}

export async function forgetSavedPasskeySetup(setupId: string): Promise<boolean> {
  return withSetupLock(async () => {
    const record = await readPendingSetupRecord();
    if (record?.setupId !== setupId || (record.stage !== "unlockReady" && record.stage !== "complete")) return false;
    return resetLocalCryptoState(setupId);
  });
}

function captureSetupUnlock() {
  const generation = getUnlockGeneration();
  return () => {
    if (!keysLoaded() || getUnlockGeneration() !== generation) throw new KeysLockedError();
  };
}

async function finishSetup(pending: PendingPasskeySetup, record: PendingSetupRecord, assertUnlocked: () => void) {
  assertUnlocked();
  if (record.backupPending) throw new Error("Choose whether to add password unlock before completing setup");
  if (pending.deviceId !== record.deviceId) throw new StalePasskeySetupError();
  const auth = await api.post<AuthResponse>("/auth/passkey/provision/complete", {
    setupId: record.setupId,
  }, { bearerToken: pending.setupToken }).catch(error => {
    if (errorBody(error)?.error === "approval_required") throw new DeviceApprovalRequiredError(pending.user.username);
    throw error;
  });
  if (auth.device.id !== record.deviceId || !await updatePendingSetupRecord({ ...record, stage: "complete" }, record, assertUnlocked)) {
    throw new StalePasskeySetupError();
  }
  assertUnlocked();
  return auth;
}

async function chooseBackupPassword(
  pending: PendingPasskeySetup, record: PendingSetupRecord, assertUnlocked: () => void, password?: string,
) {
  assertUnlocked();
  if (pending.deviceId !== record.deviceId || !matchesPendingSetup(await readPendingSetupRecord(), record)) {
    throw new StalePasskeySetupError();
  }
  assertUnlocked();
  if (!record.backupPending) return;
  if (password !== undefined) {
    await verifySetupPassword(password, pending.setupToken);
    if (!matchesPendingSetup(await readPendingSetupRecord(), record)) throw new StalePasskeySetupError();
    assertUnlocked();
    await bindLocalUnlockEnrollment()({ method: "password", password });
    assertUnlocked();
  }
  const next = { ...record, backupPending: false as const };
  if (!await updatePendingSetupRecord(next, record, assertUnlocked)) throw new StalePasskeySetupError();
  Object.assign(record, next);
}

async function reconcileResumeFailure(error: unknown, record: PendingSetupRecord): Promise<never> {
  const code = errorBody(error)?.error;
  if (code === "setup_expired" && record.stage !== "complete") {
    await resetLocalCryptoState(record.setupId);
  } else if (code === "setup_already_active" || code === "setup_revoked" || code === "setup_expired") {
    // The ordinary sign-in path can reopen a vault that already activated.
    await clearPendingPasskeySetup(record.setupId);
  }
  throw error;
}

export interface PasskeyReplacement {
  limitTicket: string;
  revokeDeviceId: string | null;
  recoveryKeyProof?: string;
}

export interface ResumedSetupBackup {
  setupId: string;
  backupMethod: "passkey" | "native";
  chooseBackupPassword: (password?: string) => Promise<void>;
  complete: () => Promise<AuthResponse>;
}

export async function resumePasskeyDeviceSetup(
  method: UnlockMethod, password?: string, replacement?: PasskeyReplacement,
): Promise<AuthResponse | ResumedSetupBackup> {
  return withSetupLock(async () => {
    const record = await readPendingSetupRecord();
    if (!record || (record.stage !== "unlockReady" && record.stage !== "complete")) throw new Error("No local device setup to finish");
    await unlockLocalKeys(method, password);
    const assertUnlocked = captureSetupUnlock();
    const { setupId } = record;
    const { challengeId } = await api.post<{ challengeId: string }>("/auth/passkey/provision/resume-options", { setupId });
    assertUnlocked();
    const signature = await signWithIdentityKey(createDeviceActionPayload("resume_setup", setupId, challengeId));
    assertUnlocked();
    try {
      let pending = await api.post<PendingPasskeySetup>("/auth/passkey/provision/resume", { setupId, challengeId, signature });
      assertUnlocked();
      if (pending.deviceId !== record.deviceId) throw new StalePasskeySetupError();
      if (record.stage === "unlockReady" && record.backupPending !== false) {
        // A saved password settles the choice even if setup stopped before updating the checkpoint.
        const backupPending: PendingSetupRecord["backupPending"] = (await listLocalUnlockMethods()).includes("password") ? false
          : record.backupPending ?? (method === "password" ? false : method);
        if (backupPending !== record.backupPending) {
          const next = { ...record, backupPending };
          if (!await updatePendingSetupRecord(next, record, assertUnlocked)) throw new StalePasskeySetupError();
          Object.assign(record, next);
        }
      }
      const backupMethod = record.backupPending;
      if (backupMethod) {
        assertUnlocked();
        return {
          setupId, backupMethod,
          chooseBackupPassword: (backup?: string) => withSetupLock(() => chooseBackupPassword(pending, record, assertUnlocked, backup)),
          complete: () => withSetupLock(async () => {
            if (!matchesPendingSetup(await readPendingSetupRecord(), record)) throw new StalePasskeySetupError();
            try { return await finishSetup(pending, record, assertUnlocked); }
            catch (error) { return reconcileResumeFailure(error, record); }
          }),
        };
      }
      if (replacement) {
        // Pending devices never run prekey maintenance, so the persisted keys can rebuild the original bundle.
        const unsigned = { ...buildDeviceLinkPublicBundle(pending.deviceName), platform: pending.platform };
        const bundleSignature = await signWithIdentityKey(createPasskeyProvisionPayload(unsigned));
        assertUnlocked();
        pending = await api.post<PendingPasskeySetup>("/auth/passkey/provision/replace", {
          ...replacement, setupId, bundle: { ...unsigned, bundleSignature },
        });
      }
      return await finishSetup(pending, record, assertUnlocked);
    } catch (error) {
      return reconcileResumeFailure(error, record);
    }
  });
}

/** Start key generation/options before a user gesture. Private keys stay in memory. */
export async function preparePasskeyDeviceSetup(deviceName: string, signal?: AbortSignal) {
  if (!capabilities.passkeys && !capabilities.nativePasskeyProvisioning) throw new PasskeyUnsupportedError();
  const release = await acquireSetupLock();
  try {
    const previous = await readPendingSetupRecord();
    if (previous?.stage === "unlockReady" || previous?.stage === "complete") throw new Error("Finish the previous device setup first");
    const keys = await prepareDeviceKeySetup(deviceName, platformName());
    const bytes = new TextEncoder().encode(serializeSignedPasskeyProvisionBundle(keys.bundle));
    const bundleHash = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    const setupId = crypto.randomUUID();
    const record: PendingSetupRecord = { id: "setup:pending", setupId, bundleHash, stage: "prepared", createdAt: Date.now() };
    if (!await updatePendingSetupRecord(record, previous)) {
      keys.discard();
      throw new Error("Device setup changed");
    }
    try {
      const options = capabilities.nativePasskeyProvisioning ? null :
        await api.post<PasskeyLoginOptionsResponse>("/auth/passkey/provision-options", { bundleHash }, signal ? { signal } : undefined);
      signal?.throwIfAborted();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      let started = false;
      return {
        setupId,
        requestAutofill: (signal: AbortSignal) =>
          options ? getPasskeyAssertionWithPrf(options.options, salt, { mediation: "conditional", signal }) : undefined,
        authorize: async (ceremony?: SetupCeremony) => {
          if (started) throw new Error("Device authorization already started");
          started = true;
          try { return await authorizeDeviceSetup(keys, record, options, salt, release, ceremony); }
          catch (err) {
            keys.discard();
            try { await clearPendingPasskeySetup(setupId); } finally { release(); }
            throw err;
          }
        },
        discard: async () => {
          keys.discard();
          try { await clearPendingPasskeySetup(setupId); } finally { release(); }
        },
      };
    } catch (err) {
      keys.discard();
      await clearPendingPasskeySetup(setupId);
      throw err;
    }
  } catch (err) { release(); throw err; }
}

export async function beginPasskeyDeviceSetup(deviceName: string) {
  const prepared = await preparePasskeyDeviceSetup(deviceName);
  return prepared.authorize();
}

async function authorizeDeviceSetup(
  keys: Awaited<ReturnType<typeof prepareDeviceKeySetup>>,
  record: PendingSetupRecord,
  options: PasskeyLoginOptionsResponse | null,
  salt: Uint8Array,
  release: () => void,
  ceremony?: SetupCeremony,
) {
  let method: UnlockMethod;
  let prf: Uint8Array | undefined;
  let credentialId = "";
  const setupId = record.setupId;
  let submit: () => Promise<PendingPasskeySetup>;
  if (options) {
    // Start WebAuthn before any asynchronous checkpoint reads so Safari retains the gesture.
    const assertion = ceremony?.assertion ?? await getPasskeyAssertionWithPrf(options.options, salt, { signal: ceremony?.signal });
    prf = assertion.prf;
    credentialId = assertion.credential.id;
    // A synced credential's PRF support can vary across clients. Use the result of this assertion.
    method = prf ? "passkey" : "password";
    submit = () => api.post("/auth/passkey/provision", {
      setupId, challengeId: options.challengeId, credential: assertion.credential, bundle: keys.bundle,
    }, ceremony?.signal ? { signal: ceremony.signal } : undefined);
  } else {
    method = capabilities.biometricUnlock ? "native" : "password";
    ceremony?.onHandoff?.("browser");
    submit = await authorizeNativePasskeyProvision(record.bundleHash, keys.bundle, setupId, ceremony?.signal);
    ceremony?.onHandoff?.("redeeming");
  }
  let pending: PendingPasskeySetup | undefined;
  let deviceLimit: DeviceLimitResponse | undefined;
  let authorizationError: unknown;
  let assertUnlocked: (() => void) | undefined;
  let stopped = false;
  let working = false;
  let shouldDispose = false;
  const dropMemory = () => {
    keys.discard();
    prf?.fill(0);
    prf = undefined;
  };
  const assertCurrent = async () => {
    const current = await readPendingSetupRecord();
    if (stopped || current?.setupId !== setupId) throw new StalePasskeySetupError();
    return current;
  };
  const authorize = async (request: () => Promise<PendingPasskeySetup>) => {
    await assertCurrent();
    try {
      pending = await request();
      ceremony?.signal?.throwIfAborted();
      if (record.deviceId && record.deviceId !== pending.deviceId) throw new StalePasskeySetupError();
      const next = { ...record, deviceId: pending.deviceId, stage: record.stage === "prepared" ? "provisioned" as const : record.stage };
      if (!await updatePendingSetupRecord(next, record)) throw new StalePasskeySetupError();
      Object.assign(record, next);
      deviceLimit = undefined;
      authorizationError = undefined;
    } catch (err) {
      const problem = errorBody(err);
      if (problem?.error === "approval_required") throw new DeviceApprovalRequiredError(problem.username);
      deviceLimit = passkeySetupDeviceLimit(err) ?? deviceLimit;
      authorizationError = err;
      throw err;
    }
  };
  try { await authorize(submit); }
  catch (err) {
    if (ceremony?.signal?.aborted || isTerminalAuthorizationFailure(err)) { dropMemory(); throw err; }
    // Keep the same assertion or PKCE code in memory for an exact retry after a lost response.
  }
  const dispose = () => {
    stopped = true;
    dropMemory();
    release();
  };
  const run = async <T>(operation: () => Promise<T>) => {
    if (working || stopped) throw new Error("Device setup is already running or ended");
    working = true;
    try { return await operation(); }
    finally {
      working = false;
      if (shouldDispose) dispose();
    }
  };

  const retryAuthorization = async () => {
    try { await authorize(submit); }
    catch (err) {
      if (isTerminalAuthorizationFailure(err)) {
        try { await clearPendingPasskeySetup(setupId); } finally { dispose(); }
      }
      throw err;
    }
  };

  const persistUnlock = async (password?: string) => {
    await assertCurrent();
    if (!pending) await retryAuthorization();
    if (record.stage !== "provisioned") return;
    let slot: UnlockSetup;
    if (password !== undefined) {
      await verifySetupPassword(password, pending!.setupToken);
      slot = { method: "password", password };
    } else if (method === "native") slot = { method: "native" };
    else if (prf && options) slot = { method: "passkey", credentialId, rpId: options.options.rpId, salt, output: prf };
    else throw new Error("Password unlock is required for this device");
    const durable = { ...record, stage: "unlockReady" as const, backupPending: slot.method === "password" ? false as const : slot.method };
    try {
      await keys.commit(slot, { record: durable, owner: { userId: pending!.user.id, username: pending!.user.username, deviceId: pending!.deviceId } });
      assertUnlocked = captureSetupUnlock();
    } catch (error) {
      // A lock can interrupt in-memory publication after the vault has committed.
      const current = await readPendingSetupRecord().catch(() => undefined);
      if (current?.setupId === setupId && current.deviceId === durable.deviceId && current.stage === "unlockReady") {
        Object.assign(record, durable);
        dropMemory();
      }
      throw error;
    }
    Object.assign(record, durable);
    dropMemory();
  };

  return {
    setupId, method,
    get pending() { return pending; },
    get deviceLimit() { return deviceLimit; },
    get authorizationError() { return authorizationError; },
    get closed() { return stopped; },
    get backupPending() { return record.backupPending; },
    canUsePasswordFallback: () => !stopped && record.stage !== "unlockReady" && record.stage !== "complete",
    persistUnlock: (password?: string) => run(() => persistUnlock(password)),
    chooseBackupPassword: (password?: string) => run(async () => {
      if (!pending || record.stage !== "unlockReady") throw new Error("Set up the first unlock method before adding a backup");
      if (!assertUnlocked) throw new KeysLockedError();
      await chooseBackupPassword(pending, record, assertUnlocked, password);
    }),
    retryAuthorization: () => run(retryAuthorization),
    replace: (revokeDeviceId: string | null, recoveryKeyProof?: string) => run(async () => {
      const limitTicket = deviceLimit?.limitTicket;
      if (!limitTicket) throw new Error("A fresh passkey is required to replace a device");
      await authorize(() => api.post("/auth/passkey/provision/replace", { limitTicket, setupId, revokeDeviceId, recoveryKeyProof, bundle: keys.bundle }));
    }),
    abandon: () => run(async () => {
      const current = await assertCurrent();
      if (current.stage === "unlockReady" || current.stage === "complete") throw new Error("Finish or revoke this device before forgetting its keys");
      stopped = true;
      dropMemory();
      try {
        if (pending) await api.post("/auth/passkey/provision/abandon", { setupId }, { bearerToken: pending.setupToken });
      } finally {
        try { await clearPendingPasskeySetup(setupId); } finally { dispose(); }
      }
    }),
    discard: () => {
      if (working) shouldDispose = true;
      else dispose();
    },
    complete: (password?: string) => run(async () => {
      await persistUnlock(password);
      try {
        if (!assertUnlocked) throw new KeysLockedError();
        const auth = await finishSetup(pending!, record, assertUnlocked);
        record.stage = "complete";
        dispose();
        return auth;
      }
      catch (err) {
        deviceLimit = passkeySetupDeviceLimit(err) ?? deviceLimit;
        if (err instanceof StalePasskeySetupError) dispose();
        throw err;
      }
    }),
  };
}
