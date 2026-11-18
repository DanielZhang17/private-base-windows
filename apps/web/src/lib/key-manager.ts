/**
 * Manages the lifecycle of cryptographic keys for the local device:
 * - Generates identity keys and pre-key bundles on first registration
 * - Persists private keys encrypted in IndexedDB
 * - Uploads public pre-key bundles to the server
 * - Monitors one-time pre-key count and replenishes as needed
 */
import {
  generateIdentityKeyPair,
  serializeIdentityKeyPair,
  deserializeIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
  serializeOneTimePreKeys,
  sign,
  toBase64Url,
  fromBase64Url,
  type IdentityKeyPair,
  type SignedPreKey,
  type OneTimePreKey,
} from "@e2ee-chat/crypto";
import {
  OTP_KEY_POOL_SIZE,
  OTP_KEY_REPLENISH_THRESHOLD,
  createPasskeyProvisionPayload,
  type DevicePlatform,
  type PasskeyProvisionBundle,
  type DeviceLinkPublicBundle,
} from "@e2ee-chat/shared";
import { saveKey, saveKeys, sameLocalKey, getKey, clearAll, clearCryptoState, migrateLocalEditKeys, pendingResetNativeKeyIds, clearResetNativeKeyId,
  recordNativeEnrollment, abandonNativeEnrollment, pendingNativeEnrollmentIds, claimNativeCleanup, releaseNativeCleanup,
  type LocalKey, type PendingSetupRecord } from "../db/index.js";
import { api } from "../services/api.js";
import { clearRegisteredLocalCallState } from "../platform/session-cleanup.js";

import {
  deriveEncryptionKey, generateVault, readVault, vaultRecord,
  wrapUnlockSlot, unwrapUnlockSlot, unlockMethodAvailable, type DeviceVault, type UnlockSetup, type UnlockMethod, type UnlockSlot,
} from "./device-key-vault.js";
import { decryptData, encryptData, localEncryptionKey as _encryptionKey, openAttachmentBytes, sealAttachmentBytes,
  setLocalEncryptionKey, type SealedAttachment } from "./local-key-encryption.js";
import { biometricUnlock, hasExclusiveNativeDocument, hasNativeWebLocks, NativeBiometricError,
  refreshNativeUnlockCapability } from "../platform/biometric-unlock.js";
import { assertNotAborted, withNativeDeadline } from "../platform/native-wait.js";
import { notifyUnlockMethodsChanged } from "./unlock-method-changes.js";

const IDENTITY_KEY_ID = "identity";
const SIGNED_PRE_KEY_ID = "signedPreKey";
const OTP_KEYS_ID = "otpKeys";
const DB_ENCRYPTION_KEY_ID = "dbKey";
const OTP_NEXT_ID = "otpNextId";
const OTP_PENDING_IDS = "otpPendingIds";

export interface LocalKeyOwner {
  userId: string;
  username: string;
  /** Server device id these keys belong to; lets login reuse them if the auth store lost it. */
  deviceId?: string;
}

export async function getLocalKeyOwner(): Promise<LocalKeyOwner | null> {
  const record = await getKey("owner");
  if (!record) return null;
  try {
    const owner = JSON.parse(record.data);
    if (typeof owner?.userId !== "string" || typeof owner?.username !== "string") return null;
    return {
      userId: owner.userId,
      username: owner.username,
      ...(typeof owner.deviceId === "string" && owner.deviceId ? { deviceId: owner.deviceId } : {}),
    };
  } catch {
    return null;
  }
}

export async function setLocalKeyOwner(owner: LocalKeyOwner): Promise<void> {
  await saveKey({ id: "owner", type: "owner", data: JSON.stringify(owner) });
}

/**
 * The server device id to sign in with when this browser already holds keys. The id recorded
 * with the keys wins over the auth store, which can be empty or hold a stale/foreign device;
 * a server "Unknown device" for anything but the keys' own device must never wipe them.
 * Returns "" when the keys' device is not known.
 */
export function resolveLocalKeyDeviceId(input: {
  owner: LocalKeyOwner | null;
  typedUsername: string;
  storedDevice: { id?: string; userId?: string } | null;
}): string {
  const { owner, storedDevice } = input;
  const storedId = storedDevice?.id?.trim() ?? "";
  if (!owner) return storedId;
  if (owner.username !== input.typedUsername) return "";
  if (owner.deviceId) return owner.deviceId;
  // Owner records written before deviceId existed: trust the store unless it names another user.
  return storedDevice?.userId && storedDevice.userId !== owner.userId ? "" : storedId;
}

export function decideLocalKeyAction(input: {
  hasKeys: boolean;
  owner: LocalKeyOwner | null;
  typedUsername: string;
  serverSaidUnknownDevice: boolean;
}): "use" | "wipe-revoked" | "block-other-owner" {
  if (!input.hasKeys) return "use";
  if (input.owner && input.owner.username !== input.typedUsername) return "block-other-owner";
  if (!input.serverSaidUnknownDevice) return "use";
  return input.owner ? "wipe-revoked" : "block-other-owner";
}

// In-memory cache of decrypted private keys for the session
let _identityKeyPair: IdentityKeyPair | null = null;
let _signedPreKey: SignedPreKey | null = null;
let _oneTimePreKeys: OneTimePreKey[] = [];
let _vaultId: string | null = null;
let _lockEpoch = 0;
let _otpNextId = 1;
let _pendingOTPIds = new Set<number>();
let _otpWrites: Promise<void> = Promise.resolve();
/** Consumed ids whose removal could not be persisted yet; applied on the next successful reload. */
const _deferredOTPRemovals = new Set<number>();
let _maintenance: Promise<void> | null = null;
let _bundleUpload: Promise<void> | null = null;
let _bundlePublished = false;
/** Counts unlocks (key generation or loading) of this tab; never shared with other tabs. */
let _unlockGeneration = 0;

const IDLE_LOCK_MS = 15 * 60 * 1_000; // 15 minutes
// The window overload returns a DOM handle even when dependency types add Node timer overloads.
let _idleTimer: number | null = null;
let _lastActivityReset = 0;
const _lockListeners = new Set<() => void>();
const idleHolds = new Set<symbol>();

export function onKeysLocked(cb: () => void): () => void {
  _lockListeners.add(cb);
  return () => { _lockListeners.delete(cb); };
}

function onActivity(): void {
  if (Date.now() - _lastActivityReset < 30_000) return;
  resetIdleTimer();
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") onActivity();
}

function installActivityListeners(): void {
  window.addEventListener("pointerdown", onActivity);
  window.addEventListener("keydown", onActivity);
  document.addEventListener("visibilitychange", onVisibilityChange);
  resetIdleTimer();
}

export function resetIdleTimer(): void {
  if (!_identityKeyPair) return;
  _lastActivityReset = Date.now();
  if (_idleTimer !== null) window.clearTimeout(_idleTimer);
  _idleTimer = null;
  if (idleHolds.size) return;
  _idleTimer = window.setTimeout(() => {
    lockLocalCryptoState();
    for (const listener of _lockListeners) listener();
  }, IDLE_LOCK_MS);
}

/** An active data transfer leases the idle timer. Explicit lock always wins. */
export function holdIdleLock(): () => void {
  if (!_identityKeyPair) return () => {};
  const lease = Symbol();
  idleHolds.add(lease);
  resetIdleTimer();
  return () => { if (idleHolds.delete(lease)) resetIdleTimer(); };
}

export async function sealCachedAttachment(ownerId: string, fileId: string, wire: Blob) {
  const key = _encryptionKey;
  if (!key) throw new KeysLockedError();
  const sealed = await sealAttachmentBytes(key, ownerId, fileId, await wire.arrayBuffer());
  if (key !== _encryptionKey) throw new KeysLockedError();
  return sealed;
}

export async function openCachedAttachment(ownerId: string, fileId: string, sealed: SealedAttachment): Promise<Blob> {
  const key = _encryptionKey;
  if (!key) throw new KeysLockedError();
  const wire = await openAttachmentBytes(key, ownerId, fileId, sealed);
  if (key !== _encryptionKey) throw new KeysLockedError();
  return new Blob([wire]);
}

export async function initializeKeys(password: string, vaultId?: string): Promise<string> {
  lockLocalCryptoState();
  const epoch = _lockEpoch;
  const prepared = await generateDeviceKeys();
  if (vaultId) prepared.vault.id = vaultId;
  await commitDeviceKeys(prepared, { method: "password", password }, epoch, true);
  return toBase64Url(prepared.identityKeyPair.publicEd25519);
}

async function generateDeviceKeys() {
  const { vault, encKey } = await generateVault();
  const identityKeyPair = await generateIdentityKeyPair();
  const signedPreKey = await generateSignedPreKey(1, identityKeyPair.privateEd25519);
  const oneTimePreKeys = await generateOneTimePreKeys(1, OTP_KEY_POOL_SIZE);
  return { vault, encKey, identityKeyPair, signedPreKey, oneTimePreKeys };
}

type PreparedDeviceKeys = Awaited<ReturnType<typeof generateDeviceKeys>>;

const nativeKeyLock = "privatebase-native-unlock";
let nativeOperations = Promise.resolve();
let nativeOperationsPending = 0;

async function withNativeKeyLock(
  operation: (canRecoverEnrollment: boolean) => Promise<void>, background = false, signal?: AbortSignal,
): Promise<void> {
  // A background run can retry later if a prompt or removal already owns the claim.
  if (background && nativeOperationsPending) return;
  nativeOperationsPending++;
  try {
    let result!: Promise<void>;
    await withNativeDeadline(60_000, async waiting => {
      let enter!: () => void;
      const admitted = new Promise<void>(resolve => { enter = resolve; });
      const run = (canRecoverEnrollment: boolean) => {
        assertNotAborted(waiting);
        enter();
        return operation(canRecoverEnrollment);
      };
      result = nativeOperations.then(async () => {
        assertNotAborted(waiting);
        if (hasNativeWebLocks()) {
          const options = background ? { ifAvailable: true } : { signal: waiting };
          await navigator.locks.request(nativeKeyLock, options, lock => lock ? run(true) : undefined);
        } else await run(hasExclusiveNativeDocument());
      });
      nativeOperations = result.catch(() => undefined);
      await Promise.race([admitted, result]);
    }, signal);
    // Once admitted, keep the lock until the operation settles. Each IPC has its own deadline.
    await result;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new NativeBiometricError("failed");
    throw error;
  }
  finally { nativeOperationsPending--; }
}

type PreparedUnlockSlot = { key: CryptoKey; save: (slot: UnlockSlot) => Promise<void> };

async function commitUnlockSlot(
  setup: UnlockSetup, assertCurrent: () => void, prepare: () => PreparedUnlockSlot | Promise<PreparedUnlockSlot>, signal?: AbortSignal,
): Promise<void> {
  if (setup.method !== "native") {
    const { key, save } = await prepare();
    return save(await wrapUnlockSlot(key, setup));
  }
  let retryCleanup = false;
  try {
    await withNativeKeyLock(async canRecoverEnrollment => {
      if (!canRecoverEnrollment) throw new NativeBiometricError("unsupported");
      if (await hasPendingNativeUnlockRemoval()) {
        await drainNativeKeyJournal(canRecoverEnrollment, signal);
        assertNotAborted(signal);
        if (await hasPendingNativeUnlockRemoval()) throw new Error("Finish removing the previous native unlock key");
      }
      assertCurrent();
      const { key, save } = await prepare();
      const keyId = crypto.randomUUID();
      assertNotAborted(signal);
      await recordNativeEnrollment(keyId);
      try {
        assertCurrent();
        const slot = await wrapUnlockSlot(key, { method: "native", keyId }, signal);
        assertNotAborted(signal);
        await save(slot);
      } catch (error) {
        // Only the shell's bundled web version uses the native IndexedDB origin.
        // Browser tabs use a separate origin and cannot share this journal.
        // If commit succeeded before a session lock, the journal entry is already gone.
        await abandonNativeEnrollment(keyId).catch(() => undefined);
        if (signal) retryCleanup = true;
        else await drainNativeKeyJournal(false).catch(() => undefined);
        notifyUnlockMethodsChanged();
        throw error;
      }
      void refreshNativeUnlockCapability({ afterPending: true });
    }, false, signal);
  } finally {
    if (retryCleanup) void retryNativeKeyCleanup().catch(() => undefined);
  }
}

async function commitDeviceKeys(
  prepared: PreparedDeviceKeys, setup: UnlockSetup, epoch: number, fresh = false,
  checkpoint?: { record: PendingSetupRecord; owner: LocalKeyOwner }, signal?: AbortSignal,
) {
  const { vault, encKey, identityKeyPair, signedPreKey, oneTimePreKeys } = prepared;
  // Encrypt every private record before opening the write transaction.
  const serialized = serializeIdentityKeyPair(identityKeyPair);
  const { iv, ciphertext } = await encryptData(
    encKey,
    new TextEncoder().encode(JSON.stringify(serialized)),
  );

  // Encrypt signed pre-key
  const spkData = {
    id: signedPreKey.id,
    publicKey: toBase64Url(signedPreKey.keyPair.publicKey),
    privateKey: toBase64Url(signedPreKey.keyPair.privateKey),
    signature: toBase64Url(signedPreKey.signature),
  };
  const spkEnc = await encryptData(encKey, new TextEncoder().encode(JSON.stringify(spkData)));

  // Encrypt one-time pre-keys
  const otpData = oneTimePreKeys.map((k) => ({
    id: k.id,
    publicKey: toBase64Url(k.keyPair.publicKey),
    privateKey: toBase64Url(k.keyPair.privateKey),
  }));
  const otpEnc = await encryptData(encKey, new TextEncoder().encode(JSON.stringify(otpData)));
  const nextId = OTP_KEY_POOL_SIZE + 1;
  const assertCurrent = () => { if (_lockEpoch !== epoch) throw new KeysLockedError(); };
  const save = async (slot: UnlockSlot) => {
    vault.slots = [slot];
    await withOneTimePreKeyLock(async () => {
      assertCurrent();
      await saveKeys([
        vaultRecord(vault),
        { id: IDENTITY_KEY_ID, type: "identity", data: JSON.stringify({ iv, ciphertext }) },
        { id: SIGNED_PRE_KEY_ID, type: "signedPreKey", data: JSON.stringify(spkEnc) },
        { id: OTP_KEYS_ID, type: "otpKeys", data: JSON.stringify(otpEnc) },
        { id: OTP_NEXT_ID, type: OTP_NEXT_ID, data: String(nextId) },
        { id: OTP_PENDING_IDS, type: OTP_PENDING_IDS, data: "[]" },
        ...(checkpoint ? [{ id: "owner", type: "owner", data: JSON.stringify(checkpoint.owner) }] : []),
      ], fresh ? [{ id: DB_ENCRYPTION_KEY_ID }, { id: IDENTITY_KEY_ID }] : [], checkpoint?.record, () => {
        assertCurrent();
        assertNotAborted(signal);
      },
      slot.method === "native" ? { enrolled: slot.keyId } : undefined);
      notifyUnlockMethodsChanged();
      assertCurrent();
      publishUnlockedKeys(encKey, vault.id, identityKeyPair, signedPreKey, {
        keys: oneTimePreKeys, nextId, pendingIds: new Set(),
      });
    });
  };
  await commitUnlockSlot(setup, assertCurrent, () => ({ key: encKey, save }), signal);
}

/** Generate fresh keys in memory. Persist them under an unlock method before publishing the bundle. */
export async function prepareDeviceKeySetup(deviceName: string, platform: DevicePlatform) {
  const epoch = _lockEpoch;
  if (await hasLocalKeyMaterial()) throw new Error("This device already has local keys");
  let prepared: PreparedDeviceKeys | undefined = await generateDeviceKeys();
  const unsigned = {
    ...publicBundle(deviceName, prepared.identityKeyPair, prepared.signedPreKey, prepared.oneTimePreKeys),
    platform,
  };
  const signature = await sign(prepared.identityKeyPair.privateEd25519,
    Uint8Array.from(new TextEncoder().encode(createPasskeyProvisionPayload(unsigned))));
  const bundle: PasskeyProvisionBundle = { ...unsigned, bundleSignature: toBase64Url(signature) };
  return {
    bundle,
    commit: async (setup: UnlockSetup, checkpoint?: { record: PendingSetupRecord; owner: LocalKeyOwner }, signal?: AbortSignal) => {
      if (!prepared) throw new Error("Device setup has ended");
      await commitDeviceKeys(prepared, setup, epoch, true, checkpoint, signal);
      prepared = undefined;
    },
    discard: () => { prepared = undefined; },

  };
}

export function buildDeviceLinkPublicBundle(deviceName: string): DeviceLinkPublicBundle {
  const bundle = buildPublicBundle(deviceName);
  resetIdleTimer();
  return bundle;
}

/** Builds the bundle without counting as user activity (background maintenance must not postpone the idle lock). */
function buildPublicBundle(deviceName: string): DeviceLinkPublicBundle {
  if (!_identityKeyPair) throw new Error("Identity key not initialized");
  if (!_signedPreKey) throw new Error("Signed pre-key not initialized");
  if (_oneTimePreKeys.length === 0) throw new Error("No one-time pre-keys available");

  return publicBundle(deviceName, _identityKeyPair, _signedPreKey, _oneTimePreKeys);
}

function publicBundle(deviceName: string, identity: IdentityKeyPair, preKey: SignedPreKey, otp: OneTimePreKey[]): DeviceLinkPublicBundle {
  return {
    deviceName,
    identityKey: toBase64Url(identity.publicEd25519),
    signedPreKey: toBase64Url(preKey.keyPair.publicKey),
    signedPreKeyId: preKey.id,
    signedPreKeySig: toBase64Url(preKey.signature),
    oneTimePreKeys: serializeOneTimePreKeys(otp),
  };
}

/**
 * Upload the local device's public pre-key bundle.
 * Must be called only after authentication succeeds.
 */
export async function uploadPreKeyBundle(): Promise<void> {
  if (_bundlePublished) return;
  if (_bundleUpload) return _bundleUpload;
  const encKey = _encryptionKey;
  const bundle = buildPublicBundle("unused");
  const upload = api.post("/api/keys/bundle", {
    signedPreKey: bundle.signedPreKey,
    signedPreKeyId: bundle.signedPreKeyId,
    signedPreKeySig: bundle.signedPreKeySig,
    oneTimePreKeys: bundle.oneTimePreKeys,
  }).then(() => {
    if (_encryptionKey === encKey) _bundlePublished = true;
  }).finally(() => {
    if (_bundleUpload === upload) _bundleUpload = null;
  });
  _bundleUpload = upload;
  return upload;
}

/** Unlock the vault and migrate legacy password-encrypted records on first successful use. */
export function loadKeys(password: string): Promise<void> {
  return unlockLocalKeys("password", password);
}

export async function unlockLocalKeys(method: UnlockMethod, password?: string, onUnwrap?: () => void, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  lockLocalCryptoState();
  const epoch = _lockEpoch;
  const assertCurrent = () => {
    assertNotAborted(signal);
    if (_lockEpoch !== epoch) throw new KeysLockedError();
  };
  // Keep biometric prompts outside the cross-tab lock so a prompt cannot block pre-key operations.
  const initialRecord = await getKey(DB_ENCRYPTION_KEY_ID);
  const initialVault = readVault(initialRecord);
  const slot = initialVault?.slots.find((entry) => entry.method === method);
  assertCurrent();
  const unlockedKey = slot && await unwrapUnlockSlot(slot, password, signal);
  assertCurrent();
  onUnwrap?.();
  await withOneTimePreKeyLock(async () => {
    assertCurrent();
    const [record, identityRecord, spkRecord, otpRecord] = await Promise.all([
      getKey(DB_ENCRYPTION_KEY_ID), getKey(IDENTITY_KEY_ID), getKey(SIGNED_PRE_KEY_ID), getKey(OTP_KEYS_ID),
    ]);
    if (!record) throw new Error("No keys found — register first");
    const currentVault = readVault(record);
    if (currentVault && (currentVault.id !== initialVault?.id || !unlockedKey)) {
      if (!initialVault && method === "password") {
        const passwordSlot = currentVault.slots.find((entry) => entry.method === "password");
        if (!passwordSlot) throw new Error("Password unlock is unavailable");
        const migratedKey = await unwrapUnlockSlot(passwordSlot, password);
        await finishUnlock(migratedKey, record, currentVault.id, assertCurrent, identityRecord, spkRecord, otpRecord);
        return;
      }
      throw new Error("This unlock method is unavailable");
    }
    if (currentVault && unlockedKey) {
      if (!currentVault.slots.some((entry) => JSON.stringify(entry) === JSON.stringify(slot))) {
        throw new Error("This unlock method changed");
      }
      await finishUnlock(unlockedKey, record, currentVault.id, assertCurrent, identityRecord, spkRecord, otpRecord);
      return;
    }
    if (record.type !== "salt") throw new Error("Invalid local key vault");
    if (method !== "password" || password === undefined) throw new Error("Password unlock is required");

    const legacyKey = await deriveEncryptionKey(password, fromBase64Url(record.data));
    const keyState = await decodeLocalKeys(legacyKey, identityRecord, spkRecord, otpRecord);
    const { vault, encKey } = await generateVault();
    vault.slots = [await wrapUnlockSlot(encKey, { method: "password", password })];
    const encryptedRecords = [identityRecord, spkRecord, otpRecord].filter((item): item is LocalKey => !!item);
    const migrated = await Promise.all(encryptedRecords.map(async (entry) => {
      const { iv, ciphertext } = JSON.parse(entry.data);
      const clear = await decryptData(legacyKey, iv, ciphertext);
      try {
        return { ...entry, data: JSON.stringify(await encryptData(encKey, clear)) };
      } finally { clear.fill(0); }
    }));
    await migrateLocalEditKeys(encKey, record, assertCurrent, {
      key: legacyKey,
      keys: [vaultRecord(vault), ...migrated],
      expected: [...encryptedRecords, ...(!otpRecord ? [{ id: OTP_KEYS_ID }] : [])],
    });
    assertCurrent();
    publishUnlockedKeys(encKey, vault.id, keyState.identityKeyPair, keyState.signedPreKey, keyState.otpState);
  });
}

async function finishUnlock(
  key: CryptoKey, record: LocalKey, vaultId: string, assertCurrent: () => void,
  identity?: LocalKey, preKey?: LocalKey, otp?: LocalKey,
) {
  const state = await decodeLocalKeys(key, identity, preKey, otp);
  assertCurrent();
  await migrateLocalEditKeys(key, record, assertCurrent);
  assertCurrent();
  publishUnlockedKeys(key, vaultId, state.identityKeyPair, state.signedPreKey, state.otpState);
}

async function decodeLocalKeys(encKey: CryptoKey, identityRecord?: LocalKey, spkRecord?: LocalKey, otpRecord?: LocalKey) {
  // Decrypt identity key pair
  if (!identityRecord) throw new Error("Identity key not found");
  const { iv: idIv, ciphertext: idCt } = JSON.parse(identityRecord.data);
  const idBytes = await decryptData(encKey, idIv, idCt);
  const identityKeyPair = deserializeIdentityKeyPair(JSON.parse(new TextDecoder().decode(idBytes)));

  // Decrypt signed pre-key
  let signedPreKey: SignedPreKey | null = null;
  if (spkRecord) {
    const { iv, ciphertext } = JSON.parse(spkRecord.data);
    const spkBytes = await decryptData(encKey, iv, ciphertext);
    const spkData = JSON.parse(new TextDecoder().decode(spkBytes));
    signedPreKey = {
      id: spkData.id,
      keyPair: { publicKey: fromBase64Url(spkData.publicKey), privateKey: fromBase64Url(spkData.privateKey) },
      signature: fromBase64Url(spkData.signature),
    };
  }

  const otpState = await readOneTimePreKeyState(encKey, otpRecord);
  return { identityKeyPair, signedPreKey, otpState };
}

function publishUnlockedKeys(
  encKey: CryptoKey, vaultId: string, identityKeyPair: IdentityKeyPair, signedPreKey: SignedPreKey | null,
  otpState: Awaited<ReturnType<typeof readOneTimePreKeyState>>,
) {
  _vaultId = vaultId;
  _otpNextId = otpState.nextId;
  _pendingOTPIds = otpState.pendingIds;
  _identityKeyPair = identityKeyPair;
  _signedPreKey = signedPreKey;
  _oneTimePreKeys = otpState.keys;
  setLocalEncryptionKey(encKey);
  _unlockGeneration++;
  installActivityListeners();
}

export async function listLocalUnlockMethods(): Promise<UnlockMethod[]> {
  const record = await getKey(DB_ENCRYPTION_KEY_ID);
  return readVault(record)?.slots.map(slot => slot.method) ?? (record?.type === "salt" ? ["password"] : []);
}

export async function localPasskeyUnlockId(): Promise<string | undefined> {
  return readVault(await getKey(DB_ENCRYPTION_KEY_ID))?.slots.find(slot => slot.method === "passkey")?.credentialId;
}

export async function hasPendingNativeUnlockRemoval(): Promise<boolean> {
  return !!readVault(await getKey(DB_ENCRYPTION_KEY_ID))?.pendingNativeRemoval ||
    !!(await pendingNativeEnrollmentIds()).length || !!(await pendingResetNativeKeyIds()).length;
}

export async function isOnlyLocalPasskeyUnlock(credentialId: string): Promise<boolean> {
  const slots = readVault(await getKey(DB_ENCRYPTION_KEY_ID))?.slots;
  return !!slots?.some(slot => slot.method === "passkey" && slot.credentialId === credentialId) &&
    !slots.some(slot => slot.method !== "passkey" && unlockMethodAvailable(slot.method));
}

export function bindLocalUnlockEnrollment(isCurrent: () => boolean = () => true) {
  const startingKey = _encryptionKey;
  const startingVaultId = _vaultId;
  const assertCurrent = () => {
    if (!startingKey || _encryptionKey !== startingKey || _vaultId !== startingVaultId || !isCurrent()) {
      throw new KeysLockedError();
    }
  };
  assertCurrent();
  return async (setup: UnlockSetup, { retireNative = false } = {}): Promise<void> => {
    assertCurrent();
    await commitUnlockSlot(setup, assertCurrent, async () => {
      const { vault, record, key } = await unlockedVault();
      assertCurrent();
      if (setup.method === "native" && vault.slots.some(slot => slot.method === "native")) {
        throw new Error("Native unlock is already enrolled");
      }
      return { key, save: async slot => {
        const retired = retireNative && slot.method === "password" ? vault.slots.find(entry => entry.method === "native") : undefined;
        vault.slots = [...vault.slots.filter(entry => entry.method !== setup.method && entry !== retired), slot];
        await saveKeys([vaultRecord(vault)], [record], undefined, assertCurrent,
          slot.method === "native" ? { enrolled: slot.keyId } : retired ? { remove: retired.keyId } : undefined);
        if (retired) void retryNativeKeyCleanup().catch(() => undefined);
      } };
    });
    notifyUnlockMethodsChanged();
  };
}

export async function enrollLocalUnlockMethod(setup: UnlockSetup): Promise<void> {
  await bindLocalUnlockEnrollment()(setup);
}

export async function removeLocalUnlockMethod(method: UnlockMethod, isCurrent: () => boolean = () => true): Promise<void> {
  const snapshot = await unlockedVault();
  const assertCurrent = () => {
    if (_encryptionKey !== snapshot.key || _vaultId !== snapshot.vault.id || !isCurrent()) throw new KeysLockedError();
  };
  assertCurrent();
  if (method !== "native") return removeUnlockSlot(method, snapshot, assertCurrent);
  await withNativeKeyLock(async canRecoverEnrollment => {
    const record = await getKey(DB_ENCRYPTION_KEY_ID);
    assertCurrent();
    if (!sameLocalKey(record, snapshot.record)) throw new Error("Local keys changed in another session");
    await removeUnlockSlot(method, snapshot, assertCurrent);
    const failures = await drainNativeKeyJournal(canRecoverEnrollment);
    if (failures.length) throw failures[0];
    if (await hasPendingNativeUnlockRemoval()) throw new Error("Native unlock cleanup is still pending");
  });
}

async function removeUnlockSlot(
  method: UnlockMethod, { vault, record, key }: Awaited<ReturnType<typeof unlockedVault>>, assertCurrent: () => void,
): Promise<void> {
  const slot = vault.slots.find(entry => entry.method === method);
  if (!slot) return;
  const remaining = vault.slots.filter(slot => slot.method !== method);
  if (!remaining.some(slot => slot.method === "password")) {
    const alternate = remaining.find(slot => unlockMethodAvailable(slot.method));
    if (!alternate) throw new Error("Keep at least one unlock method");
    // Authenticate the alternative against the actual vault key before dropping the fallback.
    const candidate = await unwrapUnlockSlot(alternate);
    const proof = await encryptData(key, new Uint8Array(0));
    await decryptData(candidate, proof.iv, proof.ciphertext);
  }
  vault.slots = remaining;
  await saveKeys([vaultRecord(vault)], [record], undefined, assertCurrent, slot.method === "native" ? { remove: slot.keyId } : undefined);
  notifyUnlockMethodsChanged();
}

async function unlockedVault(): Promise<{ vault: DeviceVault; record: LocalKey; key: CryptoKey }> {
  const key = _encryptionKey;
  const record = await getKey(DB_ENCRYPTION_KEY_ID);
  const vault = readVault(record);
  if (!key || key !== _encryptionKey || !record || !vault || vault.id !== _vaultId) throw new KeysLockedError();
  return { vault, record, key };
}

async function readOneTimePreKeyState(encKey: CryptoKey, otpRecord?: LocalKey): Promise<{
  keys: OneTimePreKey[];
  nextId: number;
  pendingIds: Set<number>;
}> {
  let keys: OneTimePreKey[] = [];
  if (otpRecord) {
    const { iv, ciphertext } = JSON.parse(otpRecord.data);
    const otpBytes = await decryptData(encKey, iv, ciphertext);
    const otpData: { id: number; publicKey: string; privateKey: string }[] = JSON.parse(new TextDecoder().decode(otpBytes));
    keys = otpData.map((k) => ({
      id: k.id,
      keyPair: { publicKey: fromBase64Url(k.publicKey), privateKey: fromBase64Url(k.privateKey) },
    }));
  }
  const nextIdRecord = await getKey(OTP_NEXT_ID);
  const pendingRecord = await getKey(OTP_PENDING_IDS);
  return {
    keys,
    nextId: Math.max(Number(nextIdRecord?.data) || 1, ...keys.map((k) => k.id + 1)),
    pendingIds: new Set(pendingRecord ? JSON.parse(pendingRecord.data) as number[] : []),
  };
}

/**
 * Every tab keeps its own in-memory OTP set, so all OTP mutations (generate, upload, consume)
 * run under one cross-tab lock and start from the latest IndexedDB copy. Otherwise two tabs can
 * mint the same key ids with different private keys, or one tab's save can drop the other's keys.
 */
let _otpLockChain: Promise<unknown> = Promise.resolve();
function withOneTimePreKeyLock<T>(fn: () => Promise<T>): Promise<T> {
  // In-tab queue first (also covers browsers without Web Locks), then the cross-tab lock.
  const run = () => (typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("e2ee-otp", fn) as Promise<T>
    : fn());
  const result = _otpLockChain.then(run, run);
  _otpLockChain = result.catch(() => undefined);
  return result;
}

/** Replace the in-memory OTP state with the persisted copy. Call only under the OTP lock. */
async function reloadOneTimePreKeys(encKey: CryptoKey): Promise<void> {
  await _otpWrites;
  const state = await readOneTimePreKeyState(encKey, await getKey(OTP_KEYS_ID));
  if (_encryptionKey !== encKey) throw new KeysLockedError("Keys were locked during reload");
  const removals = state.keys.filter((k) => _deferredOTPRemovals.has(k.id));
  _oneTimePreKeys = removals.length > 0 ? state.keys.filter((k) => !_deferredOTPRemovals.has(k.id)) : state.keys;
  _otpNextId = state.nextId;
  _pendingOTPIds = state.pendingIds;
  if (removals.length > 0) {
    for (const key of removals) _pendingOTPIds.delete(key.id);
    await persistOneTimePreKeys();
  }
  _deferredOTPRemovals.clear();
}

/**
 * Like peekOneTimePreKey, but on a miss re-reads the persisted set: another tab may have
 * generated and published the key after this tab unlocked.
 */
export async function findOneTimePreKey(id: number): Promise<OneTimePreKey | undefined> {
  const cached = peekOneTimePreKey(id);
  if (cached) return cached;
  const encKey = _encryptionKey;
  if (!encKey) return undefined;
  await withOneTimePreKeyLock(() => reloadOneTimePreKeys(encKey));
  return peekOneTimePreKey(id);
}

export class KeysLockedError extends Error {
  constructor(message = "Keys not loaded — call loadKeys() first") { super(message); this.name = "KeysLockedError"; }
}

/** Returns the in-memory identity key pair (must have called loadKeys/initializeKeys first). */
export function getIdentityKeyPair(): IdentityKeyPair {
  if (!_identityKeyPair) throw new KeysLockedError();
  resetIdleTimer();
  return _identityKeyPair;
}

export function getSignedPreKey(): SignedPreKey | null {
  if (_signedPreKey) resetIdleTimer();
  return _signedPreKey;
}

export async function signWithIdentityKey(payload: string | Uint8Array): Promise<string> {
  if (!_identityKeyPair) throw new KeysLockedError();
  resetIdleTimer();
  const bytes = typeof payload === "string" ? Uint8Array.from(new TextEncoder().encode(payload)) : payload;
  const signature = await sign(_identityKeyPair.privateEd25519, bytes);
  return toBase64Url(signature);
}

export function peekOneTimePreKey(id: number): OneTimePreKey | undefined {
  const key = _oneTimePreKeys.find((k) => k.id === id);
  if (key) resetIdleTimer();
  return key;
}

/** Serialize encrypted snapshots so concurrent mutations cannot overwrite newer state. */
function persistOneTimePreKeys(): Promise<void> {
  const encKey = _encryptionKey;
  if (!encKey) return Promise.reject(new KeysLockedError("Keys not loaded"));
  const data = JSON.stringify(_oneTimePreKeys.map((k) => ({
    id: k.id,
    publicKey: toBase64Url(k.keyPair.publicKey),
    privateKey: toBase64Url(k.keyPair.privateKey),
  })));
  const nextId = _otpNextId;
  const pendingIds = JSON.stringify([..._pendingOTPIds]);
  const write = _otpWrites.then(async () => {
    const encrypted = await encryptData(encKey, new TextEncoder().encode(data));
    await saveKeys([
      { id: OTP_KEYS_ID, type: "otpKeys", data: JSON.stringify(encrypted) },
      { id: OTP_NEXT_ID, type: OTP_NEXT_ID, data: String(nextId) },
      { id: OTP_PENDING_IDS, type: OTP_PENDING_IDS, data: pendingIds },
    ]);
  });
  // A failed write is reported to its caller without poisoning later writes.
  _otpWrites = write.catch(() => undefined);
  return write;
}

/**
 * Remove a one-time pre-key and persist its removal before returning. Never rejects: if the
 * removal cannot be persisted now it is deferred (see _deferredOTPRemovals).
 */
export async function consumeOneTimePreKey(id: number): Promise<void> {
  const encKey = _encryptionKey;
  if (!encKey) return;
  try {
    await withOneTimePreKeyLock(async () => {
      await reloadOneTimePreKeys(encKey);
      const idx = _oneTimePreKeys.findIndex((k) => k.id === id);
      if (idx === -1) return;
      resetIdleTimer();
      _oneTimePreKeys.splice(idx, 1);
      _pendingOTPIds.delete(id);
      await persistOneTimePreKeys();
    });
  } catch (error) {
    // This runs after the message and its receive state were committed, so it must never fail:
    // the ratchet has advanced and the message could not be decrypted again. If the keys were
    // locked meanwhile there is nothing left to clean up in memory.
    if (_encryptionKey !== encKey) return;
    // Otherwise the stored pool could not be read or written. This tab's copy may be older than
    // it (another tab may have added keys), so never persist it over a pool we could not read:
    // drop the key from memory and persist the removal after the next successful reload.
    console.error("Deferring one-time pre-key removal", error);
    _deferredOTPRemovals.add(id);
    _oneTimePreKeys = _oneTimePreKeys.filter((k) => k.id !== id);
    _pendingOTPIds.delete(id);
  }
}

/** Key ids a 409 from /api/keys/replenish reports as consumed with a different public key. */
function getConflictingKeyIds(error: unknown): number[] {
  const { status, body } = (error ?? {}) as { status?: unknown; body?: { conflictingKeyIds?: unknown } | null };
  if (status !== 409 || !Array.isArray(body?.conflictingKeyIds)) return [];
  return body.conflictingKeyIds.filter((id): id is number => Number.isSafeInteger(id) && id >= 0);
}

/** Network maintenance must run only after authentication and local unlock. */
export function runPostUnlockKeyMaintenance(): Promise<void> {
  if (_maintenance) return _maintenance;
  const encKey = _encryptionKey;
  if (!encKey) return Promise.reject(new KeysLockedError("Keys not loaded"));
  const ensureUnlocked = () => {
    if (_encryptionKey !== encKey) throw new KeysLockedError("Keys were locked during maintenance");
  };
  // Local OTP state is read and changed only under the cross-tab lock, starting from the
  // persisted copy (other tabs may have generated or consumed keys). Network requests run
  // outside the lock so a slow or hung request cannot stall message decryption in any tab.
  const locked = <T>(fn: () => T | Promise<T>): Promise<T> => withOneTimePreKeyLock(async () => {
    ensureUnlocked();
    await reloadOneTimePreKeys(encKey);
    return fn();
  });
  const maintenance = (async () => {
    const start = await locked(() => ({ nextId: _otpNextId, hadPending: _pendingOTPIds.size > 0 }));
    // Highest id allocation this run knows about; a change means another tab generated keys.
    let seenNextId = start.nextId;
    let publishedOwnBundle = false;
    const bundleWasPublished = _bundlePublished;
    const countRes = await api.get<{ count: number; hasBundle?: boolean }>("/api/keys/count");
    ensureUnlocked();
    if (countRes.hasBundle === false) {
      // A count request started before a successful upload can return stale data.
      if (bundleWasPublished) _bundlePublished = false;
      await locked(async () => {
        if (_oneTimePreKeys.length > 0) return;
        const newKeys = await generateOneTimePreKeys(_otpNextId, OTP_KEY_POOL_SIZE);
        ensureUnlocked();
        _oneTimePreKeys.push(...newKeys);
        _otpNextId += newKeys.length;
        seenNextId = _otpNextId;
        await persistOneTimePreKeys();
      });
      ensureUnlocked();
      // Everything in memory was just read from (or written to) IndexedDB under the lock, and the
      // bundle is built synchronously from it, so only persisted private keys are published.
      const bundleKeyIds = _oneTimePreKeys.map((key) => key.id);
      await uploadPreKeyBundle();
      ensureUnlocked();
      await locked(async () => {
        for (const id of bundleKeyIds) _pendingOTPIds.delete(id);
        await persistOneTimePreKeys();
      });
      countRes.count = bundleKeyIds.length;
      publishedOwnBundle = true;
    }

    const pendingKeys = await locked(async () => {
      // The count predates anything another tab generated or published since this run started;
      // topping up from it would over-fill the pool, so leave that to the next run.
      const countIsStale = _otpNextId !== seenNextId
        || (start.hadPending && !publishedOwnBundle && _pendingOTPIds.size === 0);
      if (_pendingOTPIds.size === 0 && !countIsStale && countRes.count < OTP_KEY_REPLENISH_THRESHOLD) {
        const nextId = Math.max(_otpNextId, ..._oneTimePreKeys.map((k) => k.id + 1));
        const newKeys = await generateOneTimePreKeys(nextId, OTP_KEY_POOL_SIZE - countRes.count);
        ensureUnlocked();
        _oneTimePreKeys.push(...newKeys);
        _otpNextId = nextId + newKeys.length;
        for (const key of newKeys) _pendingOTPIds.add(key.id);
        // Always save private halves (and their pending ids) before publishing public halves.
        await persistOneTimePreKeys();
      }
      // Pending ids came from IndexedDB, so a failed or interrupted upload is retried by any tab.
      return _oneTimePreKeys.filter((key) => _pendingOTPIds.has(key.id));
    });
    ensureUnlocked();

    if (pendingKeys.length > 0) {
      try {
        await api.post("/api/keys/replenish", { oneTimePreKeys: serializeOneTimePreKeys(pendingKeys) });
      } catch (error) {
        const conflictingIds = getConflictingKeyIds(error);
        if (conflictingIds.length === 0) throw error;
        // The server already handed those ids to peers with other public keys and stored nothing
        // from this upload. These private halves can never be used: drop them and never mint the
        // ids again. The rest stays pending, so the next run uploads it and refills the pool.
        ensureUnlocked();
        await locked(async () => {
          const conflicting = new Set(conflictingIds);
          _oneTimePreKeys = _oneTimePreKeys.filter((key) => !conflicting.has(key.id));
          for (const id of conflicting) _pendingOTPIds.delete(id);
          _otpNextId = Math.max(_otpNextId, ...conflictingIds.map((id) => id + 1));
          await persistOneTimePreKeys();
        });
        throw error;
      }
      ensureUnlocked();
      await locked(async () => {
        for (const key of pendingKeys) _pendingOTPIds.delete(key.id);
        await persistOneTimePreKeys();
      });
    }
  })().finally(() => {
    if (_maintenance === maintenance) _maintenance = null;
  });
  _maintenance = maintenance;
  return maintenance;
}

/** Changes every time this tab unlocks its keys (initializeKeys or loadKeys), and only then. */
export function getUnlockGeneration(): number {
  return _unlockGeneration;
}

/** Check if keys are loaded in memory */
export function keysLoaded(): boolean {
  return _identityKeyPair !== null;
}

/**
 * Returns true when encrypted key material exists in IndexedDB for this browser.
 */
export async function hasLocalKeyMaterial(): Promise<boolean> {
  const [saltRecord, identityRecord] = await Promise.all([
    getKey(DB_ENCRYPTION_KEY_ID),
    getKey(IDENTITY_KEY_ID),
  ]);
  return !!saltRecord || !!identityRecord;
}

/** Snapshot the encrypted identity record, or the vault record for a partial vault. */
export async function getLocalVaultKey(): Promise<LocalKey | undefined> {
  return await getKey(IDENTITY_KEY_ID) ?? await getKey(DB_ENCRYPTION_KEY_ID);
}

export function lockLocalCryptoState(): void {
  _lockEpoch++;
  _vaultId = null;
  if (_idleTimer !== null) window.clearTimeout(_idleTimer);
  _idleTimer = null;
  idleHolds.clear();
  window.removeEventListener("pointerdown", onActivity);
  window.removeEventListener("keydown", onActivity);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  _identityKeyPair = null;
  _signedPreKey = null;
  _oneTimePreKeys = [];
  setLocalEncryptionKey(null);
  _pendingOTPIds = new Set();
  _deferredOTPRemovals.clear();
  _maintenance = null;
  _bundleUpload = null;
  _bundlePublished = false;
  clearRegisteredLocalCallState();
}

function nativeKeyForCleanup(record: LocalKey | undefined): string | undefined {
  const vault = readVault(record);
  return vault?.slots.find(slot => slot.method === "native")?.keyId ?? vault?.pendingNativeRemoval;
}

export async function retryNativeKeyCleanup({ background = true } = {}): Promise<void> {
  await withNativeKeyLock(async canRecoverEnrollment => {
    const failures = await drainNativeKeyJournal(canRecoverEnrollment);
    if (!background && failures.length) throw failures[0];
  }, background);
}

async function drainNativeKeyJournal(canRecoverEnrollment: boolean, signal?: AbortSignal): Promise<unknown[]> {
  // The lease also coordinates removal-only documents that lack Web Locks.
  // Expiry can repeat an idempotent removal and never authorizes recovery of an enrollment.
  const owner = crypto.randomUUID();
  if (!await claimNativeCleanup(owner)) return [];
  try { return await drainClaimedNativeJournal(owner, canRecoverEnrollment, signal); }
  finally { await releaseNativeCleanup(owner); }
}

async function drainClaimedNativeJournal(owner: string, canRecoverEnrollment: boolean, signal?: AbortSignal): Promise<unknown[]> {
  // Older clients stored interrupted removals on the vault itself.
  const record = await getKey(DB_ENCRYPTION_KEY_ID);
  const vault = readVault(record);
  const legacyRemoval = vault?.pendingNativeRemoval;
  if (record && vault && legacyRemoval) {
    delete vault.pendingNativeRemoval;
    await saveKeys([vaultRecord(vault)], [record], undefined, undefined, { remove: legacyRemoval });
  }
  if (canRecoverEnrollment) {
    for (const keyId of await pendingNativeEnrollmentIds()) await abandonNativeEnrollment(keyId);
  }
  const failures: unknown[] = [];
  for (const keyId of await pendingResetNativeKeyIds()) {
    assertNotAborted(signal);
    if (!await claimNativeCleanup(owner, true)) break;
    try {
      if (signal) await biometricUnlock.remove(keyId, signal);
      else await biometricUnlock.remove(keyId);
      await clearResetNativeKeyId(keyId);
      notifyUnlockMethodsChanged();
    }
    catch (error) { failures.push(error); }
  }
  return failures;
}

/** Clears local crypto state, including orphaned key material after a failed registration. */
export async function resetLocalCryptoState(expectedSetupId?: string, expectedVaultId?: string): Promise<boolean> {
  const recoveryKey = _encryptionKey;
  const recoveryVaultId = _vaultId;
  lockLocalCryptoState();
  const cleared = await withOneTimePreKeyLock(async () => {
    await _otpWrites;
    const record = await getKey(DB_ENCRYPTION_KEY_ID);
    const vault = readVault(record);
    if (expectedVaultId && vault?.id !== expectedVaultId) return false;
    const recovery = recoveryKey && record && vault?.id === recoveryVaultId ? { key: recoveryKey, vault: record } : undefined;
    return clearCryptoState(expectedSetupId, expectedVaultId ? record : undefined, nativeKeyForCleanup, recovery);
  });
  if (cleared) void retryNativeKeyCleanup().catch(() => undefined);
  return cleared;
}

/** Use after the user confirms that local history and keys should be erased. */
export async function resetLocalDevice(expectedKey?: LocalKey): Promise<boolean> {
  const cleared = await withOneTimePreKeyLock(() => clearAll(expectedKey, lockLocalCryptoState, nativeKeyForCleanup));
  if (cleared) void retryNativeKeyCleanup().catch(() => undefined);
  return cleared;
}
