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
  PBKDF2_ITERATIONS,
  type DeviceLinkPublicBundle,
} from "@e2ee-chat/shared";
import { saveKey, saveKeys, getKey, clearCryptoState } from "../db/index.js";
import { api } from "../services/api.js";

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
let _encryptionKey: CryptoKey | null = null;
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
let _idleTimer: ReturnType<typeof window.setTimeout> | null = null;
let _lastActivityReset = 0;
const _lockListeners = new Set<() => void>();

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
  _idleTimer = window.setTimeout(() => {
    lockLocalCryptoState();
    for (const listener of _lockListeners) listener();
  }, IDLE_LOCK_MS);
}

function asArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

/** Derive an AES-256 encryption key from the user's password and a stored salt. */
async function deriveEncryptionKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", asArrayBufferView(new TextEncoder().encode(password)), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: asArrayBufferView(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptData(key: CryptoKey, data: Uint8Array): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBufferView(iv) },
    key,
    asArrayBufferView(data),
  );
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(encrypted)) };
}

async function decryptData(key: CryptoKey, iv: string, ciphertext: string): Promise<Uint8Array> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBufferView(fromBase64Url(iv)) },
    key,
    asArrayBufferView(fromBase64Url(ciphertext)),
  );
  return new Uint8Array(decrypted);
}

/**
 * Called on first registration. Generates all key material, encrypts private keys
 * with a password-derived key, and stores it in IndexedDB.
 *
 * Returns the public identity key (base64url) for the registration API call.
 * The pre-key bundle is uploaded after auth succeeds via uploadPreKeyBundle().
 */
export async function initializeKeys(password: string): Promise<string> {
  lockLocalCryptoState();
  await _otpWrites;
  // Generate a random salt and derive the IndexedDB encryption key
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encKey = await deriveEncryptionKey(password, salt);

  // Generate key material
  const identityKeyPair = await generateIdentityKeyPair();
  const signedPreKey = await generateSignedPreKey(1, identityKeyPair.privateEd25519);
  const oneTimePreKeys = await generateOneTimePreKeys(1, OTP_KEY_POOL_SIZE);

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

  // A failed initialization must leave either the old records or no records.
  await saveKeys([
    { id: DB_ENCRYPTION_KEY_ID, type: "salt", data: toBase64Url(salt) },
    { id: IDENTITY_KEY_ID, type: "identity", data: JSON.stringify({ iv, ciphertext }) },
    { id: SIGNED_PRE_KEY_ID, type: "signedPreKey", data: JSON.stringify(spkEnc) },
    { id: OTP_KEYS_ID, type: "otpKeys", data: JSON.stringify(otpEnc) },
    { id: OTP_NEXT_ID, type: OTP_NEXT_ID, data: String(nextId) },
    { id: OTP_PENDING_IDS, type: OTP_PENDING_IDS, data: "[]" },
  ]);

  // Publish the unlocked cache only after the complete key set is committed.
  _identityKeyPair = identityKeyPair;
  _signedPreKey = signedPreKey;
  _oneTimePreKeys = oneTimePreKeys;
  _encryptionKey = encKey;
  _unlockGeneration++;
  _otpNextId = nextId;
  _pendingOTPIds = new Set();
  installActivityListeners();

  // Return public identity key for registration
  return toBase64Url(identityKeyPair.publicEd25519);
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

  return {
    deviceName,
    identityKey: toBase64Url(_identityKeyPair.publicEd25519),
    signedPreKey: toBase64Url(_signedPreKey.keyPair.publicKey),
    signedPreKeyId: _signedPreKey.id,
    signedPreKeySig: toBase64Url(_signedPreKey.signature),
    oneTimePreKeys: serializeOneTimePreKeys(_oneTimePreKeys),
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

/**
 * Called on login. Decrypts private keys from IndexedDB using the password.
 * Populates the in-memory key cache.
 */
export async function loadKeys(password: string): Promise<void> {
  lockLocalCryptoState();
  await _otpWrites;
  const saltRecord = await getKey(DB_ENCRYPTION_KEY_ID);
  if (!saltRecord) throw new Error("No keys found — register first");

  const salt = fromBase64Url(saltRecord.data);
  const encKey = await deriveEncryptionKey(password, salt);

  // Decrypt identity key pair
  const identityRecord = await getKey(IDENTITY_KEY_ID);
  if (!identityRecord) throw new Error("Identity key not found");
  const { iv: idIv, ciphertext: idCt } = JSON.parse(identityRecord.data);
  const idBytes = await decryptData(encKey, idIv, idCt);
  const identityKeyPair = deserializeIdentityKeyPair(JSON.parse(new TextDecoder().decode(idBytes)));

  // Decrypt signed pre-key
  const spkRecord = await getKey(SIGNED_PRE_KEY_ID);
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

  const otpState = await readOneTimePreKeyState(encKey);
  _otpNextId = otpState.nextId;
  _pendingOTPIds = otpState.pendingIds;
  _identityKeyPair = identityKeyPair;
  _signedPreKey = signedPreKey;
  _oneTimePreKeys = otpState.keys;
  _encryptionKey = encKey;
  _unlockGeneration++;
  installActivityListeners();
}

async function readOneTimePreKeyState(encKey: CryptoKey): Promise<{
  keys: OneTimePreKey[];
  nextId: number;
  pendingIds: Set<number>;
}> {
  const otpRecord = await getKey(OTP_KEYS_ID);
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
  const state = await readOneTimePreKeyState(encKey);
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
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
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

export function lockLocalCryptoState(): void {
  if (_idleTimer !== null) window.clearTimeout(_idleTimer);
  _idleTimer = null;
  window.removeEventListener("pointerdown", onActivity);
  window.removeEventListener("keydown", onActivity);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  _identityKeyPair = null;
  _signedPreKey = null;
  _oneTimePreKeys = [];
  _encryptionKey = null;
  _pendingOTPIds = new Set();
  _deferredOTPRemovals.clear();
  _maintenance = null;
  _bundleUpload = null;
  _bundlePublished = false;
}

/**
 * Clears all locally stored crypto state.
 * Use after failed registration to avoid keeping orphaned key material.
 */
export async function resetLocalCryptoState(): Promise<void> {
  lockLocalCryptoState();
  await _otpWrites;
  await clearCryptoState();
}
