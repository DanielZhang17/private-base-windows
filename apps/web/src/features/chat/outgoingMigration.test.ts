import { encryptMessageEdit, generateAESKey, generateIdentityKeyPair, serializeIdentityKeyPair, toBase64Url } from "@e2ee-chat/crypto";
import { openDB, type IDBPDatabase } from "idb";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("waits for v5 writers, quarantines ambiguous rows, and fences even an unversioned v5 reopen", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
  const old = await openDB("e2ee-chat", 5, { upgrade(db) {
    for (const name of ["messages", "localKeys", "syncState", "sessions", "senderKeys", "fileCache"]) db.createObjectStore(name, { keyPath: "id" });
  } });
  const row = { conversationId: "chat", senderId: "peer", type: "text", content: "cached", status: "delivered",
    timestamp: Date.now(), expiresAt: Date.now() + 60_000 };
  await old.put("messages", { ...row, id: "unverified" });
  await old.put("messages", { ...row, ownerId: "user", id: "verified:wire" });
  await old.put("messages", { ...row, ownerId: "user", id: "ambiguous-receipt" });
  await old.put("messages", { ...row, id: "pending", type: "file", content: '{"fileId":"hidden-file","fileKey":"private key"}' });
  await old.put("fileCache", { id: "hidden-file", blob: new Blob(["private attachment"]) });
  await old.put("localKeys", { id: "owner", data: JSON.stringify({ userId: "user", deviceId: "device" }) });
  await old.put("localKeys", { id: "identity", data: "encrypted-private-key" });
  await old.put("sessions", { id: "peer:device", state: "advanced" });
  await old.put("syncState", { id: "message-sync:user:device", value: 42 });
  await old.put("syncState", { id: "outgoing:queued", outgoing: { id: "queued", userId: "user" } });
  await old.put("syncState", { id: "hidden-message:unverified" });
  await old.put("syncState", { id: "hidden-message:pending", undoToken: "v5-tab", undoDeadline: Date.now() + 5_000 });
  await old.put("syncState", { id: "received:verified:wire", ownerId: "user", deviceId: "device", expiresAt: row.expiresAt });
  await old.put("syncState", { id: "received:ambiguous-receipt", ownerId: "user", expiresAt: row.expiresAt });
  const db = await import("../../db/index.js");
  const opening = db.getAppDB();
  const opened = vi.fn();
  void opening.then(opened);
  await vi.waitFor(() => expect(db.isDatabaseUpgradeBlocked()).toBe(true));
  expect(db.getAppDB()).toBe(opening);
  expect(opened).not.toHaveBeenCalled();
  old.close();
  const next = await opening;
  try {
    expect(next.version).toBe(8);
    expect(db.isDatabaseUpgradeBlocked()).toBe(false);
    expect(await db.getMessageById("unverified", "user")).toBeUndefined();
    expect(await next.get("legacyMessages", "unverified")).toMatchObject({ content: "cached" });
    expect(await db.getMessageById("verified:wire", "user")).toMatchObject({ id: "verified" });
    expect(await db.getReceiveReceipt("verified:wire", "user", "device")).toBeDefined();
    expect(await db.getReceiveReceipt("verified:wire", "user", "another-device")).toBeUndefined();
    expect(await db.getReceiveReceipt("ambiguous-receipt", "user", "device")).toBeUndefined();
    expect(await db.isMessageHidden("unverified", "user")).toBe(true);
    expect(await db.isMessageHidden("pending", "user")).toBe(true);
    expect(await next.get("accountState", "hidden-message:pending")).not.toHaveProperty("undoToken");
    expect(await next.get("legacyMessages", "pending")).toBeUndefined();
    expect(await next.get("accountFiles", "hidden-file")).toBeUndefined();
    expect(await db.getAllOutgoing()).toMatchObject([{ id: "queued" }]);
    expect(await db.getSyncState("message-sync:user:device")).toMatchObject({ value: 42 });
    expect(await db.getSession("peer:device")).toMatchObject({ state: "advanced" });
    expect(await db.getKey("identity")).toMatchObject({ data: "encrypted-private-key" });
    await expect(openDB("e2ee-chat", 5)).rejects.toMatchObject({ name: "VersionError" });
    const staleFallback = await openDB("e2ee-chat");
    try {
      for (const name of ["messages", "sessions", "senderKeys", "syncState", "localKeys"]) {
        await expect(Promise.resolve().then(() => staleFallback.put(name, { id: "old-write" })))
          .rejects.toMatchObject({ name: "NotFoundError" });
      }
    } finally { staleFallback.close(); }
  } finally { next.close(); }
});

it("migrates the supported pre-release v6 outbox and indexes quarantine expiry including retention fallback", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
  const old = await openDB("e2ee-chat", 6, { upgrade(db) {
    for (const name of ["messages", "localKeys", "syncState", "sessions", "outgoingQueue"]) db.createObjectStore(name, { keyPath: "id" });
  } });
  const now = Date.now();
  const row = { conversationId: "chat", senderId: "user", type: "text", content: "cached", status: "delivered", timestamp: now, expiresAt: now + 60_000 };
  await old.put("messages", { ...row, id: "draft", status: "sending" });
  await old.put("messages", { ...row, id: "future-fallback", expiresAt: null });
  await old.put("messages", { ...row, id: "expired-fallback", timestamp: 1, expiresAt: null });
  const seeds = old.transaction("messages", "readwrite");
  await Promise.all([...Array.from({ length: 100 }, (_, i) => seeds.store.put({ ...row, id: `expired-${i}`, expiresAt: now - 1 })), seeds.done]);
  await old.put("localKeys", { id: "identity", data: "encrypted" });
  await old.put("outgoingQueue", { id: "draft", userId: "user", deviceId: "old-device", conversationId: "chat", steps: [{ path: "/api/messages/send" }] });
  old.close();
  const database = await import("../../db/index.js");
  const db = await database.getAppDB();
  try {
    expect(db.objectStoreNames.contains("outgoingQueue")).toBe(false);
    expect(await database.getKey("identity")).toMatchObject({ data: "encrypted" });
    expect(await database.getOutgoing("draft", "user")).toMatchObject({ deviceId: "old-device", steps: [{ path: "/api/messages/send" }] });
    expect(await database.getMessageById("draft", "user")).toMatchObject({ status: "sending" });
    expect(await db.count("legacyMessages")).toBe(102);
    const tx = vi.spyOn(db, "transaction");
    await database.cleanupExpiredMessages(now);
    expect(await db.count("legacyMessages")).toBe(2);
    const writes = tx.mock.calls.filter(([, mode]) => mode === "readwrite").map(([stores]) => stores);
    expect(writes).toEqual([["legacyMessages", "accountState"], ["displayMessages", "accountFiles", "accountState"]]);
    await database.cleanupExpiredMessages(now);
    expect(await db.getAllKeys("legacyMessages")).toEqual(["future-fallback"]);
    tx.mockRestore();
  } finally { db.close(); }
});

function createCanonicalStores(db: IDBPDatabase) {
  for (const name of ["legacyMessages", "receiveSessions", "deviceKeys", "accountConversations", "receiveSenderKeys", "accountFiles", "receivePendingCalls", "receiveSenderKeyRecipients", "accountState"]) {
    db.createObjectStore(name, { keyPath: "id" });
  }
  const display = db.createObjectStore("displayMessages", { keyPath: ["ownerId", "id"] });
  display.createIndex("byId", "id");
  display.createIndex("byConversation", ["conversationId", "timestamp"]);
  display.createIndex("byAccountConversation", ["ownerId", "conversationId", "timestamp", "id"]);
  display.createIndex("byTimestamp", "timestamp");
}

it("upgrades the canonical v6 layout in place and removes a legacy row retained under a finalized hide", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
  const old = await openDB("e2ee-chat", 6, { upgrade: createCanonicalStores });
  const row = { id: "retained", conversationId: "chat", senderId: "peer", type: "text", content: "private", status: "delivered",
    timestamp: Date.now(), expiresAt: Date.now() + 60_000 };
  await old.put("legacyMessages", row);
  await old.put("accountState", { id: "hidden-message:retained", messageId: "retained" });
  await old.put("displayMessages", { ...row, id: "visible", ownerId: "user" });
  old.close();
  const database = await import("../../db/index.js");
  const db = await database.getAppDB();
  try {
    expect(await db.get("legacyMessages", row.id)).toBeUndefined();
    expect(await database.isMessageHidden(row.id, "user")).toBe(true);
    expect(await database.getMessageById("visible", "user")).toMatchObject({ content: "private" });
  } finally { db.close(); }
});

it("adds key-only revision checks to v7 without rewriting queued uploads", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
  const old = await openDB("e2ee-chat", 7, { upgrade(db, _, __, tx) {
    createCanonicalStores(db);
    const quarantine = tx.objectStore("legacyMessages");
    quarantine.createIndex("byExpiry", "quarantineExpiresAt");
    quarantine.createIndex("byConversation", ["conversationId", "timestamp"]);
  } });
  const id = 'outgoing-account:["user","file"]';
  const draft = { userId: "user", deviceId: "device", conversationId: "chat", revision: "queued-revision", status: "failed", retryable: false,
    upload: { bytes: new Uint8Array([4, 5, 6]) }, steps: [] };
  const entry = { id, outgoing: { ...draft, id: "file" } };
  await old.put("accountState", entry);
  const standalone = 'outgoing-account:["user","standalone"]';
  await old.put("accountState", { id: standalone, outgoing: { ...draft, id: "standalone" } });
  const ambiguous = 'outgoing-account:["user","ambiguous"]';
  await old.put("accountState", { id: ambiguous, outgoing: { ...draft, id: "ambiguous", steps: [{ path: "/api/messages/send" }] } });
  const database = await import("../../db/index.js");
  const opening = database.getAppDB();
  await vi.waitFor(() => expect(database.isDatabaseUpgradeBlocked()).toBe(true));
  old.close();
  const db = await opening;
  try {
    expect(db.version).toBe(8);
    expect(await db.getKeyFromIndex("accountState", "byOutgoingRevision", [id, "queued-revision"])).toBe(id);
    const persisted = await db.get("accountState", id);
    expect(persisted.outgoing.revision).toBe(entry.outgoing.revision);
    expect(Array.from(persisted.outgoing.upload.bytes)).toEqual([4, 5, 6]);
    expect(await db.get("accountState", `outgoing-state:${id}`)).toBeUndefined();
    expect(await database.hideLocalMessages(undefined, ["standalone"], "user", "device", () => true))
      .toMatchObject({ discarded: true, hidden: ["standalone"], alreadySending: [] });
    expect(await database.hideLocalMessages("chat", ["file", "ambiguous"], "user", "device", () => true))
      .toMatchObject({ discarded: true, hidden: ["file"], alreadySending: ["ambiguous"] });
    expect(await db.get("accountState", id)).toBeUndefined();
    expect(await db.get("accountState", standalone)).toBeUndefined();
    expect(await db.get("accountState", ambiguous)).toBeDefined();
  } finally { db.close(); }
});

it("rejects legacy-named v7 stores before changing the version, schema, or data", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
  const stores = ["localKeys", "messages", "syncState"];
  const old = await openDB("e2ee-chat", 7, { upgrade(db) {
    for (const name of stores) db.createObjectStore(name, { keyPath: "id" });
  } });
  const saved = { id: "original", content: "cached plaintext" };
  await old.put("messages", saved);
  old.close();
  const database = await import("../../db/index.js");
  await expect(database.getAppDB()).rejects.toThrow("Unsupported pre-release local database layout");
  const unchanged = await openDB("e2ee-chat", 7);
  try {
    expect(Array.from(unchanged.objectStoreNames)).toEqual(stores);
    expect(await unchanged.get("messages", saved.id)).toEqual(saved);
  } finally { unchanged.close(); }
});

it("preserves a sparse v6 preview's sync cursor and quarantines its unscoped queue entry", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
  const preview = await openDB("e2ee-chat", 6, { upgrade(db) {
    db.createObjectStore("syncState", { keyPath: "id" });
    db.createObjectStore("outgoingQueue", { keyPath: "id" });
  } });
  await preview.put("syncState", { id: "message-sync:user:device", value: 42 });
  await preview.put("outgoingQueue", { id: "queued", queuedAt: 42 });
  preview.close();
  const database = await import("../../db/index.js");
  const db = await database.getAppDB();
  try {
    expect(await database.getSyncState("message-sync:user:device")).toMatchObject({ value: 42 });
    expect(await db.get("accountState", "outgoing:queued")).toMatchObject({ outgoing: { id: "queued", queuedAt: 42 } });
    expect(await database.getAllOutgoing()).toEqual([]);
  } finally { db.close(); }
});

it.each([6, 7, 8, 9])("fails closed on an unknown v%s layout without replacing it", async (version) => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
  const newer = await openDB("e2ee-chat", version, { upgrade(db) { db.createObjectStore("unrelated"); } });
  newer.close();
  try {
    const db = await import("../../db/index.js");
    if (version > 8) await expect(db.getAppDB()).rejects.toMatchObject({ name: "VersionError" });
    else await expect(db.getAppDB()).rejects.toThrow("Unsupported pre-release local database layout");
    const original = await openDB("e2ee-chat");
    expect(original.version).toBe(version);
    expect(Array.from(original.objectStoreNames)).toEqual(["unrelated"]);
    original.close();
  } finally { newer.close(); }
});

it("upgrades main's v5 device vault, wrapped edit keys and deferred edits into v8", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
  const { encryptData } = await import("../../lib/local-key-encryption.js");
  const { generateVault, vaultRecord, wrapUnlockSlot } = await import("../../lib/device-key-vault.js");
  const keys = await import("../../lib/key-manager.js");
  const database = await import("../../db/index.js");
  const { verifyLegacyHistoryOwnership } = await import("../../db/history-transfer.js");
  const old = await openDB("e2ee-chat", 5, { upgrade(db, _old, _new, transaction) {
    for (const name of ["messages", "syncState", "localKeys", "sessions", "conversations", "senderKeys", "fileCache", "pendingCalls", "senderKeyRecipients"]) {
      db.createObjectStore(name, { keyPath: "id" });
    }
    const messages = transaction.objectStore("messages");
    messages.createIndex("byConversation", ["conversationId", "timestamp"]);
    messages.createIndex("byTimestamp", "timestamp");
  } });
  const { vault, encKey: encryptionKey } = await generateVault();
  const editKey = generateAESKey(), signer = await generateIdentityKeyPair();
  const signingKey = toBase64Url(signer.publicEd25519);
  const now = Date.now(), expiresAt = now + 60_000;
  const password = "v5 device password";
  vault.slots = [
    await wrapUnlockSlot(encryptionKey, { method: "password", password }),
    await wrapUnlockSlot(encryptionKey, { method: "passkey", credentialId: "AQID", rpId: "localhost",
      salt: new Uint8Array(32).fill(3), output: new Uint8Array(32).fill(5) }),
    { method: "native", keyId: "native-vault-key" },
  ];
  const serialize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const vaultRecords = [
    vaultRecord(vault),
    { id: "identity", type: "identity", data: JSON.stringify(await encryptData(encryptionKey, serialize(serializeIdentityKeyPair(signer)))) },
    { id: "signedPreKey", type: "signedPreKey", data: JSON.stringify(await encryptData(encryptionKey, serialize({
      id: 1, publicKey: "AQID", privateKey: "BAUG", signature: "BwgJ",
    }))) },
    { id: "otpKeys", type: "otpKeys", data: JSON.stringify(await encryptData(encryptionKey, serialize([]))) },
    { id: "otpNextId", type: "otpNextId", data: "2" },
    { id: "owner", type: "owner", data: JSON.stringify({ userId: "alice", username: "alice", deviceId: "phone" }) },
  ];
  for (const record of vaultRecords) await old.put("localKeys", record);
  const setup = { id: "setup:pending", setupId: "setup", stage: "complete", bundleHash: "digest", deviceId: "phone", createdAt: now };
  const unlockAttempts = { id: "unlock:password:phone", failures: 5, until: now + 30_000 };
  await old.put("syncState", setup);
  await old.put("syncState", unlockAttempts);
  await old.put("syncState", { id: "native-unlock:remove:previous-key" });
  await old.put("syncState", { id: "message-edit-key-wrap-v1" });
  const first = { messageId: "mine", conversationId: "chat", senderId: "alice", senderDeviceId: "phone" };
  const second = { messageId: "received", conversationId: "chat", senderId: "bob", senderDeviceId: "other-phone" };
  const envelope = async (scope: typeof first, text: string) => ({
    messageId: scope.messageId, conversationId: scope.conversationId, editSeq: 1,
    ...await encryptMessageEdit(editKey, signer.privateEd25519, scope, 1, text),
  });
  const queued = await envelope(first, "pending edit");
  const committed = await envelope(second, "saved revision");
  for (const [scope, wireId] of [[first, first.messageId], [second, "received:phone"]] as const) {
    const id = "message-edit-state:" + wireId;
    // The v5 record key is part of the ciphertext's authenticated metadata.
    const aad = new TextEncoder().encode(JSON.stringify([id, scope.conversationId, scope.senderId, scope.senderDeviceId, signingKey]));
    await old.put("syncState", { id, conversationId: scope.conversationId, senderId: scope.senderId,
      wrappedKey: await encryptData(encryptionKey, editKey, aad), editSigningKey: signingKey,
      editSenderDeviceId: scope.senderDeviceId, editKeyAccepted: true, editSequence: scope === first ? 0 : 1,
      ...(scope === first ? { pendingId: "draft" } : { editedAt: now, envelope: committed }) });
    await old.put("messages", { id: wireId, conversationId: scope.conversationId, senderId: scope.senderId,
      type: "text", content: "stale original", timestamp: now - 1, expiresAt, status: "sent",
      ...(scope === first ? { pendingEdit: { id: "draft", content: "pending edit" } } : {}) });
  }
  await old.put("syncState", { id: "outgoing-edit:draft", outgoing: {
    id: "draft", revision: "v5-revision", userId: "alice", deviceId: "phone", editTargetId: "mine", conversationId: "chat",
    conversationType: "direct", queuedAt: now, steps: [{ path: "/api/messages/edit", body: queued }], retryable: true,
  } });
  await old.put("syncState", { id: "outgoing-edit-target-index-v1" });
  await old.put("syncState", { id: "outgoing-edit-target:\"mine\":draft", edit: { id: "draft", userId: "alice", conversationId: "chat" } });
  const locked = { ...second, ...committed, mutationSeq: 4, editedAt: now, expiresAt };
  await old.put("syncState", { id: "locked-message-edit:alice:phone:received:0000000000000001", edit: locked });
  await old.put("syncState", { id: "message-mutations-edits:alice:phone", value: 4 });
  const sentEdit = await old.get("syncState", "message-edit-state:mine");
  const receivedEdit = await old.get("syncState", "message-edit-state:received:phone");
  old.close();

  const next = await database.getAppDB();
  try {
    expect(next.version).toBe(8);
    expect(await next.getAll("deviceKeys")).toEqual(vaultRecords.sort((a, b) => a.id < b.id ? -1 : 1));
    expect(await database.readPendingSetupRecord()).toEqual(setup);
    expect(await next.get("accountState", unlockAttempts.id)).toEqual(unlockAttempts);
    expect(await database.pendingResetNativeKeyIds()).toEqual(["previous-key"]);
    const scopedId = 'message-edit-state:["alice","mine"]';
    expect(await next.get("accountState", scopedId)).toEqual({ ...sentEdit, id: scopedId, aadId: sentEdit.id });
    expect(await next.get("accountState", receivedEdit.id)).toEqual(receivedEdit);
    expect((await database.getMessageById("mine", "alice", undefined, true))?.editKey).toBeUndefined();
    await keys.loadKeys(password);
    expect(serializeIdentityKeyPair(keys.getIdentityKeyPair())).toEqual(serializeIdentityKeyPair(signer));
    expect(await database.getKey("dbKey")).toEqual(vaultRecord(vault));
    expect(await database.getOutgoingEditStatus("draft", "alice")).toMatchObject({ hasEnvelope: true, revision: "v5-revision" });
    expect(await database.getAllOutgoingMessages("alice")).toEqual([]);
    expect(await database.getOutgoingOperation("draft", "bob")).toBeUndefined();
    expect(await database.getSyncState("message-mutations-edits:alice:phone")).toMatchObject({ value: 4 });
    expect(await Promise.all((await database.lockedEditIds("alice:phone")).map(database.readLockedEdit))).toEqual([locked]);
    expect(await database.getMessageById("received", "alice")).toBeUndefined();
    expect(await database.getMessageById("mine", "alice", undefined, true)).toMatchObject({
      editKey: toBase64Url(editKey), content: "stale original", pendingEdit: { id: "draft", content: "pending edit" },
    });
    expect(JSON.stringify(await next.getAll("displayMessages"))).not.toContain("pending edit");

    await verifyLegacyHistoryOwnership("alice", [{ id: "chat", type: "direct" }],
      async (messages) => messages.map(({ id }) => id), () => true);
    expect(await database.getMessageById("received", "alice", undefined, true)).toMatchObject({
      id: "received", wireId: "received:phone", editKey: toBase64Url(editKey), content: "saved revision", editedAt: now, editSequence: 1,
    });
    expect(await database.getMessageById("received", "bob", undefined, true)).toBeUndefined();

    const operation = await database.getOutgoingOperation("draft", "alice");
    expect(await database.finishQueuedEdit(operation!, () => true, { editSeq: 1, mutationSeq: 5, editedAt: now })).toBe(true);
    expect(await database.getMessageById("mine", "alice")).toMatchObject({ content: "pending edit", pendingEdit: null, editSequence: 1 });
    expect(await database.getOutgoingOperation("draft", "alice")).toBeUndefined();
  } finally {
    keys.lockLocalCryptoState();
    next.close();
  }
});
