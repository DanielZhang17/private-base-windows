// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { encryptMessageEdit, generateAESKey, generateIdentityKeyPair, toBase64Url } from "@e2ee-chat/crypto";
import type { ConversationWithMembers, HistoryTransferEntry } from "@e2ee-chat/shared";
import { estimateHistoryStorage, exportHistoryTransfer, getHistoryTransferMarkers, historyTransferCatalog, historyArchiveIsCurrent, importHistoryTransferItem, importedDeletionPage, verifyLegacyHistoryOwnership } from "./history-transfer.js";
import { claimHistoryTransferLease, completeHistoryTransferChat, loadHistoryTransferCheckpoint, saveHistoryTransferCheckpoint } from "./history-transfer-progress.js";
import { setLocalEncryptionKey } from "../lib/local-key-encryption.js";
import { sealCachedAttachment, openCachedAttachment } from "../lib/key-manager.js";
import { buildTransferArchive } from "../features/transfer/archive.js";
import { mergeTransferredStickers, readStickerState, stickerStateKey, updateStickerState } from "../features/stickers/storage.js";
import { publishLocalMessageChange } from "../lib/local-message-changes.js";
import {
  applyReceivedEdit, cacheAttachmentForMessage, getOriginalForEdit, commitReceivedMessage, getAppDB, getCachedFile, getMessageById, getMessages, historyConversationKey,
  getMessageDeletion, getReceiveReceipt, getSession, hasReceivedMessage, HISTORY_REMOVAL_GENERATION_KEY, messageDeletionKey, rememberMessageDeletion, removeLocalMessageContent, saveMessage, messageHideKey, beginMessageHide, finishMessageHide, writeCachedFile,
} from "./index.js";

vi.mock("../lib/local-message-changes.js", () => ({ publishLocalMessageChange: vi.fn() }));
vi.mock("../lib/key-manager.js", async () => {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return {
    sealCachedAttachment: async (_owner: string, _id: string, wire: Blob) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      return { iv, ciphertext: new Blob([await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await wire.arrayBuffer())]) };
    },
    openCachedAttachment: async (_owner: string, _id: string, sealed: { iv: Uint8Array<ArrayBuffer>; ciphertext: Blob }) =>
      new Blob([await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, key, await sealed.ciphertext.arrayBuffer())]),
  };
});

const now = Date.now();
const member = { conversationId: "chat", userId: "alice", role: "admin", joinedAt: now,
  acceptedAt: now, user: { username: "alice", displayName: "Alice", avatarUrl: null } } as const;
const conversation: ConversationWithMembers = {
  id: "chat", type: "direct", name: null, avatarUrl: null, invitePolicy: "any_member", createdBy: "alice",
  createdAt: now, updatedAt: now, members: [member],
};
const message = {
  ownerId: "alice",
  id: "message", conversationId: "chat", senderId: "bob", type: "text", content: "locally decrypted",
  timestamp: now - 5000, expiresAt: now + 60_000, status: "delivered",
} as const;
const file = { ...message, id: "attachment", type: "file", content: JSON.stringify({
  fileId: "file", fileKey: "A".repeat(43), iv: "A".repeat(16), fileName: "memo.txt", mimeType: "text/plain",
}) } as const;
const entry = (row: Extract<HistoryTransferEntry, { kind: "message" }>["message"]) => ({ kind: "message" as const, message: row });

beforeEach(async () => {
  vi.clearAllMocks();
  const db = await getAppDB();
  for (const store of Array.from(db.objectStoreNames)) await db.clear(store);
});

it("fences stale imports after lease takeover and counts only committed additions and hidden chats", async () => {
  const db = await getAppDB();
  const scope = { userId: "alice", deviceId: "phone", role: "receiver", peerDeviceId: "laptop" } as const;
  const first = (await claimHistoryTransferLease(scope, scope.peerDeviceId, now))!;
  const lease = (await claimHistoryTransferLease(scope, scope.peerDeviceId, now + 30_001))!;
  const checkpoint = { chats: ["chat", "hidden"].map((id) => ({ id, bytes: 500, messages: 3, attachmentBytes: 2 })),
    completedChatIds: [], bytes: 0, copyDownloadedFiles: true };
  await saveHistoryTransferCheckpoint(scope, scope.peerDeviceId, checkpoint, () => true, now + 30_001, lease, true);
  const attachment = { id: "file", fileName: "memo.txt", mimeType: "text/plain", expiresAt: now + 60_000, size: 2 };
  const item = { entry: { ...entry(file), attachment }, blob: new Blob(["hi"]) };
  const metadata = { entry: { kind: "conversation", conversation } } as const;
  for (const rejected of [metadata, item, { entry: { kind: "deletion", id: message.id, conversationId: "chat", senderId: "bob", deletedByUserId: "bob", deletedAt: now } as const }]) {
    await expect(importHistoryTransferItem("alice", rejected, () => true, now, undefined, { ...scope, lease: first })).rejects.toThrow("another tab");
  }
  expect(await db.getAll("displayMessages")).toEqual([]);
  expect(await getCachedFile("file", "alice")).toBeUndefined();
  expect(await getMessageDeletion(message.id, "alice")).toBeUndefined();
  const current = { ...scope, lease };
  await saveMessage(message);
  await importHistoryTransferItem("alice", metadata, undefined, now, undefined, current);
  await importHistoryTransferItem("alice", { entry: entry(message) }, undefined, now, undefined, current);
  await importHistoryTransferItem("alice", item, undefined, now, undefined, current);
  await importHistoryTransferItem("alice", item, undefined, now, undefined, current);
  await db.put("accountConversations", { id: historyConversationKey("alice", "hidden"), hidden: true });
  await importHistoryTransferItem("alice", { entry: entry({ ...message, id: "unseen", conversationId: "hidden" }) }, undefined, now, undefined, current);
  expect(await loadHistoryTransferCheckpoint(scope, scope.peerDeviceId)).toEqual(checkpoint);
  await completeHistoryTransferChat(current, "chat", 500, () => true);
  expect((await completeHistoryTransferChat(current, "hidden", 1000, () => true)).chats).toMatchObject([
    { id: "chat", additions: { messages: 1, attachmentFiles: 1, attachmentBytes: 2 } },
    { id: "hidden", additions: { messages: 0, skipped: true } },
  ]);
  expect(await estimateHistoryStorage("alice", [
    { kind: "message", id: message.id, conversationId: "chat", senderId: "bob", direct: true, bytes: 100 },
    { kind: "message", id: file.id, conversationId: "chat", senderId: "bob", direct: true, bytes: 100, attachment: { id: "file", bytes: 2 } },
    { kind: "message", id: "unseen", conversationId: "hidden", senderId: "bob", direct: true, bytes: 900 },
    { kind: "message", id: "new", conversationId: "chat", senderId: "bob", direct: true, bytes: 100 },
  ])).toBe(100);
});

it("counts persisted membership and checkpoint state for metadata-only archives, independently of duplicate tombstones", async () => {
  const db = await getAppDB();
  const metadata = { entry: { kind: "conversation", conversation } } as const;
  const tombstone = { entry: { kind: "deletion", id: "already-deleted", conversationId: "chat", senderId: "bob", deletedAt: now, deletedByUserId: "bob" } } as const;
  const archive = buildTransferArchive([metadata, tombstone], "alice");
  const [chat] = archive.spaceItems;
  expect(chat.kind).toBe("conversation");
  if (chat.kind !== "conversation") throw new Error("Missing conversation probe");
  expect(archive.spaceItems).toHaveLength(1);
  expect(chat.checkpointBytes).toBeGreaterThan(0);
  await importHistoryTransferItem("alice", tombstone);
  expect(await estimateHistoryStorage("alice", archive.spaceItems)).toBe(chat.bytes + chat.checkpointBytes);
  await importHistoryTransferItem("alice", metadata);
  expect(await estimateHistoryStorage("alice", archive.spaceItems)).toBe(chat.checkpointBytes);
  expect(await estimateHistoryStorage("alice", [{ ...chat, updatedAt: chat.updatedAt + 1 }])).toBe(chat.bytes + chat.checkpointBytes);
  const key = historyConversationKey("alice", "chat");
  await db.put("accountConversations", { ...await db.get("accountConversations", key), hidden: true });
  expect(await estimateHistoryStorage("alice", archive.spaceItems)).toBe(chat.checkpointBytes);
});

it("bounds optional preview caching and keeps free quota for chat writes", async () => {
  const db = await getAppDB();
  await saveMessage(file);
  const expiresAt = now + 60_000;
  const small = { iv: new Uint8Array(12), ciphertext: new Blob(["new"]) };
  const record = { id: "file", ownerId: "alice", sealed: small, cachedAt: now, expiresAt };
  vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: 65, usage: 60 }) } });
  try {
    await cacheAttachmentForMessage(record, file.id, () => true);
    expect(await getCachedFile("file", "alice")).toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
  const ciphertext = new Blob([new Uint8Array(32 * 1024 * 1024)]);
  const tx = db.transaction("accountFiles", "readwrite");
  await writeCachedFile(tx.store, { ...record, id: "old", cachedAt: now - 10, sealed: { ...small, ciphertext } });
  await writeCachedFile(tx.store, { ...record, id: "other", ownerId: "carol", sealed: { ...small, ciphertext } });
  await tx.done;
  await cacheAttachmentForMessage(record, file.id, () => true);
  expect(await getCachedFile("old", "alice")).toBeUndefined();
  expect(await getCachedFile("other", "carol")).toBeDefined();
  expect(await getCachedFile("file", "alice")).toBeDefined();
});

it("keeps explicit transfer copies out of the preview budget and protects an already cached explicit copy", async () => {
  const db = await getAppDB();
  const attachment = { id: "file", fileName: "memo.txt", mimeType: "text/plain", expiresAt: now + 60_000, size: 2 };
  await importHistoryTransferItem("alice", { entry: { ...entry(file), attachment }, blob: new Blob(["hi"]) }, undefined, now);
  const copied = (await getCachedFile("file", "alice"))!;
  expect(copied.explicitTransfer).toBe(true);
  const tx = db.transaction("accountFiles", "readwrite");
  await writeCachedFile(tx.store, { ...copied, id: "large-copy", sealed: {
    iv: new Uint8Array(12), ciphertext: new Blob([new Uint8Array(64 * 1024 * 1024)]),
  } });
  await tx.done;
  const preview = { ...copied, explicitTransfer: undefined, cachedAt: now + 20 };
  await cacheAttachmentForMessage(preview, file.id, () => true);
  expect(await getCachedFile("file", "alice")).toMatchObject({ explicitTransfer: true, cachedAt: now });
  const other = { ...file, id: "preview-message", content: file.content.replace('"fileId":"file"', '"fileId":"preview"') };
  await saveMessage(other);
  const fileKeys = (await db.getAllKeys("accountFiles")).filter((key) => typeof key === "string" && key.includes("file"));
  const reads = vi.spyOn(IDBObjectStore.prototype, "getAll");
  try {
    await cacheAttachmentForMessage({ ...preview, id: "preview" }, other.id, () => true);
    const ranges = reads.mock.calls.filter((_, index) => (reads.mock.contexts[index] as IDBObjectStore).name === "accountFiles")
      .map(([range]) => range as IDBKeyRange);
    expect(ranges).toHaveLength(2);
    expect(fileKeys).toHaveLength(2);
    expect(ranges.every((range) => fileKeys.every((key) => !range.includes(key)))).toBe(true);
  } finally { reads.mockRestore(); }
  expect(await getCachedFile("preview", "alice")).toBeDefined();
  expect(await getCachedFile("large-copy", "alice")).toMatchObject({ explicitTransfer: true });
});

it("repairs only the damaged cached revision and preserves explicit copies even above the preview budget", async () => {
  await saveMessage(file);
  const db = await getAppDB();
  const original = { id: "file", ownerId: "alice", cachedAt: now, expiresAt: now + 60_000,
    sealed: { iv: new Uint8Array(12), ciphertext: new Blob(["damaged"]) }, explicitTransfer: true } as const;
  const tx = db.transaction("accountFiles", "readwrite");
  await writeCachedFile(tx.store, original);
  await tx.done;
  const replacement = { ...original, explicitTransfer: undefined, cachedAt: now + 1,
    sealed: { iv: new Uint8Array(12).fill(1), ciphertext: new Blob([new Uint8Array(64 * 1024 * 1024 + 1)]) } };
  const failedCopy = { cachedAt: original.cachedAt, iv: original.sealed.iv };
  const reserve = 32 * 1024 * 1024;
  const growth = replacement.sealed.ciphertext.size - original.sealed.ciphertext.size;
  let free = growth + reserve - 1;
  vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: free + 100, usage: 100 }) } });
  try {
    await cacheAttachmentForMessage(replacement, file.id, () => true, failedCopy);
    expect(await getCachedFile("file", "alice")).toMatchObject({ explicitTransfer: true, cachedAt: original.cachedAt });
    free++;
    await cacheAttachmentForMessage(replacement, file.id, () => true, failedCopy);
    expect(await getCachedFile("file", "alice")).toMatchObject({ explicitTransfer: true, cachedAt: replacement.cachedAt });
    await cacheAttachmentForMessage({ ...replacement, cachedAt: now + 2 }, file.id, () => true, failedCopy);
    expect(await getCachedFile("file", "alice")).toMatchObject({ explicitTransfer: true, cachedAt: replacement.cachedAt });
    free = 0;
    await cacheAttachmentForMessage({ ...replacement, cachedAt: now + 3 }, file.id, () => true,
      { cachedAt: replacement.cachedAt, iv: replacement.sealed.iv });
    expect(await getCachedFile("file", "alice")).toMatchObject({ explicitTransfer: true, cachedAt: now + 3 });
  } finally { vi.unstubAllGlobals(); }
});

it("releases the selected export after each page and rejects an archive removed between pages", async () => {
  const db = await getAppDB();
  const seed = db.transaction("displayMessages", "readwrite");
  await Promise.all([...Array.from({ length: 201 }, (_, index) => seed.store.put({ ...message, id: `row-${String(index).padStart(3, "0")}` })), seed.done]);
  const original = db.transaction.bind(db);
  let pages = 0;
  let removal: Promise<unknown> | undefined;
  const transactions = vi.spyOn(db, "transaction").mockImplementation((...args) => {
    const tx = original(...args);
    if (Array.isArray(args[0]) && args[0].includes("displayMessages") && args[1] === "readonly" && ++pages === 1) {
      removal = tx.done.then(() => removeLocalMessageContent("row-000", undefined, () => true, "alice"));
    }
    return tx;
  });
  try {
    await expect(exportHistoryTransfer("alice", [conversation], undefined, now)).rejects.toThrow("History changed during export");
    await removal;
    expect(pages).toBe(3);
  } finally { transactions.mockRestore(); }
});

it("exports selected decrypted history, tombstones and optional files without any protocol keys", async () => {
  const db = await getAppDB();
  const blob = new Blob(["encrypted uploaded attachment"]);
  await Promise.all([
    db.put("deviceKeys", { id: "identity", data: "sensitive-identity-prekey" }),
    db.put("receiveSessions", { id: "ratchet", state: "sensitive-ratchet" }),
    db.put("receiveSenderKeys", { id: "group-key", chainKey: "sensitive-sender-key" }),
    db.put("receivePendingCalls", { id: "call", callKey: "sensitive-call" }),
    db.put("accountState", { id: "pending-receive:wire", frame: { header: "sensitive-pending" } }),
    db.put("accountState", { id: 'outgoing-account:["alice","queued"]', outgoing: { id: "queued", userId: "alice", plaintext: "sensitive-outbox" } }),
    db.put("displayMessages", { ...message, id: "queued", content: "sensitive-draft" }),
    db.put("displayMessages", { ...message, id: "control", type: "sender_key_distribution", content: "sensitive-control" }),
    db.put("displayMessages", { ...message, id: "call-message", type: "system", content: "sensitive-call-message" }),
    db.put("displayMessages", { ...message, id: "hidden", content: "sensitive-hidden" }),
    db.put("displayMessages", { ...message, id: "deleted:old-phone", content: "sensitive-deleted" }),
    db.put("displayMessages", { ...message, id: "expired", expiresAt: now - 1, content: "sensitive-expired" }),
    db.put("displayMessages", { ...message, editedAt: now - 1, editedByUserId: "bob", session: "sensitive-extra", editKey: "sensitive-edit-credential" }),
    db.put("displayMessages", { ...message, id: "sticker", content: "[[sticker:genshin:genshin_hoyolab_1]]" }),
    db.put("displayMessages", { ...file, content: file.content.replace("}", ',"prekey":"sensitive-file-extra"}') }),
    db.put("accountFiles", { id: "file", ownerId: "alice", sealed: await sealCachedAttachment("alice", "file", blob), cachedAt: now, expiresAt: now + 2000 }),
    db.put("accountState", { id: messageHideKey("hidden", "alice"), ownerId: "alice" }),
    db.put("accountState", { id: "deleted-message:deleted:new-phone", ownerId: "alice", conversationId: "chat", deletedAt: now, deletedByUserId: "bob" }),
    db.put("accountState", { id: "deleted-message:marker-only", ownerId: "alice", conversationId: "chat", deletedAt: now, deletedByUserId: "bob" }),
  ]);
  const stored = { ...conversation, identityKey: "sensitive-conversation" };
  await db.put("accountConversations", stored);
  const { items } = await exportHistoryTransfer("alice", [stored], [{ conversationId: "chat", includeAttachments: true }], now);
  const serialized = JSON.stringify(items);
  expect(serialized).not.toContain("sensitive-");
  expect(items).toContainEqual(expect.objectContaining({ entry: expect.objectContaining({
    kind: "message", message: expect.objectContaining({ id: "message", editedAt: now - 1 }),
  }) }));
  expect(items).toContainEqual({ entry: { kind: "message", message: expect.objectContaining({ id: "sticker", content: "[[sticker:genshin:genshin_hoyolab_1]]" }) } });
  expect(items).toContainEqual(expect.objectContaining({ entry: expect.objectContaining({
    kind: "message", message: expect.objectContaining({ id: "deleted:old-phone", content: "", deletedAt: now }),
  }) }));
  expect(items).toContainEqual(expect.objectContaining({ entry: expect.objectContaining({ kind: "deletion", id: "marker-only" }) }));
  expect(serialized).toContain("fileKey");
  expect(items.every((item) => !item.blob)).toBe(true);
  expect(await (await items.find((item) => item.attachmentSource)?.attachmentSource?.open())?.text()).toBe("encrypted uploaded attachment");
  const { items: metadataOnly } = await exportHistoryTransfer("alice", [conversation], undefined, now);
  expect(metadataOnly.every((item) => !item.blob && !item.attachmentSource)).toBe(true);
  expect(JSON.stringify(metadataOnly)).toContain(JSON.parse(file.content).fileKey);
  expect((await exportHistoryTransfer("another-user", [conversation], undefined, now)).items).toEqual([]);
});

it("merges idempotently with local hides, deletion precedence, and live writers", async () => {
  await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation } });
  await removeLocalMessageContent("hidden:receiver", undefined, undefined, "alice");
  await rememberMessageDeletion("deleted:receiver", "chat", now - 2, "bob");
  await saveMessage({ ...file, id: "live:receiver", direct: true });
  const attachment = { id: "file", fileName: "memo.txt", mimeType: "text/plain", expiresAt: now + 2000, size: 2 };
  const blob = new Blob(["hi"]);

  for (let attempt = 0; attempt < 2; attempt++) {
    await importHistoryTransferItem("alice", { entry: entry(message) }, undefined, now + attempt);
    await importHistoryTransferItem("alice", { entry: entry({ ...message, id: "hidden:source" }) });
    await importHistoryTransferItem("alice", { entry: { ...entry({ ...file, id: "deleted:source" }), attachment }, blob });
    await importHistoryTransferItem("alice", { entry: { ...entry({ ...file, id: "live:source" }), attachment }, blob });
  }
  expect(await getMessageById("message")).toMatchObject({ importedAt: now });
  expect(await getMessageById("hidden:source")).toBeUndefined();
  expect(await getMessageById("live:source")).toMatchObject({ id: "live", content: file.content });
  expect(await getMessageById("live:receiver")).toMatchObject({ content: file.content });
  expect(await getMessageById("deleted:source")).toMatchObject({ content: "", deletedAt: now - 2 });
  const cached = await getCachedFile("file", "alice");
  expect(cached?.blob).toBeUndefined();
  expect(await (await openCachedAttachment("alice", "file", cached!.sealed!)).text()).toBe("hi");

  await importHistoryTransferItem("alice", { entry: { kind: "deletion", id: "live:source", conversationId: "chat",
    senderId: "bob", deletedByUserId: "bob", deletedAt: now } });
  expect(await getCachedFile("file", "alice")).toBeUndefined();
  expect(publishLocalMessageChange).toHaveBeenCalledWith("live", "commit", "chat");
  expect(await getMessageById("live:receiver")).toMatchObject({ content: "", deletedAt: now });
  expect((await getMessages("chat")).map((row) => row.id).sort()).toEqual(["deleted", "live", "message"]);
});

it("never exports a previous account's rows or unowned legacy content in a shared chat", async () => {
  const db = await getAppDB();
  await db.put("displayMessages", { ...message, id: "alice-row", content: "alice plaintext" });
  await db.put("legacyMessages", { ...message, ownerId: undefined, id: "legacy", content: "unverified plaintext" });
  await commitReceivedMessage("bob-row", { message: { ...message, id: "bob-row", content: "bob plaintext" },
    ownerId: "bob", expiresAt: message.expiresAt });
  const shared = { ...conversation, members: [member, { ...member, userId: "bob" }] };
  const { items, skippedLegacy } = await exportHistoryTransfer("bob", [shared], undefined, now);
  const json = JSON.stringify(items);
  expect(skippedLegacy.get("chat")).toBe(1);
  expect(json).toContain("bob plaintext");
  expect(json).not.toMatch(/alice plaintext|unverified plaintext/);
});

it("claims verified legacy rows during preparation and counts unresolved rows without sending their contents", async () => {
  const db = await getAppDB();
  const legacy = { ...message, ownerId: undefined, id: "legacy" };
  await db.put("legacyMessages", legacy);
  await db.put("legacyMessages", { ...legacy, id: "foreign", content: "unverified plaintext" });
  await db.put("legacyMessages", { ...legacy, id: "racing" });
  const verify = vi.fn(async () => {
    await db.put("legacyMessages", { ...legacy, id: "racing", content: "changed since verification started" });
    return ["legacy", "racing", "unrequested"];
  });
  await verifyLegacyHistoryOwnership("alice", [conversation], verify, () => true, now);
  const requested = verify.mock.calls.at(0) as unknown;
  expect(JSON.stringify(requested)).not.toMatch(/plaintext|locally decrypted/);
  expect(await getMessageById("legacy")).toMatchObject({ ownerId: "alice" });
  expect((await getMessageById("racing"))?.ownerId).toBeUndefined();
  const { items, skippedLegacy } = await exportHistoryTransfer("alice", [conversation], undefined, now);
  expect(items.some(({ entry }) => entry.kind === "message" && entry.message.id === "legacy")).toBe(true);
  expect(JSON.stringify(items)).not.toMatch(/unverified plaintext|changed since verification started/);
  expect(skippedLegacy.get("chat")).toBe(2);
});

it("checks family hides and owned siblings inside the legacy claim transaction", async () => {
  const db = await getAppDB();
  for (const id of ["hide:legacy", "shadow:legacy"]) await db.put("legacyMessages", { ...message, id, ownerId: undefined });
  await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation } });
  await verifyLegacyHistoryOwnership("alice", [conversation], async (batch) => {
    await db.put("accountState", { id: messageHideKey("hide:imported", "alice"), ownerId: "alice" });
    await saveMessage({ ...message, id: "shadow:imported", importedAt: now, direct: true });
    return batch.map(({ id }) => id);
  }, () => true, now);
  expect((await db.get("legacyMessages", "hide:legacy"))?.ownerId).toBeUndefined();
  expect((await db.get("legacyMessages", "shadow:legacy"))?.ownerId).toBeUndefined();
  const { items } = await exportHistoryTransfer("alice", [conversation], undefined, now);
  expect(items.flatMap(({ entry }) => entry.kind === "message" ? [entry.message.id] : [])).toEqual(["shadow:imported"]);
});

it("redacts an owned file against an ownerless tombstone on either wire alias and keeps the export metadata scoped", async () => {
  const db = await getAppDB();
  const row = { ...file, id: "copy:receiver", transferSourceId: "copy:source" };
  await db.put("displayMessages", row);
  await db.put("accountState", { id: messageDeletionKey("copy:original"), conversationId: "chat", senderId: "bob", deletedByUserId: "bob", deletedAt: now });
  const { items } = await exportHistoryTransfer("alice", [conversation], [{ conversationId: "chat", includeAttachments: true }], now);
  expect(items).toEqual([
    { entry: { kind: "conversation", conversation } },
    { entry: { kind: "message", message: expect.objectContaining({ id: "copy:source", content: "", deletedAt: now }) } },
  ]);
});

it("never copies hidden, deleted, or expired content across generated account and fanout combinations", async () => {
  const db = await getAppDB();
  const { openDB } = await import("idb");
  const otherTab = await openDB(db.name, db.version);
  const owner = "alice";
  const seed = 0x7a951e2c;
  let randomState = seed;
  function pick(limit: number): number {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) % limit;
  }
  const chats: ConversationWithMembers[] = [conversation, { ...conversation, id: "group", type: "group",
    members: [{ ...member, conversationId: "group" }] }];
  const trials = Array.from({ length: 144 }, (_, index) => {
    const chat = chats[pick(chats.length)];
    const root = `trial-${index}`;
    const id = `${root}:display`;
    const source = pick(2) && chat.type === "direct" ? `${root}:source` : id;
    const barrierKind = pick(4); // none, hide, deletion, or both
    const barrierOwner = [undefined, owner, "carol"][pick(3)];
    const barrierId = [id, source, `${root}:sibling`][pick(3)];
    const storedOwner = [undefined, owner, "carol"][pick(3)];
    const expired = pick(5) === 0;
    const expiredAttachment = pick(4) === 0;
    const inlineSibling = chat.type === "direct" && pick(5) === 0;
    const foreignIdentity = pick(6) === 0;
    const markerApplies = barrierOwner !== "carol" && (barrierId === id || barrierId === source || chat.type === "direct");
    const hidden = markerApplies && !!(barrierKind & 1);
    const deleted = inlineSibling || (markerApplies && !!(barrierKind & 2) && !foreignIdentity);
    const fileId = `file-${index}`;
    const content = JSON.stringify({ ...JSON.parse(file.content), fileId });
    const row = { ...file, id, ownerId: storedOwner, content, conversationId: chat.id,
      expiresAt: expired ? now : now + 60_000, ...(storedOwner === owner && source !== id ? { transferSourceId: source } : {}) };
    return { chat, id, root, source, row, barrierKind, barrierOwner, barrierId, foreignIdentity, hidden, deleted, expired, expiredAttachment, inlineSibling, fileId };
  });
  async function seedBarriers(trial: typeof trials[number], wireAliasExists: boolean, receiving = false) {
    const { barrierKind, barrierId, barrierOwner, row, chat, inlineSibling, foreignIdentity } = trial;
    // An unclaimed display row knows only its own wire ID until an import supplies the alias.
    const id = receiving && barrierId === trial.id ? trial.source
      : !wireAliasExists && barrierId === trial.source ? trial.id : barrierId;
    if (barrierKind & 1) await (barrierOwner ? otherTab : db).put("accountState", { id: messageHideKey(id, barrierOwner), ownerId: barrierOwner,
      ...(barrierOwner && trial.root.charCodeAt(trial.root.length - 1) % 2 ? { undoToken: trial.root, undoDeadline: now + 5_000 } : {}) });
    if (barrierKind & 2) await db.put("accountState", { id: messageDeletionKey(id, barrierOwner), ownerId: barrierOwner,
      conversationId: chat.id, senderId: foreignIdentity ? "other-sender" : row.senderId, deletedByUserId: row.senderId, deletedAt: now - 1 });
    if (inlineSibling) await db.put("displayMessages", { ...row, id: trial.root, wireId: `${trial.root}:inline`, direct: true, ownerId: owner,
      transferSourceId: undefined, content: "", deletedAt: now - 1 });
  }
  const cached = new Blob(["offline"]);
  try {
  for (const chat of chats) await importHistoryTransferItem(owner, { entry: { kind: "conversation", conversation: chat } });
  for (const trial of trials) {
    if (trial.row.ownerId) await db.put("displayMessages", { ...trial.row, id: trial.chat.type === "direct" ? trial.root : trial.id,
      wireId: trial.id, direct: trial.chat.type === "direct" });
    else await db.put("legacyMessages", trial.row);
    await seedBarriers(trial, trial.row.ownerId === owner);
    await db.put("accountFiles", { id: trial.fileId, ownerId: owner, cachedAt: now,
      expiresAt: trial.expiredAttachment ? now : now + 10_000, sealed: await sealCachedAttachment(owner, trial.fileId, cached) });
  }
  await verifyLegacyHistoryOwnership(owner, chats, async (batch) => batch.map(({ id }) => id), () => true, now);
  const { items } = await exportHistoryTransfer(owner, chats, chats.map(({ id }) => ({ conversationId: id, includeAttachments: true })), now);
  const visible = (await Promise.all(chats.map(({ id }) => getMessages(id, trials.length * 2, owner)))).flat();
  let copied = 0;
  for (const trial of trials) {
    const details = `seed ${seed}, ${trial.root}`;
    const liveItem = items.find(({ entry }) => entry.kind === "message" && entry.message.content.includes(`"fileId":"${trial.fileId}"`));
    const attachment = items.find(({ entry }) => entry.kind === "message" && entry.attachment?.id === trial.fileId);
    const eligible = trial.row.ownerId !== "carol" && !trial.hidden && !trial.deleted && !trial.expired;
    expect(!!liveItem, details).toBe(eligible);
    expect(visible.some(({ id, content }) => id === (trial.chat.type === "direct" ? trial.root : trial.id) && !!content), details).toBe(eligible);
    expect(!!attachment?.attachmentSource, details).toBe(eligible && !trial.expiredAttachment);
    if (eligible) copied++;
  }
  expect(copied).toBeGreaterThan(0);
  expect(copied).toBeLessThan(trials.length);

  for (const name of ["displayMessages", "legacyMessages", "accountState", "accountFiles", "accountConversations"]) await db.clear(name);
  for (const chat of chats) await importHistoryTransferItem(owner, { entry: { kind: "conversation", conversation: chat } });
  for (const trial of trials) {
    await seedBarriers(trial, true, true);
    const { row, source, fileId, hidden, deleted, expired, expiredAttachment } = trial;
    const id = trial.chat.type === "direct" ? trial.root : trial.id;
    if (row.ownerId === "carol") await db.put("displayMessages", { ...row, id, direct: trial.chat.type === "direct", content: "foreign copy" });
    const incoming = { ...row, id: source, editedAt: now };
    const imported = await importHistoryTransferItem(owner, { entry: { ...entry(incoming), attachment: {
      id: fileId, fileName: "memo.txt", mimeType: "text/plain", size: cached.size, expiresAt: expiredAttachment ? now : now + 10_000,
    } }, blob: cached }, undefined, now);
    const details = `seed ${seed}, ${trial.root}`;
    const eligible = !hidden && !deleted && !expired;
    expect(!!imported?.content, details).toBe(eligible);
    expect(!!await getCachedFile(fileId, owner), details).toBe(eligible && !expiredAttachment);
    if (row.ownerId === "carol") expect(await db.get("displayMessages", ["carol", id]), details).toMatchObject({ ownerId: "carol", content: "foreign copy" });
    else if (!eligible) expect((await getMessageById(id, owner))?.content, details).toBeFalsy();
  }
  } finally { otherTab.close(); }
});

it("keeps a verified deletion owner when a placeholder is created after the marker", async () => {
  await rememberMessageDeletion("unseen", "chat", now, "bob", "bob", () => true, "alice");
  await removeLocalMessageContent("unseen", { ...message, ownerId: undefined, id: "unseen", content: "",
    deletedAt: now, deletedByUserId: "bob" }, undefined, "alice");
  expect(await getMessageDeletion("unseen", "alice")).toMatchObject({ ownerId: "alice" });
  expect(await getMessageById("unseen")).toMatchObject({ ownerId: "alice", content: "" });
  const { items } = await exportHistoryTransfer("alice", [conversation], undefined, now);
  expect(items).toContainEqual({ entry: { kind: "message", message: expect.objectContaining({ id: "unseen", content: "", deletedAt: now }) } });
});

it("promotes a verified legacy tombstone without its old file metadata", async () => {
  const db = await getAppDB();
  const row = { ...file, id: "legacy-file:wire", ownerId: undefined, deletedAt: now, deletedByUserId: "bob" };
  await db.put("legacyMessages", row);
  const verify = vi.fn(async () => [row.id]);
  await verifyLegacyHistoryOwnership("alice", [conversation], verify, () => true, now);
  expect(verify).toHaveBeenCalledWith([{ id: row.id, conversationId: "chat", senderId: "bob", timestamp: row.timestamp, type: "file", deletedAt: now }]);
  expect(await db.get("legacyMessages", row.id)).toBeUndefined();
  expect(await getMessageById(row.id, "alice")).toMatchObject({ deletedAt: now, content: "" });
  const { items } = await exportHistoryTransfer("alice", [conversation], [{ conversationId: "chat", includeAttachments: true }], now);
  expect(items).toContainEqual({ entry: { kind: "message", message: expect.objectContaining({ id: row.id, deletedAt: now, content: "" }) } });
  expect(JSON.stringify(items)).not.toContain("fileKey");
});

it("polls metadata for the account’s imports without walking unrelated message bodies", async () => {
  const db = await getAppDB();
  const tx = db.transaction("displayMessages", "readwrite");
  await Promise.all([...Array.from({ length: 520 }, (_, i) => tx.store.put({
    ...message, id: `a-${i.toString().padStart(3, "0")}`, content: "ordinary message body",
  })), tx.done]);
  await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation } });
  await importHistoryTransferItem("alice", { entry: entry({ ...message, id: "z-last" }) });
  await importHistoryTransferItem("carol", { entry: entry({ ...message, id: "z-foreign" }) });
  const transaction = vi.spyOn(db, "transaction");
  try {
    expect(await importedDeletionPage("alice", "old-raw-cursor", now)).toEqual({
      candidates: [{ displayId: "z-last", id: "z-last", conversationId: "chat", senderId: "bob" }], cursorId: undefined,
    });
    expect(await importedDeletionPage("no-imports", undefined, now)).toEqual({ candidates: [], cursorId: undefined });
    expect(transaction.mock.calls.every(([stores]) => ![stores].flat().includes("displayMessages"))).toBe(true);
  } finally { transaction.mockRestore(); }
});

it("repairs a failed placeholder, preserves receive deduplication, and records its source once", async () => {
  await commitReceivedMessage(message.id, { ownerId: "alice", expiresAt: message.expiresAt, message: { ...message, status: "failed", content: "" } });
  const source = { fromDeviceId: "source", deviceName: "Old phone", at: now };
  await importHistoryTransferItem("alice", { entry: entry(message) }, undefined, now, source);
  await importHistoryTransferItem("alice", { entry: entry(message) }, undefined, now + 1, source);
  expect(await getMessageById(message.id)).toMatchObject({
    content: message.content, status: "delivered", imported: { fromDeviceId: "source", at: now },
  });
  expect(await hasReceivedMessage(message.id, "alice")).toBe(true);
  expect(await getHistoryTransferMarkers("alice", "chat")).toEqual([{ ...source, conversationId: "chat" }]);
  expect(await getHistoryTransferMarkers("bob", "chat")).toEqual([]);
  expect(publishLocalMessageChange).toHaveBeenCalledExactlyOnceWith(message.id, "commit", "chat");
});

it("keeps imported history separate from receive receipts and commits a racing receive's ratchet", async () => {
  await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation } });
  const transferred = { ...message, id: "racing:old", editedAt: now, content: "edited history" };
  await importHistoryTransferItem("alice", { entry: entry(transferred) });
  expect(await hasReceivedMessage("racing:old")).toBe(false);
  const live = { ...message, id: "racing:new", content: "older live content" };
  const session = { id: "sender:device", state: "advanced state", updatedAt: now };
  expect(await commitReceivedMessage(live.id, { ownerId: "alice", message: live, expiresAt: live.expiresAt }, { session })).toBe(true);
  expect(await getSession(session.id)).toEqual(session);
  expect(await getReceiveReceipt(live.id, "alice")).toBeDefined();
  expect(await getMessageById(live.id, "alice")).toMatchObject({ id: "racing", content: transferred.content });
  expect(await getMessageById(transferred.id)).toMatchObject({ content: transferred.content, importedAt: expect.any(Number) });
});

it("keeps a future fanout receive behind transferred deletions and hidden variants", async () => {
  await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation } });
  await removeLocalMessageContent("hidden:source", undefined, undefined, "alice");
  await importHistoryTransferItem("alice", { entry: { kind: "deletion", id: "deleted:source", conversationId: "chat",
    senderId: "bob", deletedByUserId: "bob", deletedAt: now } });
  for (const id of ["hidden:receiver", "deleted:receiver"]) {
    const row = { ...message, id };
    const effects = { message: row, ownerId: "alice", expiresAt: row.expiresAt };
    expect(await commitReceivedMessage(id, effects)).toBe(true);
    expect(await commitReceivedMessage(id, effects)).toBe(false);
  }
  expect(await getMessageById("hidden:receiver")).toBeUndefined();
  expect(await getMessageById("deleted:receiver")).toMatchObject({ content: "", deletedAt: now });
});

it("verifies quarantined rows in each selected conversation", async () => {
  const db = await getAppDB();
  await db.put("legacyMessages", { ...message, ownerId: undefined });
  await db.put("legacyMessages", { ...message, id: "other", conversationId: "another-chat", ownerId: undefined });
  const verify = vi.fn(async (rows: { id: string }[]) => rows.map(({ id }) => id));
  await verifyLegacyHistoryOwnership("alice", [conversation, { ...conversation, id: "another-chat" }], verify, () => true, now);
  expect(verify.mock.calls.flatMap(([rows]) => rows.map(({ id }) => id))).toEqual(["message", "other"]);
  expect(await getMessageById("other", "alice")).toMatchObject({ ownerId: "alice" });
});

it("broadcasts a scoped repair when verified legacy history replaces a failed placeholder", async () => {
  const db = await getAppDB();
  await db.put("legacyMessages", { ...message, ownerId: undefined });
  await db.put("displayMessages", { ...message, content: "", status: "failed" });
  const reconcile = vi.fn(async () => {
    expect(await getMessageById(message.id, "alice")).toMatchObject({ content: message.content });
  });
  await verifyLegacyHistoryOwnership("alice", [conversation], async () => [message.id], () => true, now, reconcile);
  expect(publishLocalMessageChange).toHaveBeenCalledWith(message.id, "repair", "chat");
  expect(reconcile).toHaveBeenCalledWith(new Set([message.id]));
});

it("merges transferred sticker preferences into the leased receiving device without changing its picker settings", async () => {
  const scope = { userId: "alice", deviceId: "phone", role: "receiver" } as const;
  const key = stickerStateKey(scope.userId, scope.deviceId);
  const foreign = stickerStateKey("bob", scope.deviceId);
  const same = { id: "genshin_hoyolab_21", addedAt: 1 };
  const added = { id: "genshin_hoyolab_22", addedAt: 2 };
  const localState = { tab: "stickers", page: "different", favourites: [same], recent: [same.id] } as const;
  await updateStickerState(key, () => ({ ...localState, favourites: [same], recent: [same.id] }));
  const first = (await claimHistoryTransferLease(scope, "laptop", now))!;
  const lease = (await claimHistoryTransferLease(scope, "laptop", now + 30_001))!;
  const update = (state: Awaited<ReturnType<typeof readStickerState>>) => mergeTransferredStickers(state, {
    favourites: [{ ...same, addedAt: 10 }, added], recent: [added.id, same.id],
  });
  await expect(updateStickerState(key, update, { lease: first, current: () => true })).rejects.toThrow("another tab");
  await updateStickerState(key, update, { lease, current: () => true });
  expect(await readStickerState(key)).toEqual({ ...localState, favourites: [added, same], recent: [same.id, added.id] });
  expect((await readStickerState(foreign)).favourites).toEqual([]);
});

it.each([199, 200])("keeps all %i existing sticker favourites and fills only spare slots", (count) => {
  const favourites = Array.from({ length: count }, (_, index) => ({ id: `genshin_hoyolab_${index + 100}`, addedAt: index }));
  const state = { tab: "stickers", page: "local", favourites, recent: [] } as const;
  const newEntries = [{ id: "genshin_hoyolab_21", addedAt: 201 }, { id: "genshin_hoyolab_22", addedAt: 202 }];
  const result = mergeTransferredStickers({ ...state, recent: [] }, { favourites: [...newEntries], recent: [] });
  expect(result.favourites).toHaveLength(200);
  expect(result.favourites).toEqual(expect.arrayContaining(favourites));
  expect(result.favourites.includes(newEntries[1])).toBe(count === 199);
});

it("stores colliding wire IDs as distinct account-scoped copies", async () => {
  await saveMessage(message);
  const group = { ...conversation, type: "group" as const, members: [member, { ...member, userId: "carol" }] };
  await importHistoryTransferItem("carol", { entry: { kind: "conversation", conversation: group } });
  const imported = await importHistoryTransferItem("carol", { entry: entry({ ...message, content: "carol's own copy" }) });
  expect(imported).toMatchObject({ ownerId: "carol", transferSourceId: "message" });
  expect(imported?.id).toBe(message.id);
  expect(await getMessageById("message", "alice")).toMatchObject({ content: message.content });
  expect(await getMessageById("message", "carol")).toMatchObject({ content: "carol's own copy" });
  await expect(importHistoryTransferItem("carol", { entry: entry(message) })).resolves.toBeUndefined();
  const { items } = await exportHistoryTransfer("carol", [group]);
  expect(items[1].entry).toMatchObject({ kind: "message", message: { id: "message", content: "carol's own copy" } });
  await rememberMessageDeletion("message", "chat", now, "bob", "bob", () => true, "carol");
  expect(await getMessageById(imported!.id, "carol")).toMatchObject({ content: "", deletedAt: now });
  expect(await getMessageById("message", "alice")).toMatchObject({ content: message.content });
});

it("rejects invalid wire IDs and skips old ones without blocking deletion lookup", async () => {
  await expect(importHistoryTransferItem("alice", { entry: entry({ ...message, id: "bad wire id" }) })).rejects.toThrow();
  const db = await getAppDB();
  await db.put("accountState", { id: 'history-imported-deletion:"alice":bad', wireId: "bad wire id", expiresAt: now + 60_000 });
  await importHistoryTransferItem("alice", { entry: entry({ ...message, id: "valid-message" }) });
  const { candidates } = await importedDeletionPage("alice", undefined, now);
  expect(candidates.map(({ id }) => id)).toEqual(["valid-message"]);
});

it("replaces unreadable current-account attachment bytes with the newly sealed copy", async () => {
  const db = await getAppDB();
  await db.put("accountFiles", { id: "file", ownerId: "alice", cachedAt: now, expiresAt: now + 60_000,
    sealed: { iv: new Uint8Array(12), ciphertext: new Blob(["old key"]) } });
  const blob = new Blob(["offline bytes"]);
  await importHistoryTransferItem("alice", { entry: {
    ...entry(file), attachment: { id: "file", mimeType: "text/plain", fileName: "memo.txt", expiresAt: now + 50_000, size: blob.size },
  }, blob });
  const cached = await getCachedFile("file", "alice");
  expect(await (await openCachedAttachment("alice", "file", cached!.sealed!)).text()).toBe("offline bytes");
});

it("keeps an unreadable cached file's message and key while omitting its bytes from the archive", async () => {
  const db = await getAppDB();
  await saveMessage(file);
  await saveMessage(message);
  await db.put("accountFiles", { id: "file", ownerId: "alice", cachedAt: now, expiresAt: now + 60_000,
    sealed: { iv: new Uint8Array(12), ciphertext: new Blob([new Uint8Array(32)]) } });
  const { items, missingFiles } = await exportHistoryTransfer("alice", [conversation], [{ conversationId: "chat", includeAttachments: true }], now);
  expect(missingFiles.get("chat")).toEqual(["memo.txt"]);
  const fileEntry = items.find(({ entry }) => entry.kind === "message" && entry.message.id === file.id)?.entry;
  expect(fileEntry?.kind === "message" && JSON.parse(fileEntry.message.content)).toEqual(JSON.parse(file.content));
  expect(items).toContainEqual({ entry: { kind: "message", message: expect.objectContaining({ id: message.id, content: message.content }) } });
  const archive = buildTransferArchive(items, "alice", true, undefined, missingFiles);
  expect(archive.manifest.chats[0]).toMatchObject({ messages: 2, attachmentBytes: 0, missingFiles: ["memo.txt"] });
  expect(await archive.read(0, archive.size)).toHaveLength(archive.size);
});

it.each(["group", "direct"] as const)("keeps overlapping legacy %s rows outside every account display", async (type) => {
  const db = await getAppDB();
  const chat = { ...conversation, type };
  const legacyId = type === "direct" ? "legacy:this-device" : "legacy";
  const incomingId = type === "direct" ? "legacy:other-device" : legacyId;
  await db.put("legacyMessages", { ...message, id: legacyId, ownerId: undefined, content: "legacy copy" });
  await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation: chat } });
  const imported = await importHistoryTransferItem("alice", { entry: entry({ ...message, id: incomingId, content: "verified import" }) });
  expect(await getMessages("chat", 1, "alice")).toMatchObject([{ id: imported!.id, content: "verified import" }]);
  expect(await getMessages("chat", 100, "alice")).toHaveLength(1);
  expect(await getMessages("chat", 100, "carol")).toEqual([]);
  await removeLocalMessageContent(imported!.id, undefined, () => true, "alice");
  expect(await getMessages("chat", 100, "alice")).toEqual([]);
  expect(await db.get("legacyMessages", legacyId)).toMatchObject({ content: "legacy copy" });
});

it("detects a selected message hide durably even with no cross-tab broadcast", async () => {
  await saveMessage(message);
  const { revisions } = await exportHistoryTransfer("alice", [conversation], undefined, now);
  expect(await historyArchiveIsCurrent(revisions)).toBe(true);
  await rememberMessageDeletion("unselected", "other-chat", now, "bob", "bob", () => true, "alice");
  expect(await historyArchiveIsCurrent(revisions)).toBe(true);
  await rememberMessageDeletion(message.id, "chat", now, "bob", "bob", () => true, "carol");
  expect(await historyArchiveIsCurrent(revisions)).toBe(true);
  await removeLocalMessageContent(message.id, undefined, () => true, "alice");
  expect(await historyArchiveIsCurrent(revisions)).toBe(false);
});

it("reuses selected revisions until the durable removal generation changes", async () => {
  await saveMessage(message);
  const { revisions } = await exportHistoryTransfer("alice", [conversation], undefined, now);
  const reads = vi.spyOn(IDBObjectStore.prototype, "get");
  try {
    expect(await historyArchiveIsCurrent(revisions)).toBe(true);
    expect(await historyArchiveIsCurrent(revisions)).toBe(true);
    expect(reads.mock.calls).toEqual([[HISTORY_REMOVAL_GENERATION_KEY], [HISTORY_REMOVAL_GENERATION_KEY]]);
    await rememberMessageDeletion("different-chat", "other", now, "bob", "bob", () => true, "alice");
    reads.mockClear();
    expect(await historyArchiveIsCurrent(revisions)).toBe(true);
    expect(reads.mock.calls.length).toBeGreaterThan(1);
    reads.mockClear();
    expect(await historyArchiveIsCurrent(revisions)).toBe(true);
    expect(reads.mock.calls).toEqual([[HISTORY_REMOVAL_GENERATION_KEY]]);
    await removeLocalMessageContent(message.id, undefined, () => true, "alice");
    expect(await historyArchiveIsCurrent(revisions)).toBe(false);
  } finally { reads.mockRestore(); }
});

it("records marker-only imports without displaying the quarantined row", async () => {
  const db = await getAppDB();
  const legacy = { ...message, id: "legacy:receiver", ownerId: undefined };
  await db.put("legacyMessages", legacy);
  await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation } });
  const { revisions } = await exportHistoryTransfer("alice", [conversation], undefined, now);
  const changed = await importHistoryTransferItem("alice", { entry: { kind: "deletion", id: "legacy:sender",
    conversationId: "chat", senderId: "bob", deletedByUserId: "bob", deletedAt: now } });
  expect(changed).toBeUndefined();
  expect(await db.get("legacyMessages", legacy.id)).toEqual(legacy);
  expect(await getMessages("chat", 100, "alice")).toEqual([]);
  expect(await getMessages("chat", 100, "carol")).toEqual([]);
  expect(await historyArchiveIsCurrent(revisions)).toBe(false);
});

it("evicts the current account's cached bytes when its deleted file row is still ownerless", async () => {
  const db = await getAppDB();
  const legacy = { ...file, ownerId: undefined };
  await db.put("legacyMessages", legacy);
  const sealed = await sealCachedAttachment("alice", "file", new Blob(["offline"]));
  const tx = db.transaction("accountFiles", "readwrite");
  for (const ownerId of ["alice", "carol"]) await writeCachedFile(tx.store, { id: "file", ownerId, sealed, cachedAt: now, expiresAt: now + 60_000 });
  await tx.done;
  await rememberMessageDeletion(file.id, "chat", now, "bob", "bob", () => true, "alice");
  const redacted = await db.get("legacyMessages", file.id);
  expect(redacted).toMatchObject({ content: "", deletedAt: now });
  expect(redacted.ownerId).toBeUndefined();
  await removeLocalMessageContent(file.id, { ...file, content: "", deletedAt: now, deletedByUserId: "bob" }, () => true, "alice");
  expect(await getCachedFile("file", "alice")).toBeUndefined();
  expect(await getCachedFile("file", "carol")).toBeDefined();
  expect(await db.get("displayMessages", ["alice", file.id])).toMatchObject({ content: "", deletedAt: now });
  expect(await getMessages("chat", 100, "alice")).toMatchObject([{ content: "", deletedAt: now }]);
});

it("redacts matching quarantined fanout copies with a canonical row present and leaves other accounts and identities intact", async () => {
  const db = await getAppDB();
  await saveMessage({ ...file, id: "copy:local", direct: true });
  await db.put("legacyMessages", { ...file, id: "copy:legacy", ownerId: undefined });
  await db.put("legacyMessages", { ...file, id: "copy:foreign", ownerId: "carol" });
  await db.put("legacyMessages", { ...file, id: "copy:foreign-chat", conversationId: "other", ownerId: undefined });
  await db.put("legacyMessages", { ...file, id: "copy-other", ownerId: undefined });
  await rememberMessageDeletion("copy:server", "chat", now, "bob", "bob", () => true, "alice", true);
  expect(await db.get("legacyMessages", "copy:legacy")).toMatchObject({ content: "", deletedAt: now });
  expect(await getMessageById("copy", "alice")).toMatchObject({ content: "", deletedAt: now });
  for (const id of ["copy:foreign", "copy:foreign-chat", "copy-other"]) {
    expect(await db.get("legacyMessages", id)).toMatchObject({ content: file.content });
  }
});

it("keeps a prepared archive current when the same tombstone arrives again through sync", async () => {
  await saveMessage(message);
  const mark = () => rememberMessageDeletion(message.id, "chat", now, "bob", "bob", () => true, "alice");
  await mark();
  const { revisions } = await exportHistoryTransfer("alice", [conversation], undefined, now);
  vi.mocked(publishLocalMessageChange).mockClear();
  await mark();
  await removeLocalMessageContent(message.id, { ...message, content: "", deletedAt: now, deletedByUserId: "bob" }, () => true, "alice");
  expect(await historyArchiveIsCurrent(revisions)).toBe(true);
  expect(publishLocalMessageChange).not.toHaveBeenCalled();
  await rememberMessageDeletion(message.id, "chat", now + 1, "bob", "bob", () => true, "alice");
  expect(await historyArchiveIsCurrent(revisions)).toBe(false);
});

it("excludes removed groups from the catalog and rejects an explicit stale selection", async () => {
  const group = { ...conversation, type: "group" as const };
  await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation: group } });
  await importHistoryTransferItem("alice", { entry: entry(message) });
  expect(await historyTransferCatalog("alice", [group])).toMatchObject([{ id: "chat", messages: 1 }]);
  expect(await historyTransferCatalog("alice", [])).toEqual([]);
  expect((await exportHistoryTransfer("alice", [])).items).toEqual([]);
  await expect(exportHistoryTransfer("alice", [], [{ conversationId: "chat" }])).rejects.toThrow("Selected conversation metadata unavailable");
  expect(await getMessageById(message.id, "alice")).toMatchObject({ content: message.content });
});

it("releases its read transaction between picker catalog batches", async () => {
  const db = await getAppDB();
  const seed = db.transaction("displayMessages", "readwrite");
  await Promise.all([...Array.from({ length: 201 }, (_, i) => seed.store.put({ ...message, id: `catalog-${i}` })), seed.done]);
  const original = db.transaction.bind(db);
  const closed: Promise<void>[] = [];
  const transactions = vi.spyOn(db, "transaction").mockImplementation((stores, mode, options) => {
    const tx = original(stores, mode, options);
    if (Array.isArray(stores) && stores.includes("displayMessages") && mode === "readonly") closed.push(tx.done);
    return tx;
  });
  try {
    expect(await historyTransferCatalog("alice", [conversation])).toMatchObject([{ messages: 201 }]);
    expect(closed).toHaveLength(3);
    await Promise.all(closed);
  } finally { transactions.mockRestore(); }
});

it.each(["group", "direct"] as const)("keeps finalized %s hide barriers private to the account, including fanout IDs", async (type) => {
  const group = { ...conversation, type, members: [member, { ...member, userId: "carol" }] };
  for (const user of ["alice", "carol"]) {
    await importHistoryTransferItem(user, { entry: { kind: "conversation", conversation: group } });
  }
  const id = type === "group" ? "shared" : "shared:sender";
  await saveMessage({ ...message, id });
  const hide = await beginMessageHide(id, undefined, "alice");
  await finishMessageHide(id, hide!.token, false, undefined, "alice");
  expect(await getMessageById(id, "alice")).toBeUndefined();
  expect(await (await getAppDB()).get("accountState", messageHideKey(id, "alice"))).toMatchObject({ ownerId: "alice" });

  const incomingId = type === "group" ? id : "shared:receiver";
  const incoming = { entry: entry({ ...message, id: incomingId }) };
  expect(await importHistoryTransferItem("alice", incoming)).toBeUndefined();
  expect(await importHistoryTransferItem("carol", incoming)).toMatchObject({ ownerId: "carol" });
  // A stale Alice write must honor Alice's hide even after Carol claimed the bare ID.
  await saveMessage({ ...message, id, ownerId: "alice" });
  expect(await getMessageById(id, "alice")).toBeUndefined();
  expect(await getMessageById(incomingId, "carol")).toMatchObject({ content: message.content });
});

it("retains and exports both accounts' sealed copies and evicts only the account that hides", async () => {
  const group = { ...conversation, type: "group" as const, members: [member, { ...member, userId: "carol" }] };
  const attachment = { id: "file", fileName: "memo.txt", mimeType: "text/plain", expiresAt: now + 50_000, size: 5 };
  for (const [owner, bytes] of [["alice", "alice"], ["carol", "carol"]]) {
    await importHistoryTransferItem(owner, { entry: { kind: "conversation", conversation: group } });
    await importHistoryTransferItem(owner, { entry: { ...entry(file), attachment }, blob: new Blob([bytes]) });
  }
  for (const [owner, bytes] of [["alice", "alice"], ["carol", "carol"]]) {
    const cached = await getCachedFile("file", owner);
    expect(await (await openCachedAttachment(owner, "file", cached!.sealed!)).text()).toBe(bytes);
    const { items } = await exportHistoryTransfer(owner, [group], [{ conversationId: "chat", includeAttachments: true }]);
    expect(await (await items.find((item) => item.attachmentSource)?.attachmentSource?.open())?.text()).toBe(bytes);
  }
  const hide = await beginMessageHide(file.id, undefined, "alice");
  await finishMessageHide(file.id, hide!.token, false, undefined, "alice");
  expect(await getCachedFile("file", "alice")).toBeUndefined();
  const remaining = await getCachedFile("file", "carol");
  expect(await (await openCachedAttachment("carol", "file", remaining!.sealed!)).text()).toBe("carol");
});

it.each(["group", "direct"] as const)("never restores a finalized ownerless pre-upgrade hide in %s imports", async (type) => {
  const db = await getAppDB();
  const chat = { ...conversation, type };
  await db.put("accountState", { id: "hidden-message:hidden:old-device" });
  await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation: chat } });
  const id = type === "direct" ? "hidden:new-device" : "hidden:old-device";
  const attachment = { id: "file", mimeType: "text/plain", fileName: "memo.txt", expiresAt: now + 10_000, size: 4 };
  await importHistoryTransferItem("alice", { entry: { ...entry({ ...file, id, editedAt: now }), attachment }, blob: new Blob(["file"]) });
  expect(await getMessageById(id, "alice")).toBeUndefined();
  expect(await getCachedFile("file", "alice")).toBeUndefined();
  expect(await getHistoryTransferMarkers("alice", "chat")).toEqual([]);
});

it("keeps independent unseen tombstones for the same wire ID through stale imports", async () => {
  const chat = { ...conversation, type: "group" as const, members: [member, { ...member, userId: "carol" }] };
  for (const [owner, deletedAt] of [["alice", now], ["carol", now + 1]] as const) {
    await importHistoryTransferItem(owner, { entry: { kind: "conversation", conversation: chat } });
    await rememberMessageDeletion(message.id, chat.id, deletedAt, "bob", "bob", () => true, owner);
  }
  const db = await getAppDB();
  expect(await db.get("accountState", messageDeletionKey(message.id, "alice"))).toMatchObject({ ownerId: "alice", deletedAt: now });
  expect(await db.get("accountState", messageDeletionKey(message.id, "carol"))).toMatchObject({ ownerId: "carol", deletedAt: now + 1 });
  for (const [owner, deletedAt] of [["alice", now], ["carol", now + 1]] as const) {
    await importHistoryTransferItem(owner, { entry: entry({ ...message, editedAt: now + 2 }) });
    expect(await getMessageById(message.id, owner)).toMatchObject({ ownerId: owner, content: "", deletedAt });
  }
});

it.each(["same-account", "foreign-key", "wrong-conversation", "wrong-sender"] as const)(
  "matches direct fanout barriers by their owner, sender and conversation (%s)", async (scenario) => {
    const chat = { ...conversation, members: [member, { ...member, userId: "carol" }] };
    await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation: chat } });
    const owner = scenario === "foreign-key" ? "carol" : "alice";
    const conversationId = scenario === "wrong-conversation" ? "unrelated" : chat.id;
    const senderId = scenario === "wrong-sender" ? "other-sender" : "bob";
    // Import will see scoped evidence for a different envelope in the same direct family.
    await rememberMessageDeletion("fanout:this-device", conversationId, now, senderId, senderId, () => true, owner);
    const update = { ...message, id: "fanout:source-device" };
    const imported = await importHistoryTransferItem("alice", { entry: entry(update) });
    expect(imported).toMatchObject(scenario === "same-account" ? { content: "", deletedAt: now } : { content: message.content });
  },
);

it("records the failed receiver envelope receipt even when a sibling repairs the row", async () => {
  await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation } });
  const local = { ...message, id: "failed:this-device", status: "failed", content: "" };
  await commitReceivedMessage(local.id, { ownerId: "alice", direct: true, expiresAt: local.expiresAt, message: local });
  await importHistoryTransferItem("alice", { entry: entry({ ...message, id: "failed:source-device" }) });
  expect(await getMessageById(local.id, "alice")).toMatchObject({ transferSourceId: "failed:source-device", importedAt: expect.any(Number) });
  expect(await getReceiveReceipt(local.id, "alice")).toBeDefined();
  expect(await getReceiveReceipt("failed:source-device", "alice")).toBeUndefined();
  expect(await commitReceivedMessage(local.id, { ownerId: "alice", expiresAt: local.expiresAt, message })).toBe(false);
});

it("transfers the committed direct edit and keeps later authenticated edits local to devices with the key", async () => {
  const db = await getAppDB();
  const encryptionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  setLocalEncryptionKey(encryptionKey);
  try {
    const key = generateAESKey(), signer = await generateIdentityKeyPair();
    const scope = { messageId: message.id, conversationId: message.conversationId, senderId: message.senderId, senderDeviceId: "bob-phone" };
    const wireId = message.id + ":source";
    const credentials = { editKey: toBase64Url(key), editSigningKey: toBase64Url(signer.publicEd25519), editSenderDeviceId: scope.senderDeviceId, editKeyAccepted: true };
    const committed = { ...message, id: wireId, direct: true, ...credentials };
    await saveMessage(committed);
    const edit = async (editSeq: number, content: string) => ({
      ...scope, ...await encryptMessageEdit(key, signer.privateEd25519, scope, editSeq, content),
      editSeq, editedAt: now + editSeq, mutationSeq: editSeq, expiresAt: message.expiresAt,
    });
    const apply = async (revision: Awaited<ReturnType<typeof edit>>, text: string, deviceId: string) => {
      const original = await getOriginalForEdit(revision, "alice", deviceId, () => true);
      return original && applyReceivedEdit(revision, original, text, () => true);
    };
    const prior = await exportHistoryTransfer("alice", [conversation], undefined, now);
    const first = await edit(1, "first committed revision");
    expect(await apply(first, "first committed revision", "source")).toMatchObject({ id: message.id, editedAt: first.editedAt });
    expect(await historyArchiveIsCurrent(prior.revisions)).toBe(false);
    // A stale copy of the original send cannot replace the edit.
    await saveMessage(committed);
    const { items } = await exportHistoryTransfer("alice", [conversation], undefined, now);
    const text = items.find(({ entry }) => entry.kind === "message")?.entry;
    expect(text).toEqual({ kind: "message", message: {
      id: wireId, conversationId: message.conversationId, senderId: message.senderId, type: "text",
      content: "first committed revision", timestamp: message.timestamp, expiresAt: message.expiresAt, expiryKind: "timed",
      status: "delivered", editedAt: first.editedAt, editedByUserId: message.senderId,
    } });
    expect(JSON.stringify(await db.getAll("displayMessages"))).not.toContain(credentials.editKey);

    await db.clear("displayMessages");
    await db.clear("accountState");
    for (const item of items) await importHistoryTransferItem("alice", item);
    const later = await edit(2, "later authenticated revision");
    expect(await getMessageById(message.id, "alice", true, true)).toMatchObject({ content: "first committed revision", editedAt: first.editedAt });
    expect(await apply(later, "later authenticated revision", "receiver")).toBeUndefined();

    // Receiving its own authenticated envelope adds a key without replacing the transferred edit.
    const receiverWire = message.id + ":receiver";
    await commitReceivedMessage(receiverWire, {
      ownerId: "alice", deviceId: "receiver", direct: true, expiresAt: message.expiresAt,
      message: { ...committed, id: receiverWire },
    });
    expect(await getMessageById(message.id, "alice")).toMatchObject({ content: "first committed revision" });
    expect(await apply(later, "later authenticated revision", "receiver")).toMatchObject({ content: "later authenticated revision", editSequence: 2 });
    await importHistoryTransferItem("alice", { entry: text! });
    const rows = await getMessages(conversation.id, 100, "alice");
    expect(rows).toMatchObject([{ id: message.id, content: "later authenticated revision", editedAt: later.editedAt }]);
  } finally {
    setLocalEncryptionKey(null);
  }
});
