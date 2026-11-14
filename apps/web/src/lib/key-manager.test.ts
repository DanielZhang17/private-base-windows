import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OTP_KEY_POOL_SIZE } from "@e2ee-chat/shared";

vi.mock("../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

let keys: typeof import("./key-manager.js");
let db: typeof import("../db/index.js");
let api: typeof import("../services/api.js")["api"];
const password = "correct horse battery staple";

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
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>("node:crypto");
  vi.stubGlobal("crypto", webcrypto);
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

describe("encrypted one-time pre-key persistence", () => {
  it("leaves no partial key records when the initialization transaction aborts", async () => {
    const originalPut = IDBObjectStore.prototype.put;
    let aborted = false;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      if (this.name === "localKeys" && value.id === "identity") {
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
