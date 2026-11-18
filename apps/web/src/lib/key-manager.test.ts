import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAESKey, toBase64Url } from "@e2ee-chat/crypto";
import { OTP_KEY_POOL_SIZE } from "@e2ee-chat/shared";
import { strictWebCrypto } from "../../../../packages/crypto/src/test/strict-webcrypto.js";

vi.mock("../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

let keys: typeof import("./key-manager.js");
let db: typeof import("../db/index.js");
let api: typeof import("../services/api.js")["api"];
const password = "correct horse battery staple";

function mockWebLocks() {
  const held = new Set<string>();
  const request = async <T>(name: string, options: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>) => {
    const run = typeof options === "function" ? options : callback!;
    if (held.has(name) && typeof options !== "function" && options.ifAvailable) return run(null);
    if (held.has(name)) throw new Error(`Unexpected overlapping lock: ${name}`);
    held.add(name);
    try { return await run({ name, mode: "exclusive" }); }
    finally { held.delete(name); }
  };
  vi.stubGlobal("navigator", { userAgent: navigator.userAgent, locks: { request } });
  return { request };
}

async function reload() {
  keys.lockLocalCryptoState();
  (await db.getAppDB()).close();
  vi.resetModules();
  keys = await import("./key-manager.js");
  db = await import("../db/index.js");
  api = (await import("../services/api.js")).api;
  await keys.loadKeys(password);
}

beforeEach(async () => {
  vi.resetModules();
  keys = await import("./key-manager.js");
  db = await import("../db/index.js");
  api = (await import("../services/api.js")).api;
  vi.mocked(api.get).mockReset().mockResolvedValue({ count: OTP_KEY_POOL_SIZE, hasBundle: true });
  vi.mocked(api.post).mockReset().mockResolvedValue({});
});

afterEach(async () => {
  keys.lockLocalCryptoState();
  vi.useRealTimers();
  (await db.getAppDB()).close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("e2ee-chat");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("erases offline history, cached attachments and the outbox only on full device reset", async () => {
  const { Blob } = await vi.importActual<{ Blob: typeof globalThis.Blob }>("node:buffer");
  vi.stubGlobal("Blob", Blob);
  await keys.initializeKeys(password);
  await db.saveQueuedMessage({
    id: "message", conversationId: "chat", senderId: "user", type: "text", content: "cached plaintext",
    timestamp: 1, expiresAt: null, status: "sending",
  }, {
    id: "message", queuedAt: 1, userId: "user", deviceId: "device", conversationId: "chat",
    conversationType: "direct", ttlSeconds: null, steps: [], attempts: 0, status: "sending",
    retryable: true, nextAttemptAt: null, error: null,
  });
  const sealed = await keys.sealCachedAttachment("user", "file", new Blob(["attachment"]));
  const files = (await db.getAppDB()).transaction("accountFiles", "readwrite");
  await db.writeCachedFile(files.store, { id: "file", ownerId: "user", cachedAt: 1, expiresAt: Date.now() + 60_000, sealed });
  await files.done;
  await keys.resetLocalCryptoState();
  expect(await db.getMessageById("message")).toMatchObject({ content: "cached plaintext" });
  expect(await db.getCachedFile("file", "user")).toBeDefined();
  expect(await db.getOutgoing("message")).toBeDefined();

  await keys.initializeKeys(password);
  await keys.resetLocalDevice();
  expect(keys.keysLoaded()).toBe(false);
  expect(await keys.hasLocalKeyMaterial()).toBe(false);
  expect(await db.getMessageById("message")).toBeUndefined();
  expect(await db.getCachedFile("file", "user")).toBeUndefined();
  expect(await db.getOutgoing("message")).toBeUndefined();
});

it("checks the captured vault inside the all-store reset transaction", async () => {
  await keys.initializeKeys(password);
  const captured = (await keys.getLocalVaultKey())!;
  const appDb = await db.getAppDB();
  await appDb.put("displayMessages", { id: "message", ownerId: "user", conversationId: "chat", senderId: "user", type: "text",
    content: "cached plaintext", timestamp: 1, expiresAt: null, status: "received" });
  const replacement = { ...captured, data: "other encrypted identity" };
  const transaction = IDBDatabase.prototype.transaction;
  const intercept = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase, stores, mode, options,
  ) {
    if (Array.isArray(stores) && stores.includes("legacyMessages") && stores.includes("deviceKeys") && mode === "readwrite") {
      transaction.call(this, "deviceKeys", "readwrite").objectStore("deviceKeys").put(replacement);
    }
    return transaction.call(this, stores, mode, options);
  });
  await expect(keys.resetLocalDevice(captured)).resolves.toBe(false);
  intercept.mockRestore();
  expect(keys.keysLoaded()).toBe(true);
  expect(await keys.getLocalVaultKey()).toEqual(replacement);
  expect(await db.getMessageById("message")).toMatchObject({ content: "cached plaintext" });
  await expect(keys.resetLocalDevice(replacement)).resolves.toBe(true);
  expect(await db.getMessageById("message")).toBeUndefined();
});

it.each(["Web Locks", "one privileged document"] as const)("journals before native IPC and commits the slot under %s", async mode => {
  if (mode === "Web Locks") mockWebLocks();
  else {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlockSingleDocument: true });
  }
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  const remove = vi.spyOn(biometricUnlock, "remove").mockResolvedValue();
  const enroll = vi.spyOn(biometricUnlock, "enroll").mockImplementation(async keyId => {
    expect(await db.pendingNativeEnrollmentIds()).toEqual([keyId]);
    const legacyRange = IDBKeyRange.bound("native-unlock:remove:", "native-unlock:remove:\uffff");
    const legacyIds = await (await db.getAppDB()).getAllKeys("accountState", legacyRange);
    expect(legacyIds).toEqual([]);
    expect(await keys.listLocalUnlockMethods()).toEqual(["password"]);
    await keys.retryNativeKeyCleanup();
    expect(remove).not.toHaveBeenCalled();
  });
  await keys.initializeKeys(password);
  await keys.enrollLocalUnlockMethod({ method: "native" });
  expect(enroll).toHaveBeenCalledOnce();
  expect(await keys.listLocalUnlockMethods()).toEqual(["password", "native"]);
  expect(await db.pendingNativeEnrollmentIds()).toEqual([]);
  expect(await db.pendingResetNativeKeyIds()).toEqual([]);
  await keys.retryNativeKeyCleanup();
  expect(remove).not.toHaveBeenCalled();
});

it.each(["existing vault", "new device", "native failure"] as const)("recovers journaled enrollment after an interrupted %s", async mode => {
  mockWebLocks();
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  const fresh = mode === "new device";
  if (!fresh) await keys.initializeKeys(password);
  const commit = fresh ? (await keys.prepareDeviceKeySetup("Phone", "ios")).commit : keys.enrollLocalUnlockMethod;
  const items = new Set<string>();
  const enroll = vi.spyOn(biometricUnlock, "enroll").mockImplementation(async id => {
    expect(await db.pendingNativeEnrollmentIds()).toEqual([id]);
    expect(await db.pendingResetNativeKeyIds()).toEqual([]);
    items.add(id);
    if (mode === "native failure") throw new Error("native verification failed");
  });
  const failedRemove = vi.spyOn(biometricUnlock, "remove").mockRejectedValue(new Error("keystore unavailable"));
  const deleteRecord = IDBObjectStore.prototype.delete;
  const interrupt = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, id) {
    const request = deleteRecord.call(this, id);
    if (this.name === "accountState" && this.transaction.objectStoreNames.contains("deviceKeys") &&
        id === `native-unlock:enroll:${enroll.mock.calls[0]?.[0]}`) {
      request.addEventListener("success", () => this.transaction.abort(), { once: true });
    }
    return request;
  });
  try { await expect(commit({ method: "native" })).rejects.toThrow(); }
  finally { interrupt.mockRestore(); }
  const id = enroll.mock.calls[0][0];
  expect(failedRemove).toHaveBeenCalledExactlyOnceWith(id);
  expect(await db.pendingNativeEnrollmentIds()).toEqual([]);
  expect(await db.pendingResetNativeKeyIds()).toEqual([id]);
  expect(await keys.listLocalUnlockMethods()).toEqual(fresh ? [] : ["password"]);

  keys.lockLocalCryptoState();
  (await db.getAppDB()).close();
  vi.resetModules();
  keys = await import("./key-manager.js");
  db = await import("../db/index.js");
  const retry = vi.spyOn((await import("../platform/biometric-unlock.js")).biometricUnlock, "remove")
    .mockImplementation(async keyId => { items.delete(keyId); });
  await keys.retryNativeKeyCleanup();
  expect(retry).toHaveBeenCalledExactlyOnceWith(id);
  expect(items.size).toBe(0);
  expect(await db.pendingResetNativeKeyIds()).toEqual([]);
});

it("does not enroll without an exclusive claim and preserves unresolved intents during a removal-only reset", async () => {
  vi.stubGlobal("navigator", {});
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  const enroll = vi.spyOn(biometricUnlock, "enroll").mockResolvedValue();
  const remove = vi.spyOn(biometricUnlock, "remove").mockResolvedValue();
  await keys.initializeKeys(password);
  await expect(keys.enrollLocalUnlockMethod({ method: "native" })).rejects.toMatchObject({ code: "unsupported" });
  expect(enroll).not.toHaveBeenCalled();
  expect(await db.pendingNativeEnrollmentIds()).toEqual([]);
  await db.recordNativeEnrollment("possibly-live");
  await db.recordNativeEnrollment("retired");
  await db.abandonNativeEnrollment("retired");
  await expect(keys.resetLocalDevice()).resolves.toBe(true);
  await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith("retired"));
  expect(await db.pendingNativeEnrollmentIds()).toEqual(["possibly-live"]);
  await vi.waitFor(async () => expect(await db.pendingResetNativeKeyIds()).toEqual([]));
  mockWebLocks();
  await keys.retryNativeKeyCleanup({ background: false });
  expect(remove).toHaveBeenLastCalledWith("possibly-live");
  expect(await db.pendingNativeEnrollmentIds()).toEqual([]);
  expect(await db.pendingResetNativeKeyIds()).toEqual([]);
});

it.each(["device reset", "crypto reset"] as const)("fences a fresh native enrollment during %s", async mode => {
  mockWebLocks();
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  let announce!: (id: string) => void;
  let finish!: () => void;
  const started = new Promise<string>(resolve => { announce = resolve; });
  const prompt = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(biometricUnlock, "enroll").mockImplementation(async id => { announce(id); await prompt; });
  const remove = vi.spyOn(biometricUnlock, "remove").mockResolvedValue();
  const prepared = await keys.prepareDeviceKeySetup("Phone", "ios");
  const commit = prepared.commit({ method: "native" }).catch((error: unknown) => error);
  const id = await started;
  try {
    await expect(mode === "device reset" ? keys.resetLocalDevice() : keys.resetLocalCryptoState()).resolves.toBe(true);
    expect(await db.pendingNativeEnrollmentIds()).toEqual([id]);
    expect(await db.pendingResetNativeKeyIds()).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  } finally { finish(); }
  expect(await commit).toBeInstanceOf(keys.KeysLockedError);
  expect(remove).toHaveBeenCalledExactlyOnceWith(id);
  expect(await keys.listLocalUnlockMethods()).toEqual([]);
  expect(await db.pendingNativeEnrollmentIds()).toEqual([]);
  expect(await db.pendingResetNativeKeyIds()).toEqual([]);
});

it("claims lockless cleanup across documents, recovers an expired claim, and drains IDs in sequence", async () => {
  vi.stubGlobal("navigator", {});
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  for (const id of ["a-fails", "b-cleared", "c-cleared"]) {
    await db.recordNativeEnrollment(id);
    await db.abandonNativeEnrollment(id);
  }
  const remove = vi.spyOn(biometricUnlock, "remove").mockImplementation(async id => {
    // Simulate a competing document through its IndexedDB claim.
    expect(await db.claimNativeCleanup("competing-document")).toBe(false);
    await keys.retryNativeKeyCleanup();
    if (id === "a-fails") throw new Error("temporary removal failure");
  });
  expect(await db.claimNativeCleanup("old-document")).toBe(true);
  await keys.retryNativeKeyCleanup();
  expect(remove).not.toHaveBeenCalled();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  await keys.retryNativeKeyCleanup();
  expect(remove.mock.calls).toEqual([["a-fails"], ["b-cleared"], ["c-cleared"]]);
  expect(await db.pendingResetNativeKeyIds()).toEqual(["a-fails"]);
  remove.mockResolvedValue();
  await keys.retryNativeKeyCleanup();
  expect(await db.pendingResetNativeKeyIds()).toEqual([]);
});

it("reconciles a crashed cleanup claim on the next fresh enrollment attempt after it expires", async () => {
  mockWebLocks();
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  const remove = vi.spyOn(biometricUnlock, "remove").mockResolvedValue();
  const enroll = vi.spyOn(biometricUnlock, "enroll").mockImplementation(async () => {
    expect(remove).toHaveBeenCalledExactlyOnceWith("orphan");
  });
  const prepared = await keys.prepareDeviceKeySetup("Phone", "ios");
  await db.recordNativeEnrollment("orphan");
  expect(await db.claimNativeCleanup("crashed")).toBe(true);
  await keys.retryNativeKeyCleanup();
  await expect(prepared.commit({ method: "native" })).rejects.toThrow("Finish removing");
  expect(remove).not.toHaveBeenCalled();
  expect(enroll).not.toHaveBeenCalled();

  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
  await prepared.commit({ method: "native" });
  expect(enroll).toHaveBeenCalledOnce();
  expect(await keys.hasPendingNativeUnlockRemoval()).toBe(false);
  expect(await keys.listLocalUnlockMethods()).toEqual(["native"]);
});

it("rechecks the cleanup journal after a concurrent enrollment commits without turning off the new slot", async () => {
  mockWebLocks();
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  let announce!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  const prompt = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(biometricUnlock, "enroll").mockImplementation(async () => { announce(); await prompt; });
  const remove = vi.spyOn(biometricUnlock, "remove").mockResolvedValue();
  await keys.initializeKeys(password);
  const enrollment = keys.enrollLocalUnlockMethod({ method: "native" });
  await started;
  let retry: Promise<void>;
  try {
    expect(await keys.hasPendingNativeUnlockRemoval()).toBe(true);
    retry = keys.retryNativeKeyCleanup({ background: false });
  } finally { finish(); }
  await Promise.all([enrollment, retry]);
  expect(await keys.listLocalUnlockMethods()).toEqual(["password", "native"]);
  expect(await keys.hasPendingNativeUnlockRemoval()).toBe(false);
  expect(remove).not.toHaveBeenCalled();
});

it.each(["slot", "vault unlock", "account session"] as const)("rejects a queued turn-off when its initiating %s changes", async changed => {
  mockWebLocks();
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  const { readVault, vaultRecord } = await import("./device-key-vault.js");
  const { removeAccountNativeUnlock } = await import("./passkey-provision.js");
  const { useAuthStore } = await import("../stores/authStore.js");
  useAuthStore.setState({ accessToken: "token", sessionId: "starting-session" });
  vi.spyOn(biometricUnlock, "enroll").mockResolvedValue();
  await keys.initializeKeys(password);
  await keys.enrollLocalUnlockMethod({ method: "native" });
  await db.recordNativeEnrollment("retired");
  await db.abandonNativeEnrollment("retired");

  let announce!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  const hold = new Promise<void>(resolve => { finish = resolve; });
  const remove = vi.spyOn(biometricUnlock, "remove").mockImplementationOnce(async () => { announce(); await hold; }).mockResolvedValue();
  const cleanup = keys.retryNativeKeyCleanup({ background: false });
  await started;
  let outcome: Promise<unknown>;
  try {
    let captured!: () => void;
    const snapshotCaptured = new Promise<void>(resolve => { captured = resolve; });
    const getState = useAuthStore.getState;
    vi.spyOn(useAuthStore, "getState").mockImplementation(() => { captured(); return getState(); });
    // The first read captures the account, and the second validates the vault snapshot.
    const getSession = vi.mocked(useAuthStore.getState);
    outcome = removeAccountNativeUnlock().catch((error: unknown) => error);
    await snapshotCaptured;
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
    if (changed === "slot") {
      const vault = readVault(await db.getKey("dbKey"))!;
      vault.slots.find(slot => slot.method === "native")!.keyId = "replacement";
      await db.saveKeys([vaultRecord(vault)]);
    } else if (changed === "vault unlock") {
      await keys.loadKeys(password);
    } else useAuthStore.setState({ sessionId: "different-session" });
  } finally { finish(); }
  await cleanup;
  expect(await outcome).toBeInstanceOf(Error);
  expect(await keys.listLocalUnlockMethods()).toEqual(["password", "native"]);
  expect(remove).toHaveBeenCalledExactlyOnceWith("retired");
});

it("skips a different document's active Web Lock and recovers its journal once the lock is released", async () => {
  const locks = mockWebLocks();
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  const remove = vi.spyOn(biometricUnlock, "remove").mockResolvedValue();
  await locks.request("privatebase-native-unlock", async () => {
    await db.recordNativeEnrollment("uncommitted");
    await keys.retryNativeKeyCleanup();
    expect(remove).not.toHaveBeenCalled();
  });
  await keys.retryNativeKeyCleanup();
  expect(remove).toHaveBeenCalledExactlyOnceWith("uncommitted");
  expect(await db.pendingResetNativeKeyIds()).toEqual([]);
});

it("moves a pending removal written by an older client to the journal before startup cleanup", async () => {
  mockWebLocks();
  const { readVault, vaultRecord } = await import("./device-key-vault.js");
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  await keys.initializeKeys(password);
  const vault = readVault(await db.getKey("dbKey"))!;
  vault.pendingNativeRemoval = "legacy-slot";
  await db.saveKeys([vaultRecord(vault)]);
  keys.lockLocalCryptoState();
  const remove = vi.spyOn(biometricUnlock, "remove").mockImplementationOnce(async id => {
    expect(await db.pendingResetNativeKeyIds()).toEqual([id]);
    expect(readVault(await db.getKey("dbKey"))?.pendingNativeRemoval).toBeUndefined();
  });
  await keys.retryNativeKeyCleanup();
  expect(remove).toHaveBeenCalledExactlyOnceWith("legacy-slot");
  expect(await keys.hasPendingNativeUnlockRemoval()).toBe(false);
  expect(await keys.listLocalUnlockMethods()).toEqual(["password"]);
});

it("enrolls on the first attempt after migrating legacy removal metadata in the vault", async () => {
  mockWebLocks();
  const { readVault, vaultRecord } = await import("./device-key-vault.js");
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  await keys.initializeKeys(password);
  const vault = readVault(await db.getKey("dbKey"))!;
  vault.pendingNativeRemoval = "legacy-slot";
  await db.saveKeys([vaultRecord(vault)]);
  const remove = vi.spyOn(biometricUnlock, "remove").mockResolvedValue();
  const enroll = vi.spyOn(biometricUnlock, "enroll").mockImplementation(async () => {
    expect(remove).toHaveBeenCalledExactlyOnceWith("legacy-slot");
  });
  await keys.enrollLocalUnlockMethod({ method: "native" });
  expect(enroll).toHaveBeenCalledOnce();
  expect(await keys.listLocalUnlockMethods()).toEqual(["password", "native"]);
  expect(await keys.hasPendingNativeUnlockRemoval()).toBe(false);
  expect(remove).toHaveBeenCalledOnce();
});

it.each(["password", "native"] as const)("offers %s during native passkey setup according to enrollment coordination", async method => {
  if (method === "native") mockWebLocks();
  else vi.stubGlobal("navigator", { userAgent: "Macintosh" });
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlock: "touchid", passkeyHandoff: true, passkeyProvisionHandoff: true });
  const nativePasskeys = await import("./native-passkeys.js");
  const { beginPasskeyDeviceSetup } = await import("./passkey-provision.js");
  const authorize = vi.spyOn(nativePasskeys, "authorizeNativePasskeyProvision").mockImplementation(async (_hash, _bundle, setupId) => async () => ({
    setupId, user: { id: "user", username: "alice" }, deviceId: "linked", deviceName: "Mac",
    platform: "macos", expiresAt: Date.now() + 60_000, setupToken: "setup-token",
  }));
  const attempt = await beginPasskeyDeviceSetup("Mac");
  try {
    expect(authorize).toHaveBeenCalledOnce();
    expect(attempt.pending?.deviceId).toBe("linked");
    expect(attempt.method).toBe(method);
  } finally { await attempt.discard(); }
});

it("uses a capability discovered during the native passkey handoff", async () => {
  vi.stubGlobal("navigator", { userAgent: "Android" });
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { androidBiometricProbe: true, passkeyHandoff: true, passkeyProvisionHandoff: true });
  const invoke = vi.fn().mockResolvedValue("fingerprint");
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  try {
    const { refreshNativeUnlockCapability } = await import("../platform/biometric-unlock.js");
    const nativePasskeys = await import("./native-passkeys.js");
    const { beginPasskeyDeviceSetup } = await import("./passkey-provision.js");
    vi.spyOn(nativePasskeys, "authorizeNativePasskeyProvision").mockImplementation(async (_hash, _bundle, setupId) => {
      await refreshNativeUnlockCapability();
      return async () => ({
        setupId, user: { id: "user", username: "alice" }, deviceId: "linked", deviceName: "Phone",
        platform: "android", expiresAt: Date.now() + 60_000, setupToken: "setup-token",
      });
    });
    const attempt = await beginPasskeyDeviceSetup("Phone");
    try {
      expect(invoke).toHaveBeenCalledExactlyOnceWith("biometric_unlock_probe", undefined);
      expect(attempt.method).toBe("native");
    } finally { attempt.discard(); }
  } finally { vi.doUnmock("@tauri-apps/api/core"); }
});

it.each(["stalled", "available"] as const)("returns the redeemed attempt without waiting for the optional probe (%s)", async result => {
  vi.stubGlobal("navigator", { userAgent: "Android" });
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { androidBiometricProbe: true, passkeyHandoff: true, passkeyProvisionHandoff: true });
  let finishProbe!: (kind: string | null) => void;
  const probe = new Promise<string | null>(resolve => { finishProbe = resolve; });
  let announceProbe!: () => void;
  const probeStarted = new Promise<void>(resolve => { announceProbe = resolve; });
  const invoke = vi.fn(() => { announceProbe(); return probe; });
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  try {
    const nativePasskeys = await import("./native-passkeys.js");
    const { preparePasskeyDeviceSetup } = await import("./passkey-provision.js");
    const { refreshNativeUnlockCapability } = await import("../platform/biometric-unlock.js");
    const prepared = await preparePasskeyDeviceSetup("Phone");
    const redeem = vi.fn().mockResolvedValue({
      setupId: prepared.setupId, user: { id: "user", username: "alice" }, deviceId: "linked", deviceName: "Phone",
      platform: "android", expiresAt: Date.now() + 60_000, setupToken: "setup-token",
    });
    vi.spyOn(nativePasskeys, "authorizeNativePasskeyProvision").mockResolvedValue(redeem);
    const attempt = await prepared.authorize();
    await probeStarted;
    expect(redeem).toHaveBeenCalledOnce();
    expect(await db.readPendingSetupRecord()).toMatchObject({ stage: "provisioned" });
    expect(attempt.method).toBe("password");
    if (result === "available") {
      finishProbe("fingerprint");
      await refreshNativeUnlockCapability();
      expect(attempt.method).toBe("native");
    } else {
      vi.mocked(api.post).mockResolvedValueOnce({ verified: true });
      await attempt.persistUnlock(password);
      expect(await keys.listLocalUnlockMethods()).toEqual(["password"]);
    }
    expect(invoke).toHaveBeenCalledExactlyOnceWith("biometric_unlock_probe", undefined);
    attempt.discard();
  } finally {
    finishProbe(null);
    vi.doUnmock("@tauri-apps/api/core");
  }
});

it("switches fresh setup to password without waiting on the native enrollment or its cleanup", async () => {
  mockWebLocks();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlock: "touchid", passkeyHandoff: true, passkeyProvisionHandoff: true });
  let finishEnroll!: () => void;
  let finishRemoval!: () => void;
  const enroll = new Promise<void>(resolve => { finishEnroll = resolve; });
  const removal = new Promise<void>(resolve => { finishRemoval = resolve; });
  const invoke = vi.fn((command: string, _args?: { vaultId: string }) => command === "biometric_unlock_enroll" ? enroll : removal);
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  try {
    const nativePasskeys = await import("./native-passkeys.js");
    const { beginPasskeyDeviceSetup } = await import("./passkey-provision.js");
    vi.spyOn(nativePasskeys, "authorizeNativePasskeyProvision").mockImplementation(async (_hash, _bundle, setupId) => async () => ({
      setupId, user: { id: "user", username: "alice" }, deviceId: "linked", deviceName: "Mac",
      platform: "macos", expiresAt: Date.now() + 60_000, setupToken: "setup-token",
    }));
    const attempt = await beginPasskeyDeviceSetup("Mac");
    const controller = new AbortController();
    const stopped = expect(attempt.persistUnlock(undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("biometric_unlock_enroll", expect.any(Object)));
    controller.abort();
    await stopped;
    vi.mocked(api.post).mockResolvedValueOnce({ verified: true });
    await attempt.persistUnlock(password);
    expect(await keys.listLocalUnlockMethods()).toEqual(["password"]);
    const { vaultId } = invoke.mock.calls[0][1]!;
    expect(await db.pendingResetNativeKeyIds()).toEqual([vaultId]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("biometric_unlock_remove", { vaultId }));
    finishEnroll();
    finishRemoval();
    await vi.waitFor(async () => expect(await keys.hasPendingNativeUnlockRemoval()).toBe(false));
    expect(await keys.listLocalUnlockMethods()).toEqual(["password"]);
    attempt.discard();
  } finally {
    finishEnroll();
    finishRemoval();
    vi.doUnmock("@tauri-apps/api/core");
  }
});

it.each(["password only", "backup password"] as const)("honors %s when the native slot is already committed", async choice => {
  mockWebLocks();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlock: "touchid", passkeyHandoff: true, passkeyProvisionHandoff: true });
  const { beginPasskeyDeviceSetup } = await import("./passkey-provision.js");
  const nativePasskeys = await import("./native-passkeys.js");
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  vi.spyOn(nativePasskeys, "authorizeNativePasskeyProvision").mockImplementation(async (_hash, _bundle, setupId) => async () => ({
    setupId, user: { id: "user", username: "alice" }, deviceId: "linked", deviceName: "Mac",
    platform: "macos", expiresAt: Date.now() + 60_000, setupToken: "setup-token",
  }));
  const enroll = vi.spyOn(biometricUnlock, "enroll").mockResolvedValue();
  let finishRemoval!: () => void;
  const remove = vi.spyOn(biometricUnlock, "remove").mockReturnValue(new Promise<void>(resolve => { finishRemoval = resolve; }));
  const attempt = await beginPasskeyDeviceSetup("Mac");
  try {
    const controller = new AbortController();
    const put = IDBObjectStore.prototype.put;
    const abortDuringCommit = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (choice === "password only" && this.name === "deviceKeys" && value.id === "dbKey") controller.abort();
      return request;
    });
    try { await attempt.persistUnlock(undefined, controller.signal); }
    finally { abortDuringCommit.mockRestore(); }
    expect(await keys.listLocalUnlockMethods()).toEqual(["native"]);
    expect(controller.signal.aborted).toBe(choice === "password only");

    const keyId = enroll.mock.calls[0][0];
    vi.mocked(api.post).mockImplementation(async path => {
      if (path === "/auth/password/verify") return { verified: true };
      expect(path).toBe("/auth/passkey/provision/complete");
      expect(await keys.listLocalUnlockMethods()).toEqual(choice === "password only" ? ["password"] : ["native", "password"]);
      expect(await db.pendingResetNativeKeyIds()).toEqual(choice === "password only" ? [keyId] : []);
      return { device: { id: "linked" } };
    });
    if (choice === "password only") {
      await expect(attempt.complete(password)).resolves.toMatchObject({ device: { id: "linked" } });
      await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith(keyId));
      keys.lockLocalCryptoState();
      await expect(keys.loadKeys(password)).resolves.toBeUndefined();
      finishRemoval();
      await vi.waitFor(async () => expect(await db.pendingResetNativeKeyIds()).toEqual([]));
    } else {
      await attempt.chooseBackupPassword(password);
      await expect(attempt.complete()).resolves.toMatchObject({ device: { id: "linked" } });
      expect(remove).not.toHaveBeenCalled();
    }
  } finally {
    finishRemoval();
    attempt.discard();
  }
});

it.each([false, true])("ends native takeover before resumed setup reaches the server (replacement=%s)", async replace => {
  mockWebLocks();
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  const { resumePasskeyDeviceSetup } = await import("./passkey-provision.js");
  let key!: Uint8Array;
  vi.spyOn(biometricUnlock, "enroll").mockImplementation(async (_id, raw) => { key = raw.slice(); });
  vi.spyOn(biometricUnlock, "unlock").mockImplementation(async () => key.slice());
  const prepared = await keys.prepareDeviceKeySetup("Mac", "macos");
  const checkpoint = { id: "setup:pending" as const, setupId: "setup", bundleHash: "digest", createdAt: Date.now() };
  await db.updatePendingSetupRecord({ ...checkpoint, stage: "prepared" });
  await prepared.commit({ method: "native" }, {
    record: { ...checkpoint, deviceId: "linked", stage: "unlockReady", backupPending: false },
    owner: { userId: "user", username: "alice", deviceId: "linked" },
  });
  keys.lockLocalCryptoState();

  const pending = { ...checkpoint, user: { id: "user", username: "alice" }, deviceId: "linked", deviceName: "Mac",
    platform: "macos", expiresAt: Date.now() + 60_000, setupToken: "setup-token" };
  const localUnlockEnded = vi.fn();
  vi.mocked(api.post).mockImplementation(async path => {
    expect(localUnlockEnded).toHaveBeenCalledOnce();
    if (path.endsWith("/resume-options")) return { challengeId: "challenge" };
    if (path.endsWith("/complete")) return { device: { id: "linked" } };
    return pending;
  });
  const replacement = replace ? { limitTicket: "ticket", revokeDeviceId: "other" } : undefined;
  await expect(resumePasskeyDeviceSetup("native", undefined, replacement, new AbortController().signal, localUnlockEnded))
    .resolves.toMatchObject({ device: { id: "linked" } });
  expect(vi.mocked(api.post).mock.calls.map(([path]) => path)).toEqual([
    "/auth/passkey/provision/resume-options", "/auth/passkey/provision/resume",
    ...(replace ? ["/auth/passkey/provision/replace"] : []), "/auth/passkey/provision/complete",
  ]);
});

it("remembers unsupported native setup and persists the same attempt with a password", async () => {
  mockWebLocks();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlock: "windows-hello", passkeyHandoff: true, passkeyProvisionHandoff: true });
  const invoke = vi.fn().mockRejectedValueOnce({ code: "unsupported" }).mockResolvedValueOnce(undefined);
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  try {
    const { canEnrollNativeUnlock } = await import("../platform/biometric-unlock.js");
    const nativePasskeys = await import("./native-passkeys.js");
    const { beginPasskeyDeviceSetup } = await import("./passkey-provision.js");
    vi.spyOn(nativePasskeys, "authorizeNativePasskeyProvision").mockImplementation(async (_hash, _bundle, setupId) => async () => ({
      setupId, user: { id: "user", username: "alice" }, deviceId: "linked", deviceName: "PC",
      platform: "windows", expiresAt: Date.now() + 60_000, setupToken: "setup-token",
    }));
    vi.mocked(api.post).mockResolvedValue({ verified: true });
    const attempt = await beginPasskeyDeviceSetup("PC");
    try {
      expect(attempt.method).toBe("native");
      await expect(attempt.persistUnlock()).rejects.toMatchObject({ code: "unsupported" });
      expect(attempt.method).toBe("password");
      expect(canEnrollNativeUnlock()).toBe(false);
      await expect(attempt.persistUnlock(password)).resolves.toBeUndefined();
      await expect(keys.listLocalUnlockMethods()).resolves.toEqual(["password"]);
      expect(invoke.mock.calls.map(([command]) => command)).toEqual(["biometric_unlock_enroll", "biometric_unlock_remove"]);
    } finally { attempt.discard(); }
  } finally { vi.doUnmock("@tauri-apps/api/core"); }
});

it("refreshes capability after the slot commits and keeps cleanup available if the refresh loses the capability", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlock: "android-biometric", androidBiometricProbe: true });
  vi.stubGlobal("navigator", { userAgent: "Android" });
  const invoke = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(async () => {
      expect(await keys.listLocalUnlockMethods()).toEqual(["password", "native"]);
      expect(await db.pendingResetNativeKeyIds()).toEqual([]);
      throw { code: "failed" };
    })
    .mockResolvedValueOnce(undefined);
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  try {
    const { nativeUnlockStatus } = await import("../platform/biometric-unlock.js");
    await keys.initializeKeys(password);
    await keys.enrollLocalUnlockMethod({ method: "native" });
    await vi.waitFor(() => expect(nativeUnlockStatus()).toMatchObject({ available: undefined, probeFailed: true }));
    const { vaultId } = invoke.mock.calls[0][1];
    await keys.removeLocalUnlockMethod("native");
    expect(invoke).toHaveBeenNthCalledWith(2, "biometric_unlock_probe", undefined);
    expect(invoke).toHaveBeenNthCalledWith(3, "biometric_unlock_remove", { vaultId });
    expect(await keys.listLocalUnlockMethods()).toEqual(["password"]);
  } finally { vi.doUnmock("@tauri-apps/api/core"); }
});

it("persists a native key removal retry across reloads without keeping the slot usable", async () => {
  mockWebLocks();
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  const enroll = vi.spyOn(biometricUnlock, "enroll").mockResolvedValue();
  await keys.initializeKeys(password);
  await keys.enrollLocalUnlockMethod({ method: "native" });
  const keyId = enroll.mock.calls[0][0];
  const remove = vi.spyOn(biometricUnlock, "remove").mockImplementationOnce(async id => {
    expect(id).toBe(keyId);
    expect(await keys.listLocalUnlockMethods()).toEqual(["password"]);
    expect(await keys.hasPendingNativeUnlockRemoval()).toBe(true);
    throw new Error("keystore unavailable");
  });
  await expect(keys.removeLocalUnlockMethod("native")).rejects.toThrow("keystore unavailable");
  expect(remove).toHaveBeenCalledOnce();
  await reload();
  expect(await keys.listLocalUnlockMethods()).toEqual(["password"]);
  expect(await keys.hasPendingNativeUnlockRemoval()).toBe(true);
  await expect(keys.enrollLocalUnlockMethod({ method: "native" })).rejects.toThrow("Finish removing");
  const retry = vi.spyOn((await import("../platform/biometric-unlock.js")).biometricUnlock, "remove").mockResolvedValue();
  await keys.removeLocalUnlockMethod("native");
  expect(retry).toHaveBeenCalledExactlyOnceWith(keyId);
  expect(await keys.hasPendingNativeUnlockRemoval()).toBe(false);
  await keys.removeLocalUnlockMethod("native");
  expect(retry).toHaveBeenCalledOnce();
});

it.each(["device reset", "crypto reset"])("keeps the native cleanup handle across %s and a restart", async mode => {
  mockWebLocks();
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  const enroll = vi.spyOn(biometricUnlock, "enroll").mockResolvedValue();
  await keys.initializeKeys(password);
  await keys.enrollLocalUnlockMethod({ method: "native" });
  const keyId = enroll.mock.calls[0][0];
  const remove = vi.spyOn(biometricUnlock, "remove").mockImplementation(async id => {
    expect(await db.pendingResetNativeKeyIds()).toEqual([id]);
    expect(await keys.hasLocalKeyMaterial()).toBe(false);
    throw new Error("keystore unavailable");
  });
  const reset = mode === "device reset" ? keys.resetLocalDevice : keys.resetLocalCryptoState;
  await expect(reset()).resolves.toBe(true);
  await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith(keyId));
  expect(await db.pendingResetNativeKeyIds()).toEqual([keyId]);
  await db.clearAll();
  (await db.getAppDB()).close();
  vi.resetModules();
  db = await import("../db/index.js");
  keys = await import("./key-manager.js");
  expect(await db.pendingResetNativeKeyIds()).toEqual([keyId]);
  const retry = vi.spyOn((await import("../platform/biometric-unlock.js")).biometricUnlock, "remove").mockResolvedValue();
  await keys.retryNativeKeyCleanup();
  expect(retry).toHaveBeenCalledExactlyOnceWith(keyId);
  expect(await db.pendingResetNativeKeyIds()).toEqual([]);
});

it("can set up and unlock a password vault while reset cleanup is still running", async () => {
  mockWebLocks();
  await keys.initializeKeys(password);
  await db.recordNativeEnrollment("orphan");
  await db.abandonNativeEnrollment("orphan");
  let finish!: () => void;
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  const remove = vi.spyOn(biometricUnlock, "remove").mockReturnValue(new Promise(resolve => { finish = resolve; }));
  try {
    await expect(keys.resetLocalCryptoState()).resolves.toBe(true);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith("orphan"));
    await keys.initializeKeys(password);
    keys.lockLocalCryptoState();
    await keys.loadKeys(password);
    expect(keys.keysLoaded()).toBe(true);
    expect(await db.pendingResetNativeKeyIds()).toEqual(["orphan"]);
  } finally { finish(); }
  await vi.waitFor(async () => expect(await db.pendingResetNativeKeyIds()).toEqual([]));
});

it("bounds a queued native lock wait without holding up password setup", async () => {
  const request = vi.fn(async (name: string, options: LockOptions | LockGrantedCallback<unknown>, callback?: LockGrantedCallback<unknown>) => {
    if (name === "privatebase-native-unlock" && typeof options !== "function") {
      const signal = options.signal!;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return (typeof options === "function" ? options : callback!)({ name, mode: "exclusive" });
  });
  vi.stubGlobal("navigator", { userAgent: navigator.userAgent, locks: { request } });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopped = expect(keys.retryNativeKeyCleanup({ background: false })).rejects.toMatchObject({ code: "failed" });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  await keys.initializeKeys(password);
  expect(keys.keysLoaded()).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  await stopped;
});

it("registers and reloads private keys and a wrapped edit key with strict BufferSources", async () => {
  vi.stubGlobal("crypto", strictWebCrypto(crypto));
  const publicIdentity = await keys.initializeKeys(password);
  const editKey = toBase64Url(generateAESKey());
  await db.saveMessage({
    id: "original", ownerId: "bob", conversationId: "chat", senderId: "alice", type: "text", content: "original text",
    timestamp: Date.now(), expiresAt: Date.now() + 60_000, status: "sent", editKey,
    editKeyAccepted: true, editSigningKey: publicIdentity, editSenderDeviceId: "alice-device",
  });
  expect((await (await db.getAppDB()).get("accountState", 'message-edit-state:["bob","original"]')).wrappedKey)
    .toMatchObject({ iv: expect.any(String), ciphertext: expect.any(String) });
  await reload();
  expect(toBase64Url(keys.getIdentityKeyPair().publicEd25519)).toBe(publicIdentity);
  expect(await db.getMessageById("original", "bob", undefined, true)).toMatchObject({ editKey, editKeyAccepted: true });
});

it("unlocks local keys encrypted without AAD with strict BufferSources", async () => {
  const publicIdentity = await keys.initializeKeys(password);
  vi.stubGlobal("crypto", strictWebCrypto(crypto));
  await reload();
  expect(toBase64Url(keys.getIdentityKeyPair().publicEd25519)).toBe(publicIdentity);
});

describe("encrypted one-time pre-key persistence", () => {
  it("leaves no partial key records when the initialization transaction aborts", async () => {
    const originalPut = IDBObjectStore.prototype.put;
    let aborted = false;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      if (this.name === "deviceKeys" && value.id === "identity") {
        request.addEventListener("success", () => {
          aborted = true;
          this.transaction.abort();
        }, { once: true });
      }
      return request;
    });

    await expect(keys.initializeKeys(password)).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toBe(true);
    expect(await keys.hasLocalKeyMaterial()).toBe(false);
    for (const id of ["dbKey", "identity", "signedPreKey", "otpKeys", "otpNextId", "otpPendingIds"]) {
      expect(await db.getKey(id)).toBeUndefined();
    }
    expect(keys.keysLoaded()).toBe(false);
    expect(keys.peekOneTimePreKey(1)).toBeUndefined();
  });

  it("persists consumption across reloads without removing keys on peek", async () => {
    await keys.initializeKeys(password);
    expect(keys.peekOneTimePreKey(1)).toBe(keys.peekOneTimePreKey(1));
    await keys.consumeOneTimePreKey(1);
    await reload();
    expect(keys.peekOneTimePreKey(1)).toBeUndefined();
    expect(keys.peekOneTimePreKey(2)).toBeDefined();
    expect(keys.peekOneTimePreKey(OTP_KEY_POOL_SIZE)).toBeDefined();
    const stored = JSON.parse((await db.getKey("otpKeys"))!.data);
    expect(Object.keys(stored).sort()).toEqual(["ciphertext", "iv"]);
  });

  it("serializes concurrent consumes so neither key reappears", async () => {
    await keys.initializeKeys(password);
    await Promise.all([keys.consumeOneTimePreKey(1), keys.consumeOneTimePreKey(2), keys.consumeOneTimePreKey(3)]);
    await reload();
    for (const id of [1, 2, 3]) expect(keys.peekOneTimePreKey(id)).toBeUndefined();
    expect(keys.peekOneTimePreKey(4)).toBeDefined();
  });

  it("ignores unknown ids, including while locked", async () => {
    await expect(keys.consumeOneTimePreKey(999)).resolves.toBeUndefined();
    expect(await db.getKey("otpKeys")).toBeUndefined();
  });

  it("persists replenished private keys before publishing their public halves", async () => {
    await keys.initializeKeys(password);
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: true });
    vi.mocked(api.post).mockImplementation(async () => {
      expect(await db.getKey("otpNextId")).toMatchObject({ data: String(2 * OTP_KEY_POOL_SIZE + 1) });
      expect(JSON.parse((await db.getKey("otpKeys"))!.data)).toHaveProperty("ciphertext");
      return {} as never;
    });
    await keys.runPostUnlockKeyMaintenance();
    const publicKeys = vi.mocked(api.post).mock.calls[0][1] as { oneTimePreKeys: { id: number }[] };
    expect(publicKeys.oneTimePreKeys[0].id).toBe(OTP_KEY_POOL_SIZE + 1);
    await reload();
    expect(keys.peekOneTimePreKey(OTP_KEY_POOL_SIZE + 1)).toBeDefined();
  });

  it("retries the same persisted pending keys after a failed upload and reload", async () => {
    await keys.initializeKeys(password);
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: true });
    vi.mocked(api.post).mockRejectedValueOnce(new Error("offline"));
    await expect(keys.runPostUnlockKeyMaintenance()).rejects.toThrow("offline");
    const firstUpload = vi.mocked(api.post).mock.calls[0][1];
    await reload();
    expect(keys.peekOneTimePreKey(OTP_KEY_POOL_SIZE + 1)).toBeDefined();
    await keys.runPostUnlockKeyMaintenance();
    expect(vi.mocked(api.post).mock.calls[1][1]).toEqual(firstUpload);
  });

  it("recovers from a 409 for ids the server already consumed with different keys", async () => {
    await keys.initializeKeys(password);
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: true });
    const first = OTP_KEY_POOL_SIZE + 1;
    const last = 2 * OTP_KEY_POOL_SIZE;
    const conflict = Object.assign(new Error("One-time pre-key ids were already used with different keys"), {
      status: 409,
      body: { error: "conflict", conflictingKeyIds: [first, last + 5] },
    });
    vi.mocked(api.post).mockRejectedValueOnce(conflict);
    await expect(keys.runPostUnlockKeyMaintenance()).rejects.toBe(conflict);
    const uploadedIds = (call: number) => (vi.mocked(api.post).mock.calls[call][1] as { oneTimePreKeys: { id: number }[] })
      .oneTimePreKeys.map((key) => key.id);
    expect(uploadedIds(0)).toEqual(Array.from({ length: OTP_KEY_POOL_SIZE }, (_, index) => first + index));

    // The unusable private key is gone and its id (and every id up to the highest conflict) is burned.
    expect(keys.peekOneTimePreKey(first)).toBeUndefined();
    expect(keys.peekOneTimePreKey(first + 1)).toBeDefined();
    expect(await db.getKey("otpNextId")).toMatchObject({ data: String(last + 6) });
    expect(JSON.parse((await db.getKey("otpPendingIds"))!.data)).toEqual(
      Array.from({ length: OTP_KEY_POOL_SIZE - 1 }, (_, index) => first + 1 + index),
    );
    await reload();
    expect(keys.peekOneTimePreKey(first)).toBeUndefined();

    // The next run uploads what is still pending, without the conflicting id.
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: true });
    await keys.runPostUnlockKeyMaintenance();
    expect(uploadedIds(1)).toEqual(Array.from({ length: OTP_KEY_POOL_SIZE - 1 }, (_, index) => first + 1 + index));
    expect(JSON.parse((await db.getKey("otpPendingIds"))!.data)).toEqual([]);

    // And the run after that tops the pool up with ids past the conflict.
    vi.mocked(api.get).mockResolvedValue({ count: 3, hasBundle: true });
    await keys.runPostUnlockKeyMaintenance();
    expect(uploadedIds(2)[0]).toBe(last + 6);

    // Other failures, including a 409 without conflicting ids, change nothing locally.
    const plain = Object.assign(new Error("Conflict"), { status: 409, body: { error: "Conflict" } });
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: true });
    vi.mocked(api.post).mockRejectedValueOnce(plain);
    const nextIdBefore = (await db.getKey("otpNextId"))!.data;
    await expect(keys.runPostUnlockKeyMaintenance()).rejects.toBe(plain);
    expect(Number((await db.getKey("otpNextId"))!.data)).toBe(Number(nextIdBefore) + OTP_KEY_POOL_SIZE);
    expect(keys.peekOneTimePreKey(Number(nextIdBefore))).toBeDefined();
  });

  it("never reuses consumed ids when the entire local pool is empty", async () => {
    await keys.initializeKeys(password);
    await Promise.all(Array.from({ length: OTP_KEY_POOL_SIZE }, (_, index) => keys.consumeOneTimePreKey(index + 1)));
    await reload();
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: true });
    await keys.runPostUnlockKeyMaintenance();
    expect(keys.peekOneTimePreKey(1)).toBeUndefined();
    expect(keys.peekOneTimePreKey(OTP_KEY_POOL_SIZE + 1)).toBeDefined();
  });

  it("keeps loading entirely local", async () => {
    await keys.initializeKeys(password);
    await reload();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("does not leave partially loaded keys after a wrong password", async () => {
    await keys.initializeKeys(password);
    await expect(keys.loadKeys("wrong password")).rejects.toThrow();
    expect(keys.keysLoaded()).toBe(false);
    expect(keys.peekOneTimePreKey(1)).toBeUndefined();
  });

  it("self-heals a missing bundle and coalesces concurrent maintenance", async () => {
    await keys.initializeKeys(password);
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: false });
    await Promise.all([keys.runPostUnlockKeyMaintenance(), keys.runPostUnlockKeyMaintenance()]);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/keys/bundle", expect.objectContaining({ oneTimePreKeys: expect.any(Array) }));
  });

  it("does not upload an already published bundle again during registration", async () => {
    await keys.initializeKeys(password);
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: false });
    await keys.runPostUnlockKeyMaintenance();
    await keys.uploadPreKeyBundle();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("fills an empty pool before restoring a missing bundle", async () => {
    await keys.initializeKeys(password);
    await Promise.all(Array.from({ length: OTP_KEY_POOL_SIZE }, (_, index) => keys.consumeOneTimePreKey(index + 1)));
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: false });
    await keys.runPostUnlockKeyMaintenance();
    expect(api.post).toHaveBeenCalledWith("/api/keys/bundle", expect.objectContaining({
      oneTimePreKeys: expect.arrayContaining([expect.objectContaining({ id: OTP_KEY_POOL_SIZE + 1 })]),
    }));
    await reload();
    expect(keys.peekOneTimePreKey(OTP_KEY_POOL_SIZE + 1)).toBeDefined();
  });

  it("treats an old server's missing hasBundle field as an existing bundle", async () => {
    await keys.initializeKeys(password);
    vi.mocked(api.get).mockResolvedValue({ count: OTP_KEY_POOL_SIZE });
    await keys.runPostUnlockKeyMaintenance();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("keeps one-time pre-keys consistent across two unlocked tabs", async () => {
    // Each step runs in a tab whose in-memory OTP set is stale, so every mutation must reload.
    await keys.initializeKeys(password);
    const tabA = keys;
    vi.resetModules();
    const tabB = await import("./key-manager.js");
    const dbB = await import("../db/index.js");
    await tabB.loadKeys(password);
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: true });
    const uploadedIds = () => vi.mocked(api.post).mock.calls.at(-1)![1] as { oneTimePreKeys: { id: number }[] };

    let secondBatch: number[];
    try {
      // 1. A replenishes; B never saw these keys.
      await tabA.runPostUnlockKeyMaintenance();
      const firstBatch = uploadedIds().oneTimePreKeys.map((k) => k.id);
      // 2. B consumes; its save must keep A's new keys.
      await tabB.consumeOneTimePreKey(1);
      // 3. A (still holding key 1 in memory) replenishes; it must not resurrect key 1 or reuse ids.
      await tabA.runPostUnlockKeyMaintenance();
      secondBatch = uploadedIds().oneTimePreKeys.map((k) => k.id);
      expect(Math.min(...secondBatch)).toBeGreaterThan(Math.max(...firstBatch));
      // 4. B can answer an initial message that uses one of A's newest keys.
      expect(tabB.peekOneTimePreKey(secondBatch[0])).toBeUndefined();
      expect((await tabB.findOneTimePreKey(secondBatch[0]))?.keyPair.privateKey)
        .toEqual(tabA.peekOneTimePreKey(secondBatch[0])!.keyPair.privateKey);
    } finally {
      tabB.lockLocalCryptoState();
      (await dbB.getAppDB()).close();
    }
    await reload();
    expect(keys.peekOneTimePreKey(1)).toBeUndefined();
    expect(keys.peekOneTimePreKey(OTP_KEY_POOL_SIZE + 1)).toBeDefined();
    expect(keys.peekOneTimePreKey(secondBatch[0])).toBeDefined();
  });

  it("does not overwrite the stored pool with a stale copy when the reload fails during consume", async () => {
    await keys.initializeKeys(password);
    const tabA = keys;
    vi.resetModules();
    const tabB = await import("./key-manager.js");
    const dbB = await import("../db/index.js");
    await tabB.loadKeys(password);
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: true });
    try {
      // A adds keys B has never seen; B then cannot read the stored pool while consuming.
      await tabA.runPostUnlockKeyMaintenance();
      const storedBefore = (await db.getKey("otpKeys"))!.data;
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(crypto.subtle, "decrypt").mockRejectedValueOnce(new Error("unreadable"));
      await expect(tabB.consumeOneTimePreKey(1)).resolves.toBeUndefined();
      expect(tabB.peekOneTimePreKey(1)).toBeUndefined();
      expect((await db.getKey("otpKeys"))!.data).toBe(storedBefore);
      // The deferred removal is persisted by B's next successful reload, keeping A's keys.
      await tabB.consumeOneTimePreKey(2);
    } finally {
      tabB.lockLocalCryptoState();
      (await dbB.getAppDB()).close();
    }
    await reload();
    expect(keys.peekOneTimePreKey(1)).toBeUndefined();
    expect(keys.peekOneTimePreKey(2)).toBeUndefined();
    expect(keys.peekOneTimePreKey(3)).toBeDefined();
    expect(keys.peekOneTimePreKey(OTP_KEY_POOL_SIZE + 1)).toBeDefined();
  });

  it("never rejects a consume whose removal cannot be saved, and saves it later", async () => {
    await keys.initializeKeys(password);
    const storedBefore = (await db.getKey("otpKeys"))!.data;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("disk full", "QuotaExceededError");
    });
    await expect(keys.consumeOneTimePreKey(1)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalled();
    put.mockRestore();
    // Not handed out again by this tab, although the stored pool still contains it.
    expect(keys.peekOneTimePreKey(1)).toBeUndefined();
    expect((await db.getKey("otpKeys"))!.data).toBe(storedBefore);
    await keys.consumeOneTimePreKey(2);
    await reload();
    expect(keys.peekOneTimePreKey(1)).toBeUndefined();
    expect(keys.peekOneTimePreKey(2)).toBeUndefined();
    expect(keys.peekOneTimePreKey(3)).toBeDefined();
  });

  it.each([
    ["/api/keys/count", { count: 0, hasBundle: true }],
    ["/api/keys/bundle", { count: 0, hasBundle: false }],
    ["/api/keys/replenish", { count: 0, hasBundle: true }],
  ] as const)("does not block pre-key lookups or consumption while %s hangs", async (hungPath, count) => {
    await keys.initializeKeys(password);
    let release!: () => void;
    const hang = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path === hungPath) await hang;
      return count as never;
    });
    vi.mocked(api.post).mockImplementation(async (path) => {
      if (path === hungPath) await hang;
      return {} as never;
    });
    const maintenance = keys.runPostUnlockKeyMaintenance();
    const hungCalls = () => [...vi.mocked(api.get).mock.calls, ...vi.mocked(api.post).mock.calls]
      .filter(([path]) => path === hungPath);
    await vi.waitFor(() => expect(hungCalls()).toHaveLength(1));

    await expect(keys.findOneTimePreKey(999_999)).resolves.toBeUndefined();
    await keys.consumeOneTimePreKey(1);

    release();
    await maintenance;
    await reload();
    // The consume made while the request was in flight survives the maintenance's later saves.
    expect(keys.peekOneTimePreKey(1)).toBeUndefined();
    expect(keys.peekOneTimePreKey(2)).toBeDefined();
    expect(JSON.parse((await db.getKey("otpPendingIds"))!.data)).toEqual([]);
  });

  it("does not top up from a count that predates another tab's replenishment", async () => {
    await keys.initializeKeys(password);
    const tabA = keys;
    vi.resetModules();
    const tabB = await import("./key-manager.js");
    const dbB = await import("../db/index.js");
    await tabB.loadKeys(password);
    let resolveCount!: (value: { count: number; hasBundle: boolean }) => void;
    vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { resolveCount = resolve; }));
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: true });
    try {
      const maintenanceA = tabA.runPostUnlockKeyMaintenance();
      await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
      await tabB.runPostUnlockKeyMaintenance();
      expect(api.post).toHaveBeenCalledTimes(1);
      resolveCount({ count: 0, hasBundle: true });
      await maintenanceA;
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(await db.getKey("otpNextId")).toMatchObject({ data: String(2 * OTP_KEY_POOL_SIZE + 1) });
    } finally {
      tabB.lockLocalCryptoState();
      (await dbB.getAppDB()).close();
    }
  });

  it("does not publish keys if locked while the count request is pending", async () => {
    await keys.initializeKeys(password);
    let resolveCount!: (value: { count: number; hasBundle: boolean }) => void;
    vi.mocked(api.get).mockImplementation(() => new Promise((resolve) => { resolveCount = resolve; }));
    const maintenance = keys.runPostUnlockKeyMaintenance();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
    keys.lockLocalCryptoState();
    resolveCount({ count: 0, hasBundle: false });
    await expect(maintenance).rejects.toThrow("locked");
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("local key ownership", () => {
  it("round trips the owner and clears it on reset", async () => {
    expect(await keys.getLocalKeyOwner()).toBeNull();
    const owner = { userId: "alice-id", username: "alice" };
    await keys.setLocalKeyOwner(owner);
    expect(await keys.getLocalKeyOwner()).toEqual(owner);
    expect(await db.getKey("owner")).toEqual({ id: "owner", type: "owner", data: JSON.stringify(owner) });
    await keys.resetLocalCryptoState();
    expect(await keys.getLocalKeyOwner()).toBeNull();
  });

  it.each([
    // The id recorded with the keys wins over an empty, stale or foreign auth-store device.
    [{ userId: "alice-id", username: "alice", deviceId: "keys-device" }, "alice", null, "keys-device"],
    [{ userId: "alice-id", username: "alice", deviceId: "keys-device" }, "alice", { id: "stale", userId: "alice-id" }, "keys-device"],
    [{ userId: "alice-id", username: "alice", deviceId: "keys-device" }, "alice", { id: "bobs", userId: "bob-id" }, "keys-device"],
    // Never offer these keys' device (or the store's) for another username.
    [{ userId: "alice-id", username: "alice", deviceId: "keys-device" }, "bob", { id: "bobs", userId: "bob-id" }, ""],
    // Owner records without a device id fall back to the store unless it names another user.
    [{ userId: "alice-id", username: "alice" }, "alice", { id: " stored ", userId: "alice-id" }, "stored"],
    [{ userId: "alice-id", username: "alice" }, "alice", { id: "bobs", userId: "bob-id" }, ""],
    [{ userId: "alice-id", username: "alice" }, "alice", null, ""],
    [null, "alice", { id: "stored", userId: "alice-id" }, "stored"],
    [null, "alice", null, ""],
  ] as const)("resolves the device id of the local keys for case %#", (owner, typedUsername, storedDevice, expected) => {
    expect(keys.resolveLocalKeyDeviceId({ owner, typedUsername, storedDevice })).toBe(expected);
  });

  it("protects partially written local key material from being overwritten", async () => {
    await db.saveKey({ id: "identity", type: "identity", data: "encrypted material" });
    expect(await keys.hasLocalKeyMaterial()).toBe(true);
  });

  it.each([
    [false, null, "bob", true, "use"],
    [true, { userId: "alice-id", username: "alice" }, "bob", false, "block-other-owner"],
    [true, { userId: "alice-id", username: "alice" }, "Alice", true, "block-other-owner"],
    [true, null, "alice", true, "block-other-owner"],
    [true, null, "alice", false, "use"],
    [true, { userId: "alice-id", username: "alice" }, "alice", true, "wipe-revoked"],
    [true, { userId: "alice-id", username: "alice" }, "alice", false, "use"],
  ] as const)("decides ownership for case %#", (hasKeys, owner, typedUsername, serverSaidUnknownDevice, expected) => {
    expect(keys.decideLocalKeyAction({ hasKeys, owner, typedUsername, serverSaidUnknownDevice })).toBe(expected);
  });
});

describe("idle locking", () => {
  it("holds only idle locking during a transfer and rearms it when paused", async () => {
    await keys.initializeKeys(password);
    vi.useFakeTimers();
    keys.resetIdleTimer();
    const release = keys.holdIdleLock();
    vi.advanceTimersByTime(30 * 60_000);
    expect(keys.keysLoaded()).toBe(true);
    release();
    vi.advanceTimersByTime(15 * 60_000);
    expect(keys.keysLoaded()).toBe(false);
  });

  it("only opens device-sealed attachment bytes with the unlocked key and original context", async () => {
    const { Blob } = await vi.importActual<{ Blob: typeof globalThis.Blob }>("node:buffer");
    vi.stubGlobal("Blob", Blob);
    await keys.initializeKeys(password);
    const wire = new globalThis.Blob(["opaque uploaded bytes"]);
    const sealed = await keys.sealCachedAttachment("alice", "file", wire);
    const shared = new Uint8Array(new SharedArrayBuffer(14)).subarray(1, 13);
    shared.set(sealed.iv);
    expect(await (await keys.openCachedAttachment("alice", "file", { ...sealed, iv: shared })).text()).toBe("opaque uploaded bytes");
    expect(await sealed.ciphertext.text()).not.toContain("opaque uploaded bytes");
    expect(await (await keys.openCachedAttachment("alice", "file", sealed)).text()).toBe("opaque uploaded bytes");
    await expect(keys.openCachedAttachment("bob", "file", sealed)).rejects.toThrow();
    const release = keys.holdIdleLock();
    keys.lockLocalCryptoState();
    release();
    await expect(keys.openCachedAttachment("alice", "file", sealed)).rejects.toMatchObject({ name: "KeysLockedError" });
  });
  it("wipes in-memory keys, notifies subscribers, and removes activity listeners", async () => {
    await keys.initializeKeys(password);
    vi.useFakeTimers();
    keys.resetIdleTimer();
    const listener = vi.fn();
    const removedListener = vi.fn();
    keys.onKeysLocked(listener);
    keys.onKeysLocked(removedListener)();
    vi.advanceTimersByTime(15 * 60_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(removedListener).not.toHaveBeenCalled();
    expect(keys.keysLoaded()).toBe(false);
    expect(keys.getSignedPreKey()).toBeNull();
    expect(keys.peekOneTimePreKey(1)).toBeUndefined();
    window.dispatchEvent(new Event("pointerdown"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not treat background maintenance, including a bundle upload, as user activity", async () => {
    await keys.initializeKeys(password);
    vi.mocked(api.get).mockResolvedValue({ count: 0, hasBundle: false });
    vi.mocked(api.post).mockRejectedValue(new Error("offline"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    keys.resetIdleTimer();
    vi.advanceTimersByTime(14 * 60_000);
    await expect(keys.runPostUnlockKeyMaintenance()).rejects.toThrow("offline");
    expect(api.post).toHaveBeenCalledWith("/api/keys/bundle", expect.anything());
    vi.advanceTimersByTime(60_000);
    expect(keys.keysLoaded()).toBe(false);
  });

  it("counts unlocks of this tab only", async () => {
    const initial = keys.getUnlockGeneration();
    await keys.initializeKeys(password);
    expect(keys.getUnlockGeneration()).toBe(initial + 1);
    keys.lockLocalCryptoState();
    expect(keys.getUnlockGeneration()).toBe(initial + 1);
    await expect(keys.loadKeys("wrong password")).rejects.toThrow();
    expect(keys.getUnlockGeneration()).toBe(initial + 1);
    await keys.loadKeys(password);
    expect(keys.getUnlockGeneration()).toBe(initial + 2);
  });

  it.each(["pointerdown", "keydown", "visibilitychange", "identity", "otp"])("extends the unlocked session on %s activity", async (activity) => {
    await keys.initializeKeys(password);
    vi.useFakeTimers();
    keys.resetIdleTimer();
    vi.advanceTimersByTime(14 * 60_000);
    if (activity === "identity") keys.getIdentityKeyPair();
    else if (activity === "otp") keys.peekOneTimePreKey(1);
    else if (activity === "visibilitychange") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      document.dispatchEvent(new Event(activity));
    } else window.dispatchEvent(new Event(activity));
    vi.advanceTimersByTime(2 * 60_000);
    expect(keys.keysLoaded()).toBe(true);
    vi.advanceTimersByTime(13 * 60_000);
    expect(keys.keysLoaded()).toBe(false);
  });
});

describe("device KEK and unlock slots", () => {
  it("atomically migrates a legacy password vault and its already-wrapped edit keys", async () => {
    const { Blob } = await vi.importActual<{ Blob: typeof globalThis.Blob }>("node:buffer");
    vi.stubGlobal("Blob", Blob);
    const { fromBase64Url, toBase64Url, serializeIdentityKeyPair } = await import("@e2ee-chat/crypto");
    const { deriveEncryptionKey, unwrapUnlockSlot, readVault } = await import("./device-key-vault.js");
    const { encryptData, decryptData, setLocalEncryptionKey } = await import("./local-key-encryption.js");
    await keys.initializeKeys(password);
    await keys.setLocalKeyOwner({ userId: "user", username: "alice", deviceId: "device" });
    await keys.consumeOneTimePreKey(1);
    const identity = serializeIdentityKeyPair(keys.getIdentityKeyPair());
    const before = keys.buildDeviceLinkPublicBundle("Laptop");
    keys.lockLocalCryptoState();

    const vault = readVault(await db.getKey("dbKey"))!;
    const modern = await unwrapUnlockSlot(vault.slots[0], password);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const legacy = await deriveEncryptionKey(password, salt);
    const blobIds = ["identity", "signedPreKey", "otpKeys"];
    const legacyRecords = await Promise.all(blobIds.map(async (id) => {
      const record = (await db.getKey(id))!;
      const { iv, ciphertext } = JSON.parse(record.data);
      return { ...record, data: JSON.stringify(await encryptData(legacy, await decryptData(modern, iv, ciphertext))) };
    }));
    await db.saveKeys([{ id: "dbKey", type: "salt", data: toBase64Url(salt) }, ...legacyRecords]);
    const editKey = toBase64Url(generateAESKey());
    const appDb = await db.getAppDB();
    setLocalEncryptionKey(legacy);
    const sealed = await keys.sealCachedAttachment("user", "file", new Blob(["offline bytes"]));
    const files = appDb.transaction("accountFiles", "readwrite");
    await db.writeCachedFile(files.store, { id: "file", ownerId: "user", cachedAt: Date.now(), expiresAt: Date.now() + 60_000, sealed });
    await files.done;
    await db.saveMessage({
      id: "original", ownerId: "user", conversationId: "chat", senderId: "user", type: "text", content: "original",
      timestamp: Date.now(), expiresAt: Date.now() + 60_000, status: "sent", editKey,
      editKeyAccepted: true, editSigningKey: before.identityKey, editSenderDeviceId: "device",
    });
    await appDb.put("accountState", { id: "message-edit-key-wrap-v1" });
    const editId = 'message-edit-state:["user","original"]';
    const oldEdit = await appDb.get("accountState", editId);
    const beforeMetadata = await Promise.all(["owner", "otpNextId", "otpPendingIds"].map(db.getKey));
    await expect(keys.loadKeys("wrong")).rejects.toMatchObject({ name: "OperationError" });
    expect((await db.getKey("dbKey"))?.type).toBe("salt");
    expect(await Promise.all(blobIds.map(db.getKey))).toEqual(legacyRecords);
    expect(keys.keysLoaded()).toBe(false);

    const originalPut = IDBObjectStore.prototype.put;
    const interrupt = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      if (this.name === "deviceKeys" && value.id === "dbKey") {
        request.addEventListener("success", () => this.transaction.abort(), { once: true });
      }
      return request;
    });
    await expect(keys.loadKeys(password)).rejects.toMatchObject({ name: "AbortError" });
    interrupt.mockRestore();
    expect((await db.getKey("dbKey"))?.type).toBe("salt");
    expect(await appDb.get("accountState", editId)).toEqual(oldEdit);
    expect(Array.from((await db.getCachedFile("file", "user"))!.sealed!.iv)).toEqual(Array.from(sealed.iv));

    await keys.loadKeys(password);
    const migrated = (await db.getKey("dbKey"))!;
    const wrapper = readVault(migrated)!.slots[0];
    expect(migrated.type).toBe("device-kek-v1");
    expect(wrapper.method).toBe("password");
    expect(serializeIdentityKeyPair(keys.getIdentityKeyPair())).toEqual(identity);
    expect(keys.buildDeviceLinkPublicBundle("Laptop")).toEqual(before);
    expect(await Promise.all(["owner", "otpNextId", "otpPendingIds"].map(db.getKey))).toEqual(beforeMetadata);
    const newIdentity = JSON.parse((await db.getKey("identity"))!.data);
    await expect(decryptData(legacy, newIdentity.iv, newIdentity.ciphertext)).rejects.toMatchObject({ name: "OperationError" });
    const newEdit = await appDb.get("accountState", editId);
    const aad = new TextEncoder().encode(JSON.stringify([editId, "chat", "user", "device", before.identityKey]));
    await expect(decryptData(legacy, newEdit.wrappedKey.iv, newEdit.wrappedKey.ciphertext, aad))
      .rejects.toMatchObject({ name: "OperationError" });
    expect(await db.getMessageById("original", "user", undefined, true)).toMatchObject({ editKey, editKeyAccepted: true });
    const migratedFile = (await db.getCachedFile("file", "user"))!.sealed!;
    expect(Array.from(migratedFile.iv)).not.toEqual(Array.from(sealed.iv));
    expect(await (await keys.openCachedAttachment("user", "file", migratedFile)).text()).toBe("offline bytes");
    if (wrapper.method !== "password") throw new Error("Expected a password slot");
    const wrapKey = await deriveEncryptionKey(password, fromBase64Url(wrapper.salt));
    const raw = await decryptData(wrapKey, wrapper.iv, wrapper.ciphertext);
    expect(raw).toHaveLength(32);
    expect(migrated.data).not.toContain(toBase64Url(raw));
    raw.fill(0);
    await reload();
    expect(keys.buildDeviceLinkPublicBundle("Laptop")).toEqual(before);
    expect(await db.getMessageById("original", "user", undefined, true)).toMatchObject({ editKey });
  });

  it("locks and unlocks the same vault with password, PRF and the native adapter", async () => {
    const invoke = vi.fn(async (command: string, args: { vaultId: string; key?: string }) => {
      if (command === "biometric_unlock_enroll") {
        keystore.set(args.vaultId, args.key!);
      } else if (command === "biometric_unlock_remove") {
        keystore.delete(args.vaultId);
      } else if (keystore.has(args.vaultId)) {
        return keystore.get(args.vaultId);
      } else {
        throw "invalidated";
      }
    });
    const keystore = new Map<string, string>();
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const get = vi.fn(async () => ({
      id: "AQID", rawId: bytes,
      response: { clientDataJSON: bytes, authenticatorData: bytes, signature: bytes },
      getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(35).buffer } } }),
    }));
    const create = vi.fn();
    const locks = mockWebLocks();
    vi.stubGlobal("navigator", { credentials: { get, create }, locks });
    vi.stubGlobal("PublicKeyCredential", class {});
    try {
      await keys.initializeKeys(password);
      const identity = keys.buildDeviceLinkPublicBundle("Laptop").identityKey;
      const editKey = toBase64Url(generateAESKey());
      await db.saveMessage({
        id: "original", ownerId: "user", conversationId: "chat", senderId: "user", type: "text", content: "original",
        timestamp: Date.now(), expiresAt: Date.now() + 60_000, status: "sent", editKey,
        editKeyAccepted: true, editSigningKey: identity, editSenderDeviceId: "device",
      });
      await keys.enrollLocalUnlockMethod({ method: "passkey", credentialId: "AQID", rpId: "localhost" });
      window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { biometricUnlock: "touchid" };
      Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
      await keys.enrollLocalUnlockMethod({ method: "native" });
      expect(await keys.listLocalUnlockMethods()).toEqual(["password", "passkey", "native"]);
      expect(keystore.size).toBe(1);
      expect((await db.getKey("dbKey"))!.data).not.toContain([...keystore.values()][0]);

      keys.lockLocalCryptoState();
      expect((await db.getMessageById("original", "user", undefined, true))?.editKey).toBeUndefined();
      await keys.unlockLocalKeys("native");
      expect(keys.buildDeviceLinkPublicBundle("Laptop").identityKey).toBe(identity);
      expect(await db.getMessageById("original", "user", undefined, true)).toMatchObject({ editKey });
      keystore.clear();
      keys.lockLocalCryptoState();
      await expect(keys.unlockLocalKeys("native")).rejects.toMatchObject({ code: "invalidated" });
      expect(keys.keysLoaded()).toBe(false);

      await keys.loadKeys(password);
      await keys.removeLocalUnlockMethod("native");
      expect(invoke).toHaveBeenCalledWith("biometric_unlock_remove", expect.objectContaining({ vaultId: expect.any(String) }));
      delete window.__PRIVATEBASE_NATIVE_CAPABILITIES__;
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
      keys.lockLocalCryptoState();
      await keys.unlockLocalKeys("passkey");
      expect(keys.buildDeviceLinkPublicBundle("Laptop").identityKey).toBe(identity);
      expect(await db.getMessageById("original", "user", undefined, true)).toMatchObject({ editKey });
      await keys.removeLocalUnlockMethod("password");
      expect(get).toHaveBeenCalledTimes(3);
      await expect(keys.removeLocalUnlockMethod("passkey")).rejects.toThrow("Keep at least one unlock method");
      keys.lockLocalCryptoState();
      await expect(keys.loadKeys(password)).rejects.toThrow();
      expect(keys.keysLoaded()).toBe(false);
    } finally {
      delete window.__PRIVATEBASE_NATIVE_CAPABILITIES__;
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
      vi.doUnmock("@tauri-apps/api/core");
    }
  });

  it("prepares a fresh bundle in memory until the unlock slot commits, without overwriting another vault", async () => {
    const first = await keys.prepareDeviceKeySetup("New browser", "web");
    const second = await keys.prepareDeviceKeySetup("Other tab", "web");
    expect(await keys.hasLocalKeyMaterial()).toBe(false);
    expect(first.bundle.bundleSignature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    await first.commit({ method: "password", password });
    await expect(second.commit({ method: "password", password })).rejects.toThrow(/changed/);
    expect(keys.buildDeviceLinkPublicBundle("New browser").identityKey).toBe(first.bundle.identityKey);
    await reload();
    expect(keys.buildDeviceLinkPublicBundle("New browser").identityKey).toBe(first.bundle.identityKey);
  });
});

it("notifies mounted consumers after saving or removing an unlock slot", async () => {
  const { subscribeToUnlockMethodChanges } = await import("./unlock-method-changes.js");
  await keys.initializeKeys(password);
  const changes: Promise<Awaited<ReturnType<typeof keys.listLocalUnlockMethods>>>[] = [];
  const unsubscribe = subscribeToUnlockMethodChanges(() => { changes.push(keys.listLocalUnlockMethods()); });
  try {
    await keys.enrollLocalUnlockMethod({ method: "passkey", credentialId: "AQID", rpId: "localhost",
      salt: new Uint8Array(32), output: new Uint8Array(32).fill(23) });
    await expect(Promise.all(changes)).resolves.toEqual([["password", "passkey"]]);
    await keys.removeLocalUnlockMethod("passkey");
    await expect(Promise.all(changes)).resolves.toEqual([["password", "passkey"], ["password"]]);
  } finally { unsubscribe(); }
});

it.each(["prf", "prf-autofill", "resumed-prf-add", "resumed-prf-skip", "resumed-prf-legacy", "resumed-prf-chosen", "resumed-prf-stale", "resumed-prf-saved-password",
  "resumed-prf-idle-locked", "resumed-prf-reopened", "resumed-prf-lock-during-complete", "resumed-prf-activation-retry",
  "password", "approval_required", "approval-at-completion", "lost-complete", "forgotten-checkpoint", "changed-checkpoint",
  "resumed-replacement", "locked-after-save", "activated-expiry"] as const)("runs the fresh web setup with %s", async (mode) => {
  const { beginPasskeyDeviceSetup, preparePasskeyDeviceSetup, resumePasskeyDeviceSetup, DeviceApprovalRequiredError } = await import("./passkey-provision.js");
  const { readVault } = await import("./device-key-vault.js");
  const resumePrf = mode.startsWith("resumed-prf-");
  const hasPrf = mode === "prf" || mode === "prf-autofill" || resumePrf;
  const addBackup = mode === "resumed-prf-add" || mode === "resumed-prf-activation-retry";
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const prfBytes = new Uint8Array(32).fill(23);
  const get = vi.fn(async (_options: CredentialRequestOptions) => ({
    id: "AQID", rawId: bytes,
    response: { clientDataJSON: bytes, authenticatorData: bytes, signature: bytes },
    getClientExtensionResults: () => hasPrf ? { prf: { enabled: false, results: { first: prfBytes.slice().buffer } } }
      : mode === "password" ? { prf: { enabled: true } } : {},
  }));
  vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get } });
  vi.stubGlobal("PublicKeyCredential", class {});
  const setupToken = "setup-token";
  const pending = (setupId: string) => ({ setupId, user: { id: "user", username: "alice" }, deviceId: "linked",
    deviceName: "Laptop", platform: "web", setupToken });
  const replacement = { limitTicket: "limit-ticket", revokeDeviceId: "old-device", recoveryKeyProof: "recovery-proof" };
  let originalBundle: unknown;
  let finishCount = 0;
  let verified = false;
  vi.mocked(api.post).mockImplementation(async (path, body, options) => {
    if (path === "/auth/passkey/provision-options") {
      expect(body).toEqual({ bundleHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
      return { challengeId: "challenge", options: {
        challenge: "AQID", timeout: 60_000, rpId: "localhost", allowCredentials: [], userVerification: "required",
      } } as never;
    }
    const record = (await db.readPendingSetupRecord())!;
    if (path === "/auth/passkey/provision") {
      expect(await keys.hasLocalKeyMaterial()).toBe(false);
      expect(record.stage).toBe("prepared");
      expect(body).toEqual({ setupId: record.setupId, challengeId: "challenge", bundle: expect.objectContaining({
        bundleSignature: expect.any(String), identityKey: expect.any(String),
      }), credential: expect.objectContaining({ id: "AQID" }) });
      expect(JSON.stringify(body)).not.toMatch(/"(password|prf|privateKey)"\s*:/);
      originalBundle = (body as { bundle: unknown }).bundle;
      if (mode === "approval_required") throw Object.assign(new Error(), { status: 403, body: { error: mode } });
      return pending(record.setupId) as never;
    }
    if (path === "/auth/password/verify") {
      expect(await keys.hasLocalKeyMaterial()).toBe(hasPrf);
      expect(options).toEqual({ bearerToken: setupToken });
      if ((body as { password: string }).password !== password) throw Object.assign(new Error(), { status: 401, body: { error: "invalid_password" } });
      verified = true;
      return { verified: true } as never;
    }
    if (path === "/auth/passkey/provision/resume-options") return { challengeId: "proof-challenge" } as never;
    if (path === "/auth/passkey/provision/resume") {
      expect(body).toEqual({ setupId: record.setupId, challengeId: "proof-challenge", signature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/) });
      return pending(record.setupId) as never;
    }
    if (path === "/auth/passkey/provision/replace") {
      expect(body).toEqual({ ...replacement, setupId: record.setupId, bundle: originalBundle });
      return pending(record.setupId) as never;
    }
    expect(path).toBe("/auth/passkey/provision/complete");
    expect(options).toEqual({ bearerToken: setupToken });
    expect(await keys.hasLocalKeyMaterial()).toBe(true);
    expect(record.stage).toBe("unlockReady");
    expect(record.backupPending).toBe(false);
    expect(JSON.stringify(record)).not.toContain(setupToken);
    expect(verified).toBe(!hasPrf || addBackup || mode === "resumed-prf-saved-password");
    if (mode === "approval-at-completion") throw { status: 403, body: { error: "approval_required" } };
    if (mode === "activated-expiry" && finishCount++ > 0) throw Object.assign(new Error("Already active"), { status: 409, body: { error: "setup_already_active" } });
    if (mode === "activated-expiry") throw new Error("network read failed");
    if (mode === "lost-complete" && finishCount++ === 0) throw new Error("network read failed");
    if (mode === "resumed-prf-activation-retry" && finishCount++ === 0) throw new Error("network read failed");
    if (mode === "resumed-prf-lock-during-complete" && finishCount++ === 0) keys.lockLocalCryptoState();
    if (mode === "resumed-replacement" && finishCount++ === 0) {
      throw Object.assign(new Error(), { status: 409, body: { error: "device_limit", limitTicket: replacement.limitTicket } });
    }
    if (mode === "forgotten-checkpoint") await keys.resetLocalCryptoState(record.setupId);
    if (mode === "changed-checkpoint") await db.updatePendingSetupRecord({ ...record, deviceId: "other-device" }, record);

    return { user: { id: "user", username: "alice" }, device: { id: "linked" } } as never;
  });

  const setupPromise = mode === "prf-autofill" ? (async () => {
    const prepared = await preparePasskeyDeviceSetup("Laptop");
    const assertion = await prepared.requestAutofill(new AbortController().signal);
    return prepared.authorize({ assertion });
  })() : beginPasskeyDeviceSetup("Laptop");
  if (mode === "approval_required") {
    await expect(setupPromise).rejects.toBeInstanceOf(DeviceApprovalRequiredError);
    expect(await keys.hasLocalKeyMaterial()).toBe(false);
    expect(await db.readPendingSetupRecord()).toBeUndefined();
    return;
  }
  const setup = await setupPromise;
  expect(await keys.hasLocalKeyMaterial()).toBe(false);
  expect(setup.method).toBe(hasPrf ? "passkey" : "password");
  expect(get).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    publicKey: expect.objectContaining({
      userVerification: "required", extensions: { prf: { eval: { first: expect.any(ArrayBuffer) } } },
    }),
    ...(mode === "prf-autofill" ? { mediation: "conditional" } : {}),
  }));
  if (hasPrf) {
    await setup.persistUnlock();
    expect(await db.readPendingSetupRecord()).toMatchObject({ stage: "unlockReady", backupPending: "passkey" });
    const salt = get.mock.calls[0][0].publicKey?.extensions?.prf?.eval?.first as ArrayBuffer;
    const vault = readVault(await (await db.getAppDB()).get("deviceKeys", "dbKey"));
    expect(vault?.slots).toEqual([expect.objectContaining({ method: "passkey", credentialId: "AQID", salt: toBase64Url(new Uint8Array(salt)) })]);
    if (mode === "prf") await expect(setup.complete()).rejects.toThrow("Choose whether to add password unlock");
    if (!resumePrf || mode === "resumed-prf-chosen") await setup.chooseBackupPassword();
  }
  if (resumePrf) {
    if (mode === "resumed-prf-saved-password") {
      // Simulate a reload between saving a verified backup and recording the choice.
      verified = true;
      await keys.enrollLocalUnlockMethod({ method: "password", password });
    }
    setup.discard();
    keys.lockLocalCryptoState();
    if (mode === "resumed-prf-legacy") {
      const record = (await db.readPendingSetupRecord())!;
      await db.updatePendingSetupRecord({ ...record, backupPending: undefined }, record);
    }
    const result = await resumePasskeyDeviceSetup("passkey");
    if (mode === "resumed-prf-chosen" || mode === "resumed-prf-saved-password") {
      expect(result).toMatchObject({ device: { id: "linked" } });
    } else {
      expect(result).toMatchObject({ setupId: setup.setupId, backupMethod: "passkey" });
      if (!("backupMethod" in result)) throw new Error("Expected the backup decision");
      const record = (await db.readPendingSetupRecord())!;
      const finishCalls = () => vi.mocked(api.post).mock.calls.filter(([path]) => path === "/auth/passkey/provision/complete");
      expect(finishCalls()).toHaveLength(0);
      if (mode === "resumed-prf-idle-locked" || mode === "resumed-prf-reopened") {
        vi.useFakeTimers();
        keys.resetIdleTimer();
        vi.advanceTimersByTime(15 * 60_000);
        vi.useRealTimers();
        expect(keys.keysLoaded()).toBe(false);
        if (mode === "resumed-prf-reopened") await keys.unlockLocalKeys("passkey");
        await expect(result.chooseBackupPassword()).rejects.toMatchObject({ name: "KeysLockedError" });
        await expect(result.chooseBackupPassword(password)).rejects.toMatchObject({ name: "KeysLockedError" });
        expect(await db.readPendingSetupRecord()).toEqual(record);
        expect(await keys.listLocalUnlockMethods()).toEqual(["passkey"]);
        expect(vi.mocked(api.post).mock.calls.some(([path]) => path === "/auth/password/verify")).toBe(false);
        expect(finishCalls()).toHaveLength(0);
        return;
      }
      if (mode === "resumed-prf-stale") {
        await db.updatePendingSetupRecord({ ...record, backupPending: false }, record);
        await expect(result.chooseBackupPassword()).rejects.toThrow("Device setup changed");
        expect(finishCalls()).toHaveLength(0);
        return;
      }
      if (mode === "resumed-prf-add") {
        await expect(result.chooseBackupPassword("wrong-password")).rejects.toMatchObject({ body: { error: "invalid_password" } });
        expect(await db.readPendingSetupRecord()).toEqual(record);
      }
      await result.chooseBackupPassword(addBackup ? password : undefined);
      expect(await db.readPendingSetupRecord()).toMatchObject({ stage: "unlockReady", backupPending: false });
      if (mode === "resumed-prf-lock-during-complete") {
        await expect(result.complete()).rejects.toMatchObject({ name: "KeysLockedError" });
        await expect(result.complete()).rejects.toMatchObject({ name: "KeysLockedError" });
        expect(finishCalls()).toHaveLength(1);
        expect(await db.readPendingSetupRecord()).toMatchObject({ stage: "unlockReady", backupPending: false });
        await expect(resumePasskeyDeviceSetup("passkey")).resolves.toMatchObject({ device: { id: "linked" } });
        expect(finishCalls()).toHaveLength(2);
        return;
      }
      if (mode === "resumed-prf-activation-retry") {
        await expect(result.complete()).rejects.toThrow("network read failed");
        expect(await keys.listLocalUnlockMethods()).toEqual(["passkey", "password"]);
        expect(await db.readPendingSetupRecord()).toMatchObject({ stage: "unlockReady", backupPending: false });
      }
      await expect(result.complete()).resolves.toMatchObject({ device: { id: "linked" } });
      expect(finishCalls()).toHaveLength(mode === "resumed-prf-activation-retry" ? 2 : 1);
      if (mode === "resumed-prf-activation-retry") {
        expect(vi.mocked(api.post).mock.calls.filter(([path]) => path === "/auth/password/verify")).toHaveLength(1);
      }
    }
    expect(await keys.listLocalUnlockMethods()).toEqual(addBackup || mode === "resumed-prf-saved-password"
      ? ["passkey", "password"] : ["passkey"]);
    expect(await db.readPendingSetupRecord()).toMatchObject({ stage: "complete", backupPending: false });
    expect(get).toHaveBeenCalledTimes(2);
    return;
  }
  if (mode === "password") {
    await expect(setup.complete("mistyped-password")).rejects.toMatchObject({ body: { error: "invalid_password" } });
    expect(await keys.hasLocalKeyMaterial()).toBe(false);
  }
  if (mode === "approval-at-completion") {
    await expect(setup.complete(password)).rejects.toMatchObject({ name: "DeviceApprovalRequiredError", username: "alice" });
    setup.discard();
    expect(await keys.hasLocalKeyMaterial()).toBe(true);
    expect(await db.readPendingSetupRecord()).toMatchObject({ setupId: setup.setupId, stage: "unlockReady" });
    return;
  }
  if (mode === "locked-after-save") {
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "accountState" && value.id === "setup:pending" && value.stage === "unlockReady") {
        this.transaction.addEventListener("complete", () => keys.lockLocalCryptoState(), { once: true });
      }
      return put.call(this, value, key);
    });
    await expect(setup.complete(password)).rejects.toMatchObject({ name: "KeysLockedError" });
    expect(setup.canUsePasswordFallback()).toBe(false);
    await expect(setup.abandon()).rejects.toThrow("Finish or revoke this device");
    expect((await db.readPendingSetupRecord())?.stage).toBe("unlockReady");
    setup.discard();
    return;
  }
  const completion = setup.complete(hasPrf ? undefined : password);
  if (mode === "forgotten-checkpoint" || mode === "changed-checkpoint") {
    await expect(completion).rejects.toThrow("Device setup changed");
    expect(setup.closed).toBe(true);
    expect((await db.readPendingSetupRecord())?.deviceId).toBe(mode === "changed-checkpoint" ? "other-device" : undefined);
    return;
  }
  if (mode === "activated-expiry") {
    await expect(completion).rejects.toThrow("network read failed");
    setup.discard();
    keys.lockLocalCryptoState();
    await expect(resumePasskeyDeviceSetup("password", password)).rejects.toMatchObject({ body: { error: "setup_already_active" } });
    expect(await db.readPendingSetupRecord()).toBeUndefined();
    expect(await keys.hasLocalKeyMaterial()).toBe(true);
    return;
  }
  if (mode === "lost-complete" || mode === "resumed-replacement") {
    if (mode === "lost-complete") await expect(completion).rejects.toThrow("network read failed");
    else await expect(completion).rejects.toMatchObject({ body: { error: "device_limit" } });
    expect((await db.readPendingSetupRecord())?.stage).toBe("unlockReady");
    setup.discard();
    keys.lockLocalCryptoState();
    await expect(resumePasskeyDeviceSetup("password", password, mode === "resumed-replacement" ? replacement : undefined))
      .resolves.toMatchObject({ device: { id: "linked" } });
  } else {
    await expect(completion).resolves.toMatchObject({ device: { id: "linked" } });
  }
  expect(await keys.getLocalKeyOwner()).toEqual({ userId: "user", username: "alice", deviceId: "linked" });
  expect(await keys.listLocalUnlockMethods()).toEqual([hasPrf ? "passkey" : "password"]);
  expect(get).toHaveBeenCalledTimes(1);
});

it("holds setup ownership through preparation and allows a new attempt after discard", async () => {
  const { preparePasskeyDeviceSetup } = await import("./passkey-provision.js");
  vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get: vi.fn() } });
  vi.stubGlobal("PublicKeyCredential", class {});
  vi.mocked(api.post).mockResolvedValue({ challengeId: "challenge", options: {} });
  const first = await preparePasskeyDeviceSetup("Laptop");
  await expect(preparePasskeyDeviceSetup("Other tab")).rejects.toThrow("already running");
  expect((await db.readPendingSetupRecord())?.setupId).toBe(first.setupId);
  await first.discard();
  const second = await preparePasskeyDeviceSetup("Laptop");
  expect(second.setupId).not.toBe(first.setupId);
  await second.discard();
  expect(await db.readPendingSetupRecord()).toBeUndefined();
});

it("keeps another tab's live setup checkpoint when Web Locks is unavailable", async () => {
  const { clearInterruptedPasskeySetup, preparePasskeyDeviceSetup, PasskeySetupBusyError } = await import("./passkey-provision.js");
  vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get: vi.fn() } });
  vi.stubGlobal("PublicKeyCredential", class {});
  const current = { id: "setup:pending" as const, setupId: "other-tab", deviceId: "pending", bundleHash: "digest",
    stage: "provisioned" as const, createdAt: Date.now() };
  await db.updatePendingSetupRecord(current);
  expect(await db.claimPasskeySetupLease("other-owner", 60_000)).toBe(true);
  await expect(clearInterruptedPasskeySetup()).rejects.toBeInstanceOf(PasskeySetupBusyError);
  await expect(preparePasskeyDeviceSetup("Laptop")).rejects.toBeInstanceOf(PasskeySetupBusyError);
  expect(await db.readPendingSetupRecord()).toEqual(current);
  await db.releasePasskeySetupLease("other-owner");
  await expect(clearInterruptedPasskeySetup()).resolves.toBe(true);
  expect(await db.readPendingSetupRecord()).toBeUndefined();
});

it("clears an interrupted attempt only if the whole checkpoint still matches", async () => {
  const { clearInterruptedPasskeySetup } = await import("./passkey-provision.js");
  const current = { id: "setup:pending" as const, setupId: "incomplete", deviceId: "pending", bundleHash: "digest",
    stage: "provisioned" as const, createdAt: Date.now() };
  const saved = { ...current, stage: "unlockReady" as const };
  await db.updatePendingSetupRecord(current);
  const transaction = IDBDatabase.prototype.transaction;
  let read = false;
  const intercept = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase, stores, mode, options,
  ) {
    if (stores === "accountState" && read && mode === "readwrite") {
      read = false;
      transaction.call(this, "accountState", "readwrite").objectStore("accountState").put(saved);
    }
    if (stores === "accountState" && mode !== "readwrite") read = true;
    return transaction.call(this, stores, mode, options);
  });
  await expect(clearInterruptedPasskeySetup()).resolves.toBe(false);
  intercept.mockRestore();
  expect(await db.readPendingSetupRecord()).toEqual(saved);
});

it("aborts the web provisioning POST and releases setup ownership for another attempt", async () => {
  const { preparePasskeyDeviceSetup } = await import("./passkey-provision.js");
  vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get: vi.fn() } });
  vi.stubGlobal("PublicKeyCredential", class {});
  const controller = new AbortController();
  let posted!: () => void;
  const submitted = new Promise<void>(resolve => { posted = resolve; });
  vi.mocked(api.post).mockImplementation(async (path, _, options) => {
    if (path.endsWith("-options")) return { challengeId: "challenge", options: {} } as never;
    posted();
    expect(path).toBe("/auth/passkey/provision");
    expect(options?.signal).toBe(controller.signal);
    return new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
  });
  const setup = await preparePasskeyDeviceSetup("Laptop");
  const authorization = setup.authorize({ signal: controller.signal, assertion: { credential: { id: "AQID" } as never } });
  const cancelled = expect(authorization).rejects.toMatchObject({ name: "AbortError" });
  await submitted;
  controller.abort();
  await cancelled;
  expect(await db.readPendingSetupRecord()).toBeUndefined();
  const next = await preparePasskeyDeviceSetup("Next");
  await next.discard();
});

it("verifies a backup account password while unlocked and protects a sole PRF passkey", async () => {
  const { addAccountPasswordUnlock } = await import("./passkey-provision.js");
  await signInForUnlockEnrollment();
  const prepared = await keys.prepareDeviceKeySetup("Laptop", "web");
  await prepared.commit({ method: "passkey", credentialId: "AQID", rpId: "localhost",
    salt: new Uint8Array(32).fill(12), output: new Uint8Array(32).fill(24) });
  expect(await keys.isOnlyLocalPasskeyUnlock("AQID")).toBe(true);
  vi.mocked(api.post).mockRejectedValueOnce(new Error("invalid_password"));
  await expect(addAccountPasswordUnlock("mistyped")).rejects.toThrow("invalid_password");
  expect(await keys.listLocalUnlockMethods()).toEqual(["passkey"]);
  vi.mocked(api.post).mockResolvedValueOnce({ verified: true });
  await addAccountPasswordUnlock(password);
  expect(await keys.isOnlyLocalPasskeyUnlock("AQID")).toBe(false);
  keys.lockLocalCryptoState();
  await expect(keys.loadKeys(password)).resolves.toBeUndefined();
});

it("requires reported native availability before counting a native slot as backup for a passkey", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { androidBiometricProbe: true });
  const invoke = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("fingerprint");
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  try {
    const { canUseNativeUnlock, refreshNativeUnlockCapability } = await import("../platform/biometric-unlock.js");
    const { readVault, vaultRecord } = await import("./device-key-vault.js");
    const prepared = await keys.prepareDeviceKeySetup("Phone", "android");
    await prepared.commit({ method: "passkey", credentialId: "AQID", rpId: "localhost",
      salt: new Uint8Array(32).fill(12), output: new Uint8Array(32).fill(24) });
    const vault = readVault(await db.getKey("dbKey"))!;
    vault.slots.push({ method: "native", keyId: "native-slot" });
    await db.saveKeys([vaultRecord(vault)]);

    expect(await keys.isOnlyLocalPasskeyUnlock("AQID")).toBe(true);
    await refreshNativeUnlockCapability();
    expect(canUseNativeUnlock()).toBe(true);
    expect(await keys.isOnlyLocalPasskeyUnlock("AQID")).toBe(true);
    await expect(keys.removeLocalUnlockMethod("passkey")).rejects.toThrow("Keep at least one unlock method");
    expect(await keys.listLocalUnlockMethods()).toEqual(["passkey", "native"]);

    await refreshNativeUnlockCapability();
    expect(await keys.isOnlyLocalPasskeyUnlock("AQID")).toBe(false);
  } finally { vi.doUnmock("@tauri-apps/api/core"); }
});

it("clears pending setup metadata only when forgetting the matching local vault", async () => {
  const { forgetSavedPasskeySetup } = await import("./passkey-provision.js");
  const setupId = crypto.randomUUID();
  await keys.initializeKeys(password);
  await db.updatePendingSetupRecord({ id: "setup:pending", setupId, bundleHash: "digest", deviceId: "device",
    createdAt: Date.now(), stage: "unlockReady" });
  expect(await forgetSavedPasskeySetup(crypto.randomUUID())).toBe(false);
  expect(await keys.hasLocalKeyMaterial()).toBe(true);
  expect((await db.readPendingSetupRecord())?.setupId).toBe(setupId);
  expect(await forgetSavedPasskeySetup(setupId)).toBe(true);
  expect(await keys.hasLocalKeyMaterial()).toBe(false);
  expect(await db.readPendingSetupRecord()).toBeUndefined();
});

it.each(["unknown_credential", "uv_required", "network-then-expired"])("allows a new ceremony after %s", async (failure) => {
  const { beginPasskeyDeviceSetup } = await import("./passkey-provision.js");
  const rawId = new Uint8Array([1, 2, 3]).buffer;
  const get = vi.fn(async () => ({
    id: "AQID", rawId, response: { clientDataJSON: rawId, authenticatorData: rawId, signature: rawId },
    getClientExtensionResults: () => ({}),
  }));
  vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get } });
  vi.stubGlobal("PublicKeyCredential", class {});
  const requests: unknown[] = [];
  let optionsCount = 0;
  vi.mocked(api.post).mockImplementation(async (path, body) => {
    if (path === "/auth/passkey/provision-options") return { challengeId: `challenge-${++optionsCount}`, options: {
      challenge: "AQID", timeout: 60_000, rpId: "localhost", allowCredentials: [], userVerification: "required",
    } } as never;
    requests.push(body);
    if (optionsCount === 1) {
      if (failure === "network-then-expired" && requests.length === 1) throw new TypeError("Failed to fetch");
      throw Object.assign(new Error("Rejected"), { status: failure === "uv_required" ? 400 : 401, body: { error: failure } });
    }
    return { deviceId: "linked", setupToken: "token" } as never;
  });
  if (failure === "network-then-expired") {
    const attempt = await beginPasskeyDeviceSetup("Laptop");
    expect(attempt.authorizationError).toBeInstanceOf(TypeError);
    await expect(attempt.retryAuthorization()).rejects.toThrow("Rejected");
    expect(attempt.closed).toBe(true);
    expect(requests[1]).toEqual(requests[0]);
    expect(get).toHaveBeenCalledTimes(1);
  } else {
    await expect(beginPasskeyDeviceSetup("Laptop")).rejects.toThrow("Rejected");
  }
  expect(await db.readPendingSetupRecord()).toBeUndefined();
  const fresh = await beginPasskeyDeviceSetup("Laptop");
  expect(fresh.pending?.deviceId).toBe("linked");
  expect(get).toHaveBeenCalledTimes(2);
  expect(requests[0]).not.toEqual(requests.at(-1));
  fresh.discard();
});

it("a losing registration cannot replace or clear a passkey vault committed by another setup", async () => {
  const prepared = await keys.prepareDeviceKeySetup("Laptop", "web");
  const setupId = crypto.randomUUID();
  const vaultId = crypto.randomUUID();
  const checkpoint = { id: "setup:pending" as const, setupId, bundleHash: "digest", stage: "unlockReady" as const,
    deviceId: "passkey-device", createdAt: Date.now() };
  await db.updatePendingSetupRecord({ ...checkpoint, stage: "provisioned" });
  await prepared.commit({ method: "password", password }, {
    record: checkpoint, owner: { userId: "alice-id", username: "alice", deviceId: "passkey-device" },
  });
  await expect(keys.initializeKeys("registration-password", vaultId)).rejects.toThrow("Local keys changed");
  expect(await keys.resetLocalCryptoState(undefined, vaultId)).toBe(false);
  expect(await db.readPendingSetupRecord()).toEqual(checkpoint);
  await keys.loadKeys(password);
  expect(keys.buildDeviceLinkPublicBundle("Laptop").identityKey).toBe(prepared.bundle.identityKey);
});

async function signInForUnlockEnrollment() {
  const { useAuthStore } = await import("../stores/authStore.js");
  useAuthStore.setState({ accessToken: "current-token", sessionId: "initial-session",
    user: { id: "account", username: "alice" } as never, device: { id: "device" } as never });
  return useAuthStore;
}

it("keeps the password slot until a supported alternative proves it can open the actual vault", async () => {
  mockWebLocks();
  const { capabilities } = await import("../platform/capabilities.js");
  const { biometricUnlock } = await import("../platform/biometric-unlock.js");
  const native = vi.spyOn(capabilities, "biometricUnlock", "get").mockReturnValue("touchid");
  let raw!: Uint8Array;
  vi.spyOn(biometricUnlock, "enroll").mockImplementation(async (_, key) => { raw = new Uint8Array(key); });
  const unlock = vi.spyOn(biometricUnlock, "unlock").mockResolvedValue(new Uint8Array(32).fill(9));
  const identity = await keys.initializeKeys(password);
  await keys.enrollLocalUnlockMethod({ method: "native" });
  const record = await db.getKey("dbKey");

  native.mockReturnValue(undefined);
  await expect(keys.removeLocalUnlockMethod("password")).rejects.toThrow("Keep at least one unlock method");
  expect(unlock).not.toHaveBeenCalled();
  expect(await db.getKey("dbKey")).toEqual(record);

  native.mockReturnValue("touchid");
  await expect(keys.removeLocalUnlockMethod("password")).rejects.toMatchObject({ name: "OperationError" });
  expect(await db.getKey("dbKey")).toEqual(record);
  unlock.mockImplementation(async () => new Uint8Array(raw));
  await keys.removeLocalUnlockMethod("password");
  expect(await keys.listLocalUnlockMethods()).toEqual(["native"]);
  keys.lockLocalCryptoState();
  await keys.unlockLocalKeys("native");
  expect(keys.buildDeviceLinkPublicBundle("Laptop").identityKey).toBe(identity);
});

it("binds password enrollment to the initiating account session even if its vault remains unlocked", async () => {
  const store = await signInForUnlockEnrollment();
  const { addAccountPasswordUnlock } = await import("./passkey-provision.js");
  await keys.initializeKeys(password);
  const previous = await db.getKey("dbKey");
  let verified!: (response: { verified: boolean }) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise(resolve => { verified = resolve; }));
  const enrollment = addAccountPasswordUnlock("another password");
  store.setState({ sessionId: "other-session", user: { id: "another-account" } as never });
  verified({ verified: true });
  await expect(enrollment).rejects.toMatchObject({ name: "KeysLockedError" });
  expect(await db.getKey("dbKey")).toEqual(previous);
});

it("does not enroll a credential in another vault opened while the settings PRF prompt was pending", async () => {
  await signInForUnlockEnrollment();
  const { capabilities } = await import("../platform/capabilities.js");
  const { enrollPasskeyUnlock } = await import("../features/settings/UnlockSettings.js");
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  let answer!: (credential: object) => void;
  vi.stubGlobal("navigator", { credentials: { get: () => new Promise(resolve => { answer = resolve; }) } });
  await keys.initializeKeys(password);
  const enrollment = enrollPasskeyUnlock("AQID", "localhost");
  await keys.resetLocalCryptoState();
  await keys.initializeKeys("new owner password");
  const replacement = await db.getKey("dbKey");
  const bytes = Uint8Array.of(1, 2, 3).buffer;
  answer({ id: "AQID", rawId: bytes, response: { clientDataJSON: bytes, authenticatorData: bytes, signature: bytes },
    getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(5).buffer } } }),
  });
  await expect(enrollment).rejects.toMatchObject({ name: "KeysLockedError" });
  expect(await db.getKey("dbKey")).toEqual(replacement);
  expect(await keys.listLocalUnlockMethods()).toEqual(["password"]);
});

it("wraps and opens a PRF vault with offset salts and PRF output from shared storage", async () => {
  function sharedBytes(fill: number) {
    const bytes = new Uint8Array(new SharedArrayBuffer(35));
    bytes.fill(fill, 1, 33);
    return bytes.subarray(1, 33);
  }
  const salt = sharedBytes(12);
  const { capabilities } = await import("../platform/capabilities.js");
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  const get = vi.fn(async ({ publicKey }: CredentialRequestOptions) => {
    const challenge = publicKey?.extensions?.prf?.eval?.first;
    expect(challenge).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(challenge as ArrayBuffer)).toEqual(new Uint8Array(32).fill(12));
    const bytes = Uint8Array.of(1, 2, 3).buffer;
    return { id: "AQID", rawId: bytes, response: { clientDataJSON: bytes, authenticatorData: bytes, signature: bytes },
      getClientExtensionResults: () => ({ prf: { results: { first: sharedBytes(24) } } }),
    };
  });
  vi.stubGlobal("navigator", { credentials: { get } });
  const prepared = await keys.prepareDeviceKeySetup("Laptop", "web");
  await prepared.commit({ method: "passkey", credentialId: "AQID", rpId: "localhost", salt, output: sharedBytes(24) });
  keys.lockLocalCryptoState();
  await keys.unlockLocalKeys("passkey");
  expect(keys.buildDeviceLinkPublicBundle("Laptop").identityKey).toBe(prepared.bundle.identityKey);
});
