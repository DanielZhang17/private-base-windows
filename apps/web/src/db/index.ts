import { openDB, type IDBPDatabase, type IDBPObjectStore, type IDBPTransaction } from "idb";
import { transferredMessageId } from "@e2ee-chat/shared";
import type { SendMessageRequest, SendDirectBatchRequest, InitialMessageHeader, ExpiryKind, WSMessageFrame, MessageEditFrame, MessageEditRequest, MessageEditReceipt } from "@e2ee-chat/shared";
import type { StickerState } from "../features/stickers/storage.js";
import { decryptMessageEdit, fromBase64Url, toBase64Url } from "@e2ee-chat/crypto";
import { decryptData, encryptData, localEncryptionKey, openAttachmentBytes, sealAttachmentBytes,
  type EncryptedLocalData, type SealedAttachment } from "../lib/local-key-encryption.js";
import { isSticker } from "../lib/stickers.js";
import { normalizeExpiryMetadata } from "../lib/message-retention.js";
import { messageVisibleToAccount } from "../lib/message-account.js";

import { getConversationHideGeneration, publishLocalMessageChange } from "../lib/local-message-changes.js";

const DB_NAME = "e2ee-chat";
const DB_VERSION = 7;
const RENAMED_STORES = {
  sessions: "receiveSessions", localKeys: "deviceKeys", conversations: "accountConversations",
  senderKeys: "receiveSenderKeys", fileCache: "accountFiles", pendingCalls: "receivePendingCalls",
  senderKeyRecipients: "receiveSenderKeyRecipients", syncState: "accountState",
} as const;
const LEGACY_STORES = ["messages", "outgoingQueue", ...Object.keys(RENAMED_STORES)];
const CANONICAL_STORES = ["displayMessages", "legacyMessages", ...Object.values(RENAMED_STORES)];
const LEGACY_OUTGOING_PREFIX = "outgoing:";
const OUTGOING_PREFIX = "outgoing-account:";
const OUTGOING_EDIT_PREFIX = "outgoing-edit:";
const OUTGOING_EDIT_STATUS_PREFIX = "outgoing-edit-status:";
const OUTGOING_EDIT_TARGET_PREFIX = "outgoing-edit-target:";
const OUTGOING_EDIT_TARGET_INDEX = "outgoing-edit-target-index-v1";
const EDIT_STATE_PREFIX = "message-edit-state:";
const EDIT_REPAIR_PREFIX = "edit-repair:";
const EDIT_KEY_RESET_ID = "message-edit-key-reset";
const EDIT_KEY_MIGRATION_ID = "message-edit-key-wrap-v2";
const LOCKED_EDIT_PREFIX = "locked-message-edit:";

export const MESSAGE_DELETION_PREFIX = "deleted-message:";
export const MESSAGE_HIDE_PREFIX = "hidden-message:";

export interface MessageDeletion {
  conversationId: string;
  senderId?: string;
  deletedAt: number;
  deletedByUserId: string;
  importedAt?: number;
  ownerId?: string;
  transferSourceId?: string;
}

function outgoingKey(id: string, ownerId: string, prefix = OUTGOING_PREFIX): string {
  return prefix + JSON.stringify([ownerId, id]);
}

function outgoingKeyRange(ownerId?: string, kind = OUTGOING_PREFIX) {
  const prefix = ownerId ? kind + JSON.stringify([ownerId]).slice(0, -1) + "," : kind;
  return IDBKeyRange.bound(prefix, prefix + "\uffff");
}

// Keep messages and outbox entries in a single transaction.
function outgoingRecord(outgoing: LocalOutgoing) {
  outgoing.revision = crypto.randomUUID();
  return { id: outgoingId(outgoing), outgoing };
}

function outgoingId(outgoing: Pick<LocalOutgoing, "id" | "userId" | "editTargetId">) {
  return outgoingKey(outgoing.id, outgoing.userId, outgoing.editTargetId ? OUTGOING_EDIT_PREFIX : OUTGOING_PREFIX);
}

type OutgoingStore = IDBPObjectStore<unknown, string[], "accountState", "readwrite" | "versionchange">;
type SyncStateReader = { get(key: string): Promise<unknown> };
type OutgoingEditTarget = Pick<LocalOutgoing, "id" | "conversationId" | "userId">;
const outgoingEditTargetPrefix = (ownerId: string, targetId: string) =>
  OUTGOING_EDIT_TARGET_PREFIX + JSON.stringify([ownerId, targetId]) + ":";

async function addOutgoingEditTarget(store: OutgoingStore, { id, editTargetId, conversationId, userId }: OutgoingEditTarget & { editTargetId?: string }) {
  if (editTargetId) await store.put({ id: outgoingEditTargetPrefix(userId, editTargetId) + id, edit: { id, conversationId, userId } });
}

async function ensureOutgoingEditTargets(store: OutgoingStore) {
  if (await store.getKey(OUTGOING_EDIT_TARGET_INDEX) !== undefined) return;
  const keys = await store.getAllKeys(outgoingKeyRange(undefined, OUTGOING_EDIT_PREFIX));
  for (const key of keys) {
    const [ownerId, id] = JSON.parse(String(key).slice(OUTGOING_EDIT_PREFIX.length)) as [string, string];
    const status = await readOutgoingEditStatus(store, id, ownerId);
    if (status) await addOutgoingEditTarget(store, status);
  }
  await store.put({ id: OUTGOING_EDIT_TARGET_INDEX });
}

function outgoingEditStatus({ steps, upload, ...status }: LocalOutgoing): OutgoingEditStatus {
  return { ...status, hasEnvelope: steps?.some((step) => step.path === "/api/messages/edit") ?? false };
}

async function putOutgoing(store: OutgoingStore, outgoing: LocalOutgoing) {
  if (outgoing.editTargetId) await ensureOutgoingEditTargets(store);
  await store.put(outgoingRecord(outgoing));
  if (outgoing.editTargetId) await Promise.all([
    store.put({ id: outgoingKey(outgoing.id, outgoing.userId, OUTGOING_EDIT_STATUS_PREFIX), status: outgoingEditStatus(outgoing) }),
    addOutgoingEditTarget(store, outgoing),
  ]);
}

async function deleteOutgoingEdit(store: OutgoingStore, id: string, targetId: string, ownerId: string) {
  await Promise.all([
    store.delete(outgoingKey(id, ownerId, OUTGOING_EDIT_PREFIX)),
    store.delete(outgoingKey(id, ownerId, OUTGOING_EDIT_STATUS_PREFIX)),
    store.delete(outgoingEditTargetPrefix(ownerId, targetId) + id),
  ]);
}

async function readOutgoingEditStatus(store: OutgoingStore, id: string, ownerId: string): Promise<OutgoingEditStatus | undefined> {
  const key = outgoingKey(id, ownerId, OUTGOING_EDIT_PREFIX);
  const statusKey = outgoingKey(id, ownerId, OUTGOING_EDIT_STATUS_PREFIX);
  const saved = await store.get(statusKey);
  if (saved) return await store.getKey(key) !== undefined ? saved.status : undefined;
  const outgoing = (await store.get(key))?.outgoing as LocalOutgoing | undefined;
  if (!outgoing) return;
  const status = outgoingEditStatus(outgoing);
  await store.put({ id: statusKey, status });
  return status;
}

async function retireEditsForMessage(store: OutgoingStore, id: string, ownerId: string, identity?: { conversationId: string; senderId: string }) {
  await ensureOutgoingEditTargets(store);
  const prefix = outgoingEditTargetPrefix(ownerId, id);
  const records = await store.getAll(IDBKeyRange.bound(prefix, prefix + "\uffff")) as { edit: OutgoingEditTarget }[];
  const retired = records.filter(({ edit }) => !identity || (edit.conversationId === identity.conversationId && edit.userId === identity.senderId));
  await Promise.all(retired.map(({ edit }) => deleteOutgoingEdit(store, edit.id, id, ownerId)));
  if (retired.length) void store.transaction.done.then(() => {
    for (const { edit } of retired) publishLocalMessageChange(edit.id, "outbox", edit.conversationId, true, ownerId);
  }, () => undefined);
}

async function readOutgoing(store: SyncStateReader, id: string, ownerId: string): Promise<LocalOutgoing | undefined> {
  const [message, edit] = await Promise.all([store.get(outgoingKey(id, ownerId)), store.get(outgoingKey(id, ownerId, OUTGOING_EDIT_PREFIX))]);
  return ((message ?? edit) as { outgoing: LocalOutgoing } | undefined)?.outgoing;
}

export async function queuedMessageIds(store: { getAllKeys(range: IDBKeyRange): Promise<IDBValidKey[]> }, ownerId?: string) {
  const keys = await store.getAllKeys(outgoingKeyRange(ownerId));
  return new Set(keys);
}

export function isQueuedMessage(keys: ReadonlySet<IDBValidKey>, row: Pick<LocalMessage, "id" | "ownerId">): boolean {
  return !!row.ownerId && keys.has(outgoingKey(row.id, row.ownerId));
}

export async function hasQueuedMessage(store: { getKey(key: string): Promise<IDBValidKey | undefined> }, id: string, ownerId: string): Promise<boolean> {
  return (await store.getKey(outgoingKey(id, ownerId))) !== undefined;
}

export interface LocalMessage {
  ownerId?: string;
  /** Direct envelopes share a logical display ID, but keep distinct wire receipts. */
  direct?: boolean;
  wireId?: string;
  imported?: { fromDeviceId: string; at: number };
  transferSourceId?: string;
  importedAt?: number;
  editedAt?: number | null;
  editedByUserId?: string | null;
  editSequence?: number;
  latestEditSeq?: number | null;
  editKeyAccepted?: boolean;
  editKey?: string;
  editKeyVersion?: string;
  editSigningKey?: string;
  editSenderDeviceId?: string;
  pendingEdit?: { id: string; content: string } | null;

  deletedAt?: number | null;
  deletedByUserId?: string | null;
  id: string;
  conversationId: string;
  senderId: string;
  type: string;
  content: string;
  timestamp: number;
  expiresAt: number | null;
  expiryKind?: ExpiryKind | null;
  status: string;
  /** Read-time annotation from the outbox, not a persisted expiry override. */
  hasOutgoingEntry?: boolean;
}

interface LocalEditState {
  id: string;
  conversationId: string;
  senderId: string;
  aadId?: string;
  wrappedKey: EncryptedLocalData;
  editSigningKey: string;
  editSenderDeviceId: string;
  editKeyAccepted?: boolean;
  editSequence: number;
  editedAt?: number;
  envelope?: MessageEditRequest;
  pendingId?: string;
}

function editStorageAAD(edit: Pick<LocalEditState, "id" | "conversationId" | "senderId" | "editSenderDeviceId" | "editSigningKey" | "aadId">): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([edit.aadId ?? edit.id, edit.conversationId, edit.senderId, edit.editSenderDeviceId, edit.editSigningKey]));
}

function editStateKey(id: string, ownerId?: string) {
  return EDIT_STATE_PREFIX + (ownerId ? JSON.stringify([ownerId, id]) : id);
}

function editKeyFromInline(message: LocalMessage) {
  const { id, conversationId, senderId, editKey, editSigningKey, editSenderDeviceId, editKeyAccepted, editSequence, editedAt, pendingEdit, ownerId } = message;
  if (message.type !== "text" || message.deletedAt || isSticker(message) || !editKey || !editSigningKey || !editSenderDeviceId) return;
  return { id: editStateKey(id, ownerId), conversationId, senderId, editKey, editSigningKey, editSenderDeviceId, editKeyAccepted,
    editSequence: editSequence ?? 0, editedAt: editedAt ?? undefined, pendingId: pendingEdit?.id };
}

type PlaintextEditState = Omit<LocalEditState, "wrappedKey"> & { editKey: string };

async function wrapEditState({ editKey, ...edit }: PlaintextEditState, key: CryptoKey): Promise<LocalEditState> {
  return { ...edit, wrappedKey: await encryptData(key, fromBase64Url(editKey), editStorageAAD(edit)) };
}

async function prepareEditState(message: LocalMessage): Promise<LocalEditState | undefined> {
  const edit = editKeyFromInline(message);
  if (!edit) return;
  const key = localEncryptionKey;
  if (!key) throw new DOMException("Local key is locked", "AbortError");
  const wrapped = await wrapEditState(edit, key);
  if (localEncryptionKey !== key) throw new DOMException("Local key was locked", "AbortError");
  return wrapped;
}

async function openEditKey(edit: LocalEditState, key = localEncryptionKey): Promise<string | undefined> {
  if (!key) return;
  try {
    const bytes = await decryptData(key, edit.wrappedKey.iv, edit.wrappedKey.ciphertext, editStorageAAD(edit));
    if (bytes.length === 32) return toBase64Url(bytes);
  } catch { /* A damaged record or one belonging to another local key is read-only. */ }
}

async function openStoredEdit(edits: LocalEditState, envelope: MessageEditRequest, key: string | undefined) {
  if (!key) return;
  try {
    return await decryptMessageEdit(fromBase64Url(key), fromBase64Url(edits.editSigningKey),
      { ...envelope, senderId: edits.senderId, senderDeviceId: edits.editSenderDeviceId }, envelope.editSeq, envelope);
  } catch { return undefined; }
}

async function readEditState(store: SyncStateReader, message: LocalMessage): Promise<LocalEditState | undefined> {
  if (message.type !== "text" || message.deletedAt || isSticker(message)) return;
  const saved = await store.get(editStateKey(message.id, message.ownerId)) as LocalEditState | undefined;
  return saved?.wrappedKey && saved.conversationId === message.conversationId && saved.senderId === message.senderId ? saved : undefined;
}

function editCredentials(edit: LocalEditState) {
  return { editSenderDeviceId: edit.editSenderDeviceId, editKeyAccepted: localEncryptionKey ? edit.editKeyAccepted : undefined };
}

function withoutEditCredentials(message: LocalMessage): LocalMessage {
  const { editKey, editKeyVersion, editSigningKey, editSenderDeviceId, editKeyAccepted, pendingEdit, ...row } = message;
  return row;
}

function editEnvelope(request: MessageEditRequest): MessageEditRequest {
  const { messageId, conversationId, editSeq, ciphertext, nonce, signature } = request;
  return { messageId, conversationId, editSeq, ciphertext, nonce, signature };
}

/** Snapshot the surviving edit state in the same transaction as the message row. */
async function readEditSnapshot(store: SyncStateReader, message: LocalMessage) {
  const edits = await readEditState(store, message);
  const pending = edits?.pendingId && message.ownerId
    ? await store.get(outgoingKey(edits.pendingId, message.ownerId, OUTGOING_EDIT_PREFIX)) as { outgoing: LocalOutgoing } | undefined
    : undefined;
  const step = pending?.outgoing.steps[0];
  return { message, edits, pending: step?.path === "/api/messages/edit" ? step.body : undefined };
}

/** Recovery crypto runs outside the IDB transaction and only after a legacy rewrite. */
async function restoreEditSnapshot({ message, edits, pending }: Awaited<ReturnType<typeof readEditSnapshot>>, includeEditKey = false): Promise<LocalMessage> {
  message = withoutEditCredentials(message);
  if (!edits) return message;
  const needsRecovery = edits.editSequence > (message.editSequence ?? 0) && edits.envelope;
  const encryptionKey = localEncryptionKey;
  const key = needsRecovery || pending || includeEditKey ? await openEditKey(edits) : undefined;
  let restored: LocalMessage = { ...message, ...editCredentials(edits), pendingEdit: null };
  if (needsRecovery) {
    const content = await openStoredEdit(edits, needsRecovery, key);
    if (content !== undefined && edits.editedAt !== undefined && !isSticker({ type: "text", content })) {
      restored = editMessage(restored, { content, editedAt: edits.editedAt, editSeq: edits.editSequence });
    }
  }
  if (edits.pendingId && pending) {
    const content = await openStoredEdit(edits, pending, key);
    if (content !== undefined) restored.pendingEdit = { id: edits.pendingId, content };
  }
  if (localEncryptionKey !== encryptionKey) return message;
  return includeEditKey && key ? {
    ...restored, editKey: key, editKeyVersion: edits.wrappedKey.iv, editSigningKey: edits.editSigningKey,
  } : restored;
}

function permanentHide(record: { undoToken?: string; undoDeadline?: number } | undefined): boolean {
  return !!record && (!record.undoToken || (record.undoDeadline ?? 0) <= Date.now());
}

export interface LocalSession {
  id: string; // `${userId}:${deviceId}`
  state: string; // JSON-serialized ratchet state
  updatedAt: number;
  peerIdentityKey?: string;
  x3dhEphemeralKey?: string;
  initialHeader?: InitialMessageHeader;
  retiredEphemeralKeys?: string[];
}

export interface LocalKey {
  id: string;
  type: string;
  data: string; // encrypted private key material
}

export interface LocalPendingCall {
  id: string;
  conversationId: string;
  initiatorId: string;
  callType: "audio" | "video";
  callKey: string;
  createdAt: number;
  expiresAt: number;
  direction: "incoming" | "outgoing";
}

export interface LocalSyncState {
  id: string;
  value: number;
  updatedAt: number;
  cursorId?: string;
  stickerPickerState?: StickerState;
}

export interface CachedFile {
  id: string; // fileId
  ownerId?: string;
  sealed?: SealedAttachment;
  explicitTransfer?: true;
  /** Older clients may have left plaintext here. Never reuse those entries. */
  blob?: Blob;
  mimeType?: string;
  fileName?: string;
  cachedAt: number; // Date.now()
  expiresAt: number; // same effective expiry as the remote file
}

let dbPromise: Promise<IDBPDatabase> | null = null;
let upgradeBlocked = false;
const upgradeListeners = new Set<() => void>();

export function isDatabaseUpgradeBlocked(): boolean { return upgradeBlocked; }
export function subscribeDatabaseUpgrade(listener: () => void): () => void {
  upgradeListeners.add(listener);
  return () => { upgradeListeners.delete(listener); };
}

function setUpgradeBlocked(blocked: boolean): void {
  if (upgradeBlocked === blocked) return;
  upgradeBlocked = blocked;
  for (const listener of upgradeListeners) listener();
}

type UpgradeTransaction = IDBPTransaction<unknown, string[], "versionchange">;

function hasCanonicalDisplaySchema(store: Pick<IDBObjectStore, "keyPath" | "indexNames">): boolean {
  return JSON.stringify(store.keyPath) === '["ownerId","id"]'
    && ["byId", "byConversation", "byAccountConversation", "byTimestamp"].every((name) => store.indexNames.contains(name));
}

function quarantineMessage(row: LocalMessage) {
  return { ...row, quarantineExpiresAt: normalizeExpiryMetadata(row).expiresAt };
}

async function finishLegacyUpgradeHides(tx: UpgradeTransaction, recoverFinalized: boolean): Promise<void> {
  const legacy = tx.objectStore("legacyMessages"), state = tx.objectStore("accountState");
  for (const hide of await state.getAll(IDBKeyRange.bound(MESSAGE_HIDE_PREFIX, MESSAGE_HIDE_PREFIX + "\uffff")) as MessageHide[]) {
    if (hide.ownerId || (!hide.undoToken && !recoverFinalized)) continue;
    const id = hide.messageId ?? hide.id.slice(MESSAGE_HIDE_PREFIX.length);
    const row = await legacy.get(id) as LocalMessage | undefined;
    // Old tabs are closed. Finalize their exact retained row. On the previous
    // canonical layout, repair finalized hides only for still-unowned rows.
    if (row && (hide.undoToken || !row.ownerId)) {
      const fileId = extractFileIdFromMessage(row);
      if (fileId) await evictCachedFile(tx.objectStore("accountFiles"), fileId, row.ownerId);
      const expiresAt = normalizeExpiryMetadata(row).expiresAt;
      await state.delete(editStateKey(id));
      await legacy.delete(id);
      if (hide.undoToken) await state.put({ id: hide.id, messageId: id, expiresAt } satisfies MessageHide);
    }
    if (hide.undoToken && !row) await state.put({ id: hide.id, messageId: id } satisfies MessageHide);
  }
}

async function indexQuarantineExpiry(tx: UpgradeTransaction): Promise<void> {
  let cursor = await tx.objectStore("legacyMessages").openCursor();
  while (cursor) {
    await cursor.update(quarantineMessage(cursor.value as LocalMessage));
    cursor = await cursor.continue();
  }
}

/** Move v5's multiplexed edit outbox into scoped keys. Repair jobs, locked
 * envelopes and cursors are already scoped and travel with the renamed store. */
async function migrateLegacyEditOutbox(state: OutgoingStore) {
  const records = await state.getAll(outgoingKeyRange(undefined, OUTGOING_EDIT_PREFIX));
  await state.delete(outgoingKeyRange(undefined, OUTGOING_EDIT_STATUS_PREFIX));
  await state.delete(outgoingKeyRange(undefined, OUTGOING_EDIT_TARGET_PREFIX));
  await state.delete(OUTGOING_EDIT_TARGET_INDEX);
  for (const { id, outgoing } of records) {
    if (outgoing?.userId && outgoing.editTargetId) {
      const nextId = outgoingId(outgoing);
      if (id !== nextId) {
        if (!await state.get(nextId)) await state.put({ id: nextId, outgoing });
        await state.delete(id);
      }
    }
  }
  await ensureOutgoingEditTargets(state);
}

/** Legacy edit-state AAD includes its old key. Keep that ID for decryption
 * while moving the record under the proven account's canonical message ID. */
export async function promoteLegacyEditState(state: OutgoingStore, legacyId: string, row: LocalMessage) {
  if (!row.ownerId) return;
  const legacyKey = editStateKey(legacyId);
  const saved = await state.get(legacyKey) as LocalEditState | undefined;
  if (!saved || saved.conversationId !== row.conversationId || saved.senderId !== row.senderId) return;
  if (!row.deletedAt && row.type === "text" && !isSticker(row)) {
    const id = editStateKey(row.id, row.ownerId);
    if (!await state.get(id)) await state.put({ ...saved, aadId: saved.aadId ?? saved.id, id });
  }
  await state.delete(legacyKey);
}

async function migrateDisplayRows(tx: UpgradeTransaction, display: {
  get(key: IDBValidKey): Promise<LocalMessage | undefined>; put(row: LocalMessage): Promise<unknown>;
}): Promise<void> {
  const legacy = tx.objectStore("legacyMessages");
  const state = tx.objectStore("accountState");
  if (tx.db.objectStoreNames.contains("outgoingQueue")) {
    for (const outgoing of await tx.objectStore("outgoingQueue").getAll() as LocalOutgoing[]) {
      if (!outgoing.id) continue;
      if (outgoing.userId) await putOutgoing(state, outgoing);
      else {
        const id = LEGACY_OUTGOING_PREFIX + outgoing.id;
        if (!await state.get(id)) await state.put({ id, outgoing });
      }
    }
    tx.db.deleteObjectStore("outgoingQueue");
  }
  await migrateLegacyEditOutbox(state);
  const oldDeletionIndex = "history-imported-deletion:";
  await state.delete(IDBKeyRange.bound(oldDeletionIndex, oldDeletionIndex + "\uffff"));
  for (const receipt of await state.getAll(IDBKeyRange.bound(RECEIVED_PREFIX, RECEIVED_PREFIX + "\uffff")) as LocalReceiveReceipt[]) {
    if (!receipt.ownerId || !receipt.deviceId) continue;
    const wire = wireMessageId(receipt.id.slice(RECEIVED_PREFIX.length), receipt.ownerId);
    const id = receiveKey(RECEIVED_PREFIX, wire, receipt.ownerId, receipt.deviceId);
    if (id === receipt.id) continue;
    await state.put({ ...receipt, id });
    await state.delete(receipt.id);
  }
  for (const pending of await state.getAll(IDBKeyRange.bound(PENDING_RECEIVE_PREFIX, PENDING_RECEIVE_PREFIX + "\uffff"))) {
    if (!pending.userId || !pending.deviceId || !pending.frame?.id) continue;
    const id = receiveKey(PENDING_RECEIVE_PREFIX, pending.frame.id, pending.userId, pending.deviceId);
    if (id === pending.id) continue;
    await state.put({ ...pending, id });
    await state.delete(pending.id);
  }
  let cursor = await legacy.openCursor();
  while (cursor) {
    const row = cursor.value as LocalMessage;
    const outgoing = ((await state.get(LEGACY_OUTGOING_PREFIX + row.id)) ?? await state.get(outgoingKey(row.id, row.senderId)))?.outgoing as LocalOutgoing | undefined;
    const editPrefix = outgoingEditTargetPrefix(row.senderId, row.id);
    const edits = await state.getAll(IDBKeyRange.bound(editPrefix, editPrefix + "\uffff")) as { edit: OutgoingEditTarget }[];
    const ownedOutgoing = outgoing ?? edits.find(({ edit }) => edit.conversationId === row.conversationId)?.edit;
    const ownerId = row.ownerId ?? (ownedOutgoing?.conversationId === row.conversationId && ownedOutgoing.userId === row.senderId ? ownedOutgoing.userId : undefined);
    if (ownerId) {
      const wireId = row.wireId ?? wireMessageId(row.id, ownerId);
      const importedChat = await tx.objectStore("accountConversations").get(historyConversationKey(ownerId, row.conversationId));
      const direct = row.direct ?? (importedChat ? importedChat.conversation.type === "direct" : outgoing?.conversationType === "direct" || wireId.includes(":"));
      const id = logicalMessageId(wireId, direct);
      const existing = await display.get([ownerId, id]) as LocalMessage | undefined;
      if (!existing || (existing.senderId === row.senderId && existing.conversationId === row.conversationId)) {
        const next = existing && existing.deletedAt != null && row.deletedAt == null ? existing
          : preserveImportedFields({ ...row, id, wireId, direct, ownerId }, existing);
        const { deletion } = await readHistoryMessageBarriers(state, next, ownerId, direct);
        const canonical = deletion ? redactMessage(next, deletion) : next;
        if (deletion) {
          const fileId = extractFileIdFromMessage(next);
          if (fileId) await evictCachedFile(tx.objectStore("accountFiles"), fileId, ownerId);
          await unindexImportedDeletion(state, existing);
        }
        await promoteLegacyEditState(state, row.id, canonical);
        // A pre-release inline key is wrapped after password verification.
        const migrated = canonical.editKey ? canonical : withoutEditCredentials(canonical);
        await display.put(migrated);
        await indexImportedDeletion(state, canonical);
        await cursor.delete();
      }
    }
    cursor = await cursor.continue();
  }
  for (const record of await state.getAll(IDBKeyRange.bound(LEGACY_OUTGOING_PREFIX, LEGACY_OUTGOING_PREFIX + "\uffff"))) {
    if (!record.outgoing?.userId || !record.outgoing.id) continue;
    await state.put(outgoingRecord(record.outgoing));
    await state.delete(record.id);
  }
}

export function getAppDB() {
  if (!dbPromise) {
    let migrationError: unknown;
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        void tx.done.catch(() => undefined);
        const names = Array.from(db.objectStoreNames);
        const canonical = oldVersion === 6 && CANONICAL_STORES.every((name) => names.includes(name))
          && names.length === CANONICAL_STORES.length
          && hasCanonicalDisplaySchema(tx.objectStore("displayMessages"));
        const legacy = names.every((name) => LEGACY_STORES.includes(name))
          && (oldVersion < 6 || (names.includes("syncState") && (names.includes("outgoingQueue")
            || ["messages", "localKeys"].every((name) => names.includes(name)))));
        if (!canonical && !legacy) {
          migrationError = new Error("Unsupported pre-release local database layout");
          tx.abort();
          return;
        }
        let display = canonical ? tx.objectStore("displayMessages") : undefined;
        if (!canonical) {
          // Older clients can reopen without a version. Remove their writable names.
          for (const [old, next] of Object.entries(RENAMED_STORES)) {
            if (db.objectStoreNames.contains(old)) tx.objectStore(old).name = next;
            else db.createObjectStore(next, { keyPath: "id" });
          }
          if (db.objectStoreNames.contains("messages")) tx.objectStore("messages").name = "legacyMessages";
          else db.createObjectStore("legacyMessages", { keyPath: "id" });
          display = db.createObjectStore("displayMessages", { keyPath: ["ownerId", "id"] });
          display.createIndex("byId", "id");
          display.createIndex("byConversation", ["conversationId", "timestamp"]);
          display.createIndex("byAccountConversation", ["ownerId", "conversationId", "timestamp", "id"]);
          display.createIndex("byTimestamp", "timestamp");
        }
        const quarantine = tx.objectStore("legacyMessages");
        if (!quarantine.indexNames.contains("byConversation")) quarantine.createIndex("byConversation", ["conversationId", "timestamp"]);
        quarantine.createIndex("byExpiry", "quarantineExpiresAt");
        if (!oldVersion) return;
        void (async () => {
          await finishLegacyUpgradeHides(tx, canonical);
          if (!canonical) await migrateDisplayRows(tx, display!);
          await indexQuarantineExpiry(tx);
        })().catch((error) => {
          migrationError = error;
          try { tx.abort(); } catch { /* A failed request can already have aborted the upgrade. */ }
        });
      },
      blocked() { setUpgradeBlocked(true); },
      blocking(_, __, event) {
        (event.target as IDBDatabase).close();
        dbPromise = null;
      },
      terminated() { dbPromise = null; },
    }).then((db) => {
      if (db.objectStoreNames.length !== CANONICAL_STORES.length || !CANONICAL_STORES.every((name) => db.objectStoreNames.contains(name))
        || !db.transaction("legacyMessages").store.indexNames.contains("byExpiry")
        || !hasCanonicalDisplaySchema(db.transaction("displayMessages").store)) {
        db.close();
        throw new Error("Unsupported pre-release local database layout");
      }
      return db;
    }).catch((error) => {
      dbPromise = null;
      throw migrationError ?? error;
    }).finally(() => { setUpgradeBlocked(false); });
    void dbPromise.then(commitAbandonedMessageHides).catch(() => undefined);
  }
  return dbPromise;
}

export function deletionMatches(message: Pick<LocalMessage, "conversationId" | "senderId">, deletion: { conversationId?: string; senderId?: string; deletedByUserId: string }): boolean {
  return deletion.conversationId === message.conversationId && (deletion.senderId ?? deletion.deletedByUserId) === message.senderId;
}

function preserveImportedFields(incoming: LocalMessage, existing?: LocalMessage): LocalMessage {
  if (!existing || existing.conversationId !== incoming.conversationId || existing.senderId !== incoming.senderId) return incoming;
  if (incoming.ownerId && existing.ownerId && incoming.ownerId !== existing.ownerId) return incoming;
  const { importedAt, editedAt, editedByUserId, editSequence, content } = existing;
  const keepDisplayEdit = (editedAt ?? 0) > (incoming.editedAt ?? 0)
    || (editSequence ?? 0) > (incoming.editSequence ?? 0);
  return {
    ...(existing.type === incoming.type ? existing : {}), ...incoming, ...(importedAt !== undefined ? { importedAt } : {}),
    ...(existing.ownerId ? { ownerId: existing.ownerId } : {}),
    ...(existing.imported ? { imported: existing.imported } : {}),
    ...(existing.transferSourceId ? { transferSourceId: existing.transferSourceId } : {}),
    ...(existing.type === incoming.type && keepDisplayEdit ? { content, editedAt, editedByUserId, editSequence } : {}),
    ...((existing.latestEditSeq ?? 0) > (incoming.latestEditSeq ?? 0) ? { latestEditSeq: existing.latestEditSeq } : {}),
  };
}

export function redactMessage(message: LocalMessage, deletion: { deletedAt: number; deletedByUserId: string }): LocalMessage {
  return {
    id: message.id, conversationId: message.conversationId, senderId: message.senderId,
    type: message.type, content: "", timestamp: message.timestamp, status: message.status,
    expiresAt: message.expiresAt, expiryKind: message.expiryKind,
    deletedAt: deletion.deletedAt, deletedByUserId: deletion.deletedByUserId,
    direct: message.direct, wireId: message.wireId,
    ...(message.ownerId ? { ownerId: message.ownerId } : {}),
    ...(message.imported ? { imported: message.imported } : {}),
    ...(message.transferSourceId ? { transferSourceId: message.transferSourceId } : {}),
    ...(message.importedAt !== undefined ? { importedAt: message.importedAt } : {}),
  };
}

function alreadyRedacted(message: LocalMessage | undefined, deletion: { deletedAt: number; deletedByUserId: string }): boolean {
  return message?.content === "" && message.deletedAt === deletion.deletedAt && message.deletedByUserId === deletion.deletedByUserId;
}

function sameDeletion(marker: MessageDeletion | undefined, deletion: MessageDeletion, ownerId?: string): boolean {
  return !!marker && marker.ownerId === ownerId && marker.deletedAt === deletion.deletedAt
    && marker.deletedByUserId === deletion.deletedByUserId && marker.conversationId === deletion.conversationId
    && (marker.senderId ?? marker.deletedByUserId) === deletion.senderId;
}

export function historyRemovalKey(conversationId?: string, ownerId?: string): string {
  return ownerId ? `history-removal:${JSON.stringify([ownerId, conversationId ?? ""])}` : `history-removal:${conversationId ?? ""}`;
}

export const HISTORY_REMOVAL_GENERATION_KEY = "history-removal-generation";

export async function noteHistoryRemoval(state: { put(value: { id: string; revision: string }): Promise<unknown> }, conversationId?: string, ownerId?: string) {
  const revision = crypto.randomUUID();
  await state.put({ id: historyRemovalKey(conversationId, ownerId), revision });
  await state.put({ id: HISTORY_REMOVAL_GENERATION_KEY, revision });
}

export function accountMessageStorageId(ownerId: string, wireId: string): string {
  return `history-message:${JSON.stringify(ownerId)}:${wireId}`;
}

export function wireMessageId(id: string, ownerId?: string | null): string {
  const prefix = ownerId ? accountMessageStorageId(ownerId, "") : undefined;
  return prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

export function logicalMessageId(id: string, direct: boolean): string {
  return direct ? id.split(":", 1)[0] : id;
}

export function messageHideKey(id: string, ownerId?: string | null): string {
  return MESSAGE_HIDE_PREFIX + (ownerId ? accountMessageStorageId(ownerId, wireMessageId(id, ownerId)) : id);
}

interface MessageHide {
  id: string;
  messageId?: string;
  ownerId?: string;
  undoToken?: string;
  undoDeadline?: number;
  expiresAt?: number;
}

type MessageBarrierTarget = Pick<LocalMessage, "id" | "conversationId" | "senderId"> & Partial<LocalMessage>;
type HideStore = { get(key: string): Promise<MessageHide | undefined>; getAll(range: IDBKeyRange): Promise<MessageHide[]> };

export async function readMessageHide(
  state: { get(key: string): Promise<MessageHide | undefined> },
  id: string,
  ownerId?: string | null,
  row?: MessageBarrierTarget,
): Promise<MessageHide | undefined> {
  const key = messageHideKey(id, ownerId);
  const scoped = await state.get(key);
  if (scoped && (!scoped.ownerId || scoped.ownerId === ownerId)) return scoped;
  if (!ownerId) return;
  const legacy = await state.get(MESSAGE_HIDE_PREFIX + wireMessageId(id, ownerId));
  // Finalized legacy hides can outlive both the display row and any scoped receipt.
  // A row still present under the legacy key can attest to a pending hide.
  return legacy && (legacy.ownerId === ownerId || (!legacy.ownerId && (
    !legacy.undoToken || (row?.id === id && messageVisibleToAccount(row, ownerId))
  ))) ? legacy : undefined;
}

type DisplayStore = { get(key: IDBValidKey): Promise<LocalMessage | undefined>; index(name: "byId"): { get(key: IDBValidKey): Promise<LocalMessage | undefined> } };

export async function readDisplayMessage(store: DisplayStore, id: string, ownerId?: string | null, direct?: boolean): Promise<LocalMessage | undefined> {
  if (ownerId === null) return;
  const wire = wireMessageId(id, ownerId);
  const logical = logicalMessageId(wire, direct === true);
  const get = (value: string) => ownerId ? store.get([ownerId, value]) : store.index("byId").get(value);
  const exact = await get(logical) as LocalMessage | undefined;
  if (exact || direct !== undefined || !wire.includes(":")) return exact;
  const family = await get(logicalMessageId(wire, true)) as LocalMessage | undefined;
  return family?.direct ? family : undefined;
}

export function messageDeletionKey(id: string, ownerId?: string | null): string {
  return MESSAGE_DELETION_PREFIX + (ownerId ? accountMessageStorageId(ownerId, wireMessageId(id, ownerId)) : id);
}

export function messageDeletionWireId(key: string, ownerId?: string): string {
  return wireMessageId(key.slice(MESSAGE_DELETION_PREFIX.length), ownerId);
}

type DeletionMarker = MessageDeletion & { id: string };
type DeletionStore = { get(key: string): Promise<DeletionMarker | undefined>; getAll(range: IDBKeyRange): Promise<DeletionMarker[]> };

/** Resolve exact and fanout barriers before allowing plaintext to be written. */
export async function readMessageDeletion(
  store: DeletionStore,
  id: string,
  ownerId?: string | null,
  identity?: Pick<LocalMessage, "conversationId" | "senderId">,
  family = false,
): Promise<DeletionMarker | undefined> {
  const wireId = wireMessageId(id, ownerId);
  const accepts = (marker?: DeletionMarker): marker is DeletionMarker =>
    !!marker && (ownerId === undefined || marker.ownerId === ownerId || !marker.ownerId)
      && (!identity || deletionMatches(identity, marker));
  const scoped = await store.get(messageDeletionKey(wireId, ownerId));
  if (accepts(scoped)) return scoped;
  if (ownerId) {
    const legacy = await store.get(messageDeletionKey(wireId));
    if (accepts(legacy)) return legacy;
  }
  if (!family) return;
  const prefixes = ownerId ? [messageDeletionKey("", ownerId), MESSAGE_DELETION_PREFIX] : [MESSAGE_DELETION_PREFIX];
  for (const prefix of prefixes) {
    const rows = await store.getAll(messageFamilyRange(wireId, prefix));
    const matching = rows.find((marker) => accepts(marker) && sameMessageFamily(wireId, marker.id.slice(prefix.length)));
    if (matching) return matching;
  }
}

export function importedDeletionPrefix(ownerId: string): string {
  return `history-imported-deletion:${JSON.stringify(ownerId)}:`;
}

export interface ImportedDeletionCandidate {
  id: string;
  displayId: string;
  wireId: string;
  conversationId: string;
  senderId: string;
  expiresAt: number;
}

export async function indexImportedDeletion(
  state: { put(value: ImportedDeletionCandidate): Promise<unknown> },
  row: LocalMessage,
): Promise<void> {
  if (!row.ownerId || row.deletedAt != null || (row.importedAt === undefined && !row.imported)) return;
  const wireId = row.transferSourceId ?? row.wireId ?? row.id;
  if (!transferredMessageId.safeParse(wireId).success) return;
  await state.put({ id: importedDeletionPrefix(row.ownerId) + row.id, displayId: row.id,
    wireId, conversationId: row.conversationId, senderId: row.senderId,
    expiresAt: normalizeExpiryMetadata(row).expiresAt });
}

async function unindexImportedDeletion(state: { delete(id: string): Promise<void> }, row?: LocalMessage): Promise<void> {
  if (row?.ownerId && (row.transferSourceId || row.imported || row.importedAt !== undefined)) {
    await state.delete(importedDeletionPrefix(row.ownerId) + row.id);
  }
}

type DisplayTransaction = Pick<IDBPTransaction<unknown, string[], "readwrite">, "objectStore">;

/** Sync, edits, outbox, and transfer all use this display transaction. Receipts are separate. */
export async function mergeDisplayMessage(
  tx: DisplayTransaction, message: LocalMessage, options: { imported?: boolean; received?: boolean; now?: number; finalizeHide?: boolean; editing?: boolean;
    wrappedEditState?: LocalEditState; editKeyResetToken?: string | null; editKeyAccepted?: boolean } = {},
): Promise<{ row?: LocalMessage; changed: boolean; hidden: boolean; replaced?: boolean; added?: boolean }> {
  const { ownerId } = message;
  if (!ownerId) return { changed: false, hidden: false };
  const messages = tx.objectStore("displayMessages"), state = tx.objectStore("accountState");
  const existing = await readDisplayMessage(messages, message.id, ownerId, message.direct);
  const direct = message.direct ?? existing?.direct ?? false;
  const wireId = wireMessageId(message.wireId ?? existing?.wireId ?? message.id, ownerId);
  const id = logicalMessageId(wireMessageId(message.id, ownerId), direct);
  if (existing && (existing.conversationId !== message.conversationId || existing.senderId !== message.senderId)) return { changed: false, hidden: false };
  const incoming = withoutEditCredentials({ ...message, id, wireId, direct });
  if (options.finalizeHide) {
    const fileId = existing && extractFileIdFromMessage(existing);
    if (fileId) await evictCachedFile(tx.objectStore("accountFiles"), fileId, ownerId);
    await unindexImportedDeletion(state, existing);
    await state.delete(editStateKey(id, ownerId));
    await messages.delete([ownerId, id]);
    return { changed: !!existing, hidden: true };
  }
  const { hidden, deletion } = await readHistoryMessageBarriers(state, incoming, ownerId, direct);
  const barrier = deletion ?? (existing?.deletedAt != null ? { deletedAt: existing.deletedAt, deletedByUserId: existing.deletedByUserId ?? existing.senderId } : undefined);
  if (barrier) {
    await state.delete(editStateKey(id, ownerId));
    await retireEditsForMessage(state, id, ownerId, incoming);
    // A pending hide keeps the Undo row redacted. A finalized hide needs no row.
    if (hidden && !existing) return { changed: false, hidden };
    if (alreadyRedacted(existing, barrier)) return { row: existing, changed: false, hidden };
    for (const fileId of new Set([extractFileIdFromMessage(incoming), existing && extractFileIdFromMessage(existing)])) {
      if (fileId) await evictCachedFile(tx.objectStore("accountFiles"), fileId, ownerId);
    }
    await noteHistoryRemoval(state, incoming.conversationId, ownerId);
    await unindexImportedDeletion(state, existing);
    const row = redactMessage(existing ?? incoming, barrier);
    await messages.put(row);
    return { row, changed: true, hidden };
  }
  if (hidden && !options.editing) return { changed: false, hidden };
  if (options.imported) {
    const now = options.now ?? Date.now();
    if (await state.get(outgoingKey(id, ownerId))) return { changed: false, hidden };
    if (normalizeExpiryMetadata(incoming).expiresAt <= now || incoming.status === "failed"
      || (existing && normalizeExpiryMetadata(existing).expiresAt <= now)) return { changed: false, hidden };
    if (existing && !(existing.status === "failed" && !existing.content)) {
      if (existing.type !== incoming.type || isSticker(existing) !== isSticker(incoming) || (incoming.editedAt ?? 0) <= (existing.editedAt ?? 0)) return { row: existing, changed: false, hidden };
      // Preserve live receive metadata, local edit credentials, and original expiry.
      const row = { ...existing, content: incoming.content, editedAt: incoming.editedAt, editedByUserId: incoming.editedByUserId,
        imported: incoming.imported ?? existing.imported, transferSourceId: incoming.transferSourceId };
      await noteHistoryRemoval(state, row.conversationId, ownerId);
      await messages.put(row);
      await indexImportedDeletion(state, row);
      return { row, changed: true, hidden };
    }
  } else if (options.received && existing && incoming.status === "failed" && existing.content) {
    return { row: existing, changed: false, hidden };
  }
  const row = withoutEditCredentials(options.imported ? incoming
    : options.editing ? incoming : preserveImportedFields(incoming, existing));
  if (row.type !== "text" || isSticker(row)) {
    if (existing?.type === "text") {
      await state.delete(editStateKey(id, ownerId));
      await retireEditsForMessage(state, id, ownerId, row);
    }
  } else {
    const saved = existing && await readEditState(state, existing);
    const resetMatches = options.editKeyResetToken === undefined
      || options.editKeyResetToken === ((await state.get(EDIT_KEY_RESET_ID))?.token ?? null);
    const wrapped = resetMatches ? options.wrappedEditState : undefined;
    if (wrapped && !saved) {
      await state.put({ ...wrapped, aadId: wrapped.aadId ?? wrapped.id, id: editStateKey(id, ownerId) });
    } else if (saved && options.editKeyAccepted !== undefined) {
      if (options.editKeyAccepted) await state.put({ ...saved, editKeyAccepted: true });
      else {
        await state.delete(saved.id);
        await retireEditsForMessage(state, id, ownerId, row);
      }
    }
  }
  if (options.editing && (existing?.content !== row.content || existing?.editedAt !== row.editedAt)) {
    await noteHistoryRemoval(state, row.conversationId, ownerId);
  }
  await messages.put(row);
  await indexImportedDeletion(state, row);
  return { row, changed: true, hidden, replaced: !!existing, added: options.imported };
}

export async function saveMessage(message: LocalMessage, current: () => boolean = () => true, ownerId = message.ownerId) {
  const editKeyResetToken = message.editKey ? await getEditKeyResetToken() : undefined;
  const wrappedEditState = await prepareEditState({ ...message, ownerId });
  const db = await getAppDB();
  if (!current()) return;
  const tx = db.transaction(["displayMessages", "accountState", "accountFiles"], "readwrite");
  if (current()) await mergeDisplayMessage(tx, { ...message, ownerId }, { wrappedEditState, editKeyResetToken });
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return; }
  await tx.done;
}

export async function reconcileMessageEditKey(frame: Pick<WSMessageFrame, "id" | "conversationId" | "senderId" | "senderDeviceId">, accepted: boolean, current: () => boolean, ownerId: string): Promise<boolean> {
  const tx = (await getAppDB()).transaction(["displayMessages", "accountState"], "readwrite");
  const messages = tx.objectStore("displayMessages"), state = tx.objectStore("accountState");
  const row = await readDisplayMessage(messages, frame.id, ownerId);
  const edits = row && await readEditState(state, row);
  if (!current() || !row || !edits || edits.senderId !== frame.senderId || edits.conversationId !== frame.conversationId
    || edits.editSenderDeviceId !== frame.senderDeviceId || accepted && edits.editKeyAccepted) {
    await tx.done;
    return false;
  }
  if (accepted) await state.put({ ...edits, editKeyAccepted: true });
  else {
    await state.delete(edits.id);
    await retireEditsForMessage(state, row.id, ownerId, row);
  }
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return false; }
  await tx.done;
  publishLocalMessageChange(row.id, "edit", frame.conversationId);
  return true;
}

export interface CachedMessageCursor { timestamp: number; id: string }
export interface CachedMessagePage { messages: LocalMessage[]; suppressedIds: string[]; hasOlder: boolean; oldestCursor?: CachedMessageCursor }

export function historyConversationKey(ownerId: string, conversationId: string): string {
  return `history:${JSON.stringify([ownerId, conversationId])}`;
}

/** Apply the same account, wire alias, and fanout barriers in every history snapshot. */
export async function readHistoryMessageBarriers(
  state: DeletionStore & HideStore,
  row: MessageBarrierTarget,
  ownerId: string | undefined,
  direct: boolean,
): Promise<{ hidden: boolean; deletion?: MessageDeletion }> {
  let hidden = false;
  let deletion: MessageDeletion | undefined;
  for (const id of new Set([row.id, row.wireId, row.transferSourceId])) {
    if (!id) continue;
    hidden ||= !!await readMessageHide(state, id, ownerId, row);
    deletion ??= await readMessageDeletion(state, id, ownerId, row, direct);
  }
  hidden ||= direct && await hasMessageFamilyHide(state, row.id, ownerId);
  if (!deletion && row.deletedAt != null) deletion = { conversationId: row.conversationId, senderId: row.senderId,
    deletedAt: row.deletedAt, deletedByUserId: row.deletedByUserId ?? row.senderId };
  return { hidden, deletion };
}

async function readConversationMessagePage(
  conversationId: string,
  limit: number,
  before?: number | CachedMessageCursor,
  ownerId?: string | null,
  knownDirect?: boolean,
): Promise<CachedMessagePage> {
  const db = await getAppDB();
  const tx = db.transaction(["displayMessages", "accountState", "accountConversations"], "readonly");
  const store = tx.objectStore("displayMessages"), state = tx.objectStore("accountState");
  const index = store.index("byConversation");
  const queuedIds = await queuedMessageIds(state, ownerId ?? undefined);
  const direct = knownDirect ?? (!!ownerId && (await tx.objectStore("accountConversations").get(historyConversationKey(ownerId, conversationId)))?.conversation.type === "direct");
  const upperBound = before === undefined
    ? [conversationId, Number.MAX_SAFE_INTEGER]
    : [conversationId, typeof before === "number" ? Math.max(0, before - 1) : before.timestamp];
  const range = IDBKeyRange.bound([conversationId, 0], upperBound);
  const page: Awaited<ReturnType<typeof readEditSnapshot>>[] = [];
  const suppressedIds: string[] = [];
  const now = Date.now();

  let cursor = await index.openCursor(range, "prev");
  while (cursor && page.length < limit + 1) {
    const row = cursor.value as LocalMessage;
    const atOrAfterCursor = typeof before === "object" && row.timestamp === before.timestamp && row.id >= before.id;
    if (!atOrAfterCursor && (ownerId === undefined || messageVisibleToAccount(row, ownerId))) {
      const owner = ownerId ?? row.ownerId;
      const { hidden, deletion } = await readHistoryMessageBarriers(state, row, owner, knownDirect ?? row.direct ?? direct);
      if (hidden) {
        suppressedIds.push(row.id);
      } else if (normalizeExpiryMetadata(row).expiresAt > now || isQueuedMessage(queuedIds, row)) {
        page.push(await readEditSnapshot(state, { ...(deletion ? redactMessage(row, deletion) : row), hasOutgoingEntry: isQueuedMessage(queuedIds, row) }));
      }
    }
    cursor = await cursor.continue();
  }

  await tx.done;

  const messages = await Promise.all(page.slice(0, limit).reverse().map((snapshot) => restoreEditSnapshot(snapshot)));
  return {
    messages,
    suppressedIds,
    hasOlder: page.length > limit,
    oldestCursor: messages[0] ? { timestamp: messages[0].timestamp, id: messages[0].id } : undefined,
  };
}

export async function getMessages(conversationId: string, limit = 100, ownerId?: string): Promise<LocalMessage[]> {
  const page = await readConversationMessagePage(conversationId, limit, undefined, ownerId);
  return page.messages;
}

export async function getCachedConversationMessagesPage(
  conversationId: string,
  options?: { before?: number | CachedMessageCursor; limit?: number; ownerId?: string | null; direct?: boolean },
): Promise<CachedMessagePage> {
  return readConversationMessagePage(conversationId, options?.limit ?? 100, options?.before, options?.ownerId, options?.direct);
}

export async function getLatestCachedMessageTimestamp(ownerId?: string | null): Promise<number> {
  const db = await getAppDB();
  const tx = db.transaction("displayMessages", "readonly");
  const index = tx.store.index("byTimestamp");
  let cursor = await index.openCursor(null, "prev");
  // Imported display rows are independent of this device's encrypted receive cursor.
  while (cursor) {
    const row = cursor.value as LocalMessage;
    if (row.importedAt === undefined && (ownerId === undefined || messageVisibleToAccount(row, ownerId))) break;
    cursor = await cursor.continue();
  }
  await tx.done;
  return cursor ? (cursor.value as LocalMessage).timestamp : 0;
}

export async function saveSyncState(id: string, value: number, cursorId?: string): Promise<void> {
  const db = await getAppDB();
  await db.put("accountState", {
    id,
    value,
    cursorId,
    updatedAt: Date.now(),
  } satisfies LocalSyncState);
}

/** Multiple tabs may finish sync concurrently; an older result cannot regress this cursor. */
export async function advanceMutationCursor(id: string, value: number): Promise<void> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const previous = await tx.store.get(id);
  if (!previous || previous.value < value) await tx.store.put({ id, value, updatedAt: Date.now() });
  await tx.done;
}

export async function getSyncState(id: string): Promise<LocalSyncState | undefined> {
  const db = await getAppDB();
  return db.get("accountState", id);
}

interface EditLookupJob { id: string; messageId: string; revision: string }
interface EditRepairMarker extends Pick<MessageEditFrame, "conversationId" | "senderId" | "senderDeviceId" | "expiresAt"> { id: string }
interface EditLookupRate { id: string; nextAt: number; failures: number; lease?: string }
export interface EditHistoryCheckpoint { id: string; previous?: LocalSyncState; next?: CachedMessageCursor }
type EditLookupOutcome = "success" | "failure" | "rate-limited" | "unavailable" | "paused";

const editLookupPrefix = (scope: string) => `edit-lookup:${scope}:`;
const editLookupRange = (scope: string) => IDBKeyRange.bound(editLookupPrefix(scope), `${editLookupPrefix(scope)}\uffff`);
const editLookupRateId = (scope: string) => `edit-lookup-rate:${scope}`;
const editRepairId = (scope: string, messageId: string) => `${EDIT_REPAIR_PREFIX}${scope}:${messageId}`;
const EDIT_LOOKUP_RETRY_DELAYS = [2_000, 5_000, 15_000, 60_000];

function putEditLookup(store: OutgoingStore, scope: string, messageId: string) {
  return store.put({ id: editLookupPrefix(scope) + messageId, messageId, revision: crypto.randomUUID() } satisfies EditLookupJob);
}

/** Persist IDs only. Advance a history bookmark in the same transaction as its queued checks. */
export async function queueEditLookups(scope: string, ids: string[], current: () => boolean, checkpoint?: EditHistoryCheckpoint): Promise<boolean> {
  const db = await getAppDB();
  if (!current()) return false;
  const tx = db.transaction("accountState", "readwrite");
  if (checkpoint) {
    const saved = await tx.store.get(checkpoint.id) as LocalSyncState | undefined;
    const previous = checkpoint.previous;
    if (saved?.updatedAt !== previous?.updatedAt || saved?.value !== previous?.value || saved?.cursorId !== previous?.cursorId) {
      await tx.done;
      return false;
    }
  }
  for (const messageId of new Set(ids)) {
    await putEditLookup(tx.store, scope, messageId);
  }
  if (checkpoint) await tx.store.put({ id: checkpoint.id, value: checkpoint.next?.timestamp ?? 0,
    cursorId: checkpoint.next?.id, updatedAt: Date.now() } satisfies LocalSyncState);
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return false; }
  await tx.done;
  return true;
}

export async function hasEditLookups(scope: string): Promise<boolean> {
  return (await (await getAppDB()).getKey("accountState", editLookupRange(scope))) !== undefined;
}

/** Claim one batch atomically so tabs on the same device share the request budget. */
export async function claimEditLookups(scope: string, limit: number, current: () => boolean): Promise<
  { jobs: EditLookupJob[]; lease: string } | { nextAt: number } | undefined
> {
  const db = await getAppDB();
  if (!current()) return;
  const tx = db.transaction("accountState", "readwrite");
  const jobs = await tx.store.getAll(editLookupRange(scope), limit) as EditLookupJob[];
  const rateId = editLookupRateId(scope);
  const rate = await tx.store.get(rateId) as EditLookupRate | undefined;
  const now = Date.now();
  if (!current() || !jobs.length) { await tx.done; return; }
  if (rate && rate.nextAt > now) { await tx.done; return { nextAt: rate.nextAt }; }
  const lease = crypto.randomUUID();
  // A closed tab leaves work available again after its reservation expires.
  await tx.store.put({ id: rateId, failures: rate?.failures ?? 0, nextAt: now + 60_000, lease } satisfies EditLookupRate);
  await tx.done;
  return { jobs, lease };
}

export async function finishEditLookups(scope: string, claim: { jobs: EditLookupJob[]; lease: string }, outcome: EditLookupOutcome): Promise<number | undefined> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const id = editLookupRateId(scope);
  const rate = await tx.store.get(id) as EditLookupRate | undefined;
  if (rate?.lease !== claim.lease) { await tx.done; return rate?.nextAt; }
  if (outcome === "success") {
    for (const job of claim.jobs) {
      if ((await tx.store.get(job.id))?.revision === job.revision) await tx.store.delete(job.id);
    }
  }
  const failures = outcome === "failure" ? rate.failures + 1 : 0;
  const delay = outcome === "rate-limited" || outcome === "unavailable" ? 60_000
    : EDIT_LOOKUP_RETRY_DELAYS[Math.min(Math.max(0, failures - 1), EDIT_LOOKUP_RETRY_DELAYS.length - 1)];
  const nextAt = Date.now() + delay;
  await tx.store.put({ id, failures, nextAt } satisfies EditLookupRate);
  const pending = await tx.store.getKey(editLookupRange(scope));
  await tx.done;
  return pending === undefined ? undefined : nextAt;
}

export async function saveSession(session: LocalSession) {
  const db = await getAppDB();
  await db.put("receiveSessions", session);
}

export async function getSession(id: string): Promise<LocalSession | undefined> {
  const db = await getAppDB();
  return db.get("receiveSessions", id);
}

export interface LocalSenderKey {
  id: string;
  senderKeyId: number;
  chainKey: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  chainIndex: number;
}

export async function getSenderKey(id: string): Promise<LocalSenderKey | undefined> {
  const db = await getAppDB();
  return db.get("receiveSenderKeys", id);
}

export async function saveSenderKey(key: LocalSenderKey): Promise<void> {
  const db = await getAppDB();
  await db.put("receiveSenderKeys", key);
}

export interface ReceiveEffects {
  editKeyResetToken?: string | null;
  editRepairScope?: string;
  deviceId?: string;
  direct?: boolean;
  ownerId?: string;
  failure?: "invalid_sender_key_distribution" | "terminal_receive_error";
  expiresAt: number | null;
  message?: LocalMessage;
  senderKey?: LocalSenderKey;
  pendingCall?: LocalPendingCall;
}

function editMessage(message: LocalMessage, edit: { content: string; editedAt: number; editSeq: number }): LocalMessage {
  if ((message.editSequence ?? 0) >= edit.editSeq) return message;
  const display = (message.editedAt ?? 0) > edit.editedAt && message.importedAt !== undefined
    ? {} : { content: edit.content, editedAt: edit.editedAt, editedByUserId: message.senderId };
  return { ...message, ...display, editSequence: edit.editSeq,
    latestEditSeq: Math.max(edit.editSeq, message.latestEditSeq ?? 0) };
}

function assertCurrentEdit(current: () => boolean) {
  if (!current()) throw new DOMException("Edit session changed", "AbortError");
}

const lockedEditPrefix = (scope: string) => `${LOCKED_EDIT_PREFIX}${scope}:`;

export async function queueLockedEdit(scope: string, edit: MessageEditFrame, current: () => boolean) {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  // Retain each candidate until it authenticates or the original supersedes it.
  const id = lockedEditPrefix(scope) + edit.messageId + ":" + String(edit.editSeq).padStart(16, "0");
  const existing = await tx.store.get(id);
  if (current() && !existing) {
    const { senderId, senderDeviceId, editedAt, expiresAt, mutationSeq } = edit;
    await tx.store.put({ id, edit: { ...editEnvelope(edit), senderId, senderDeviceId, editedAt, expiresAt, mutationSeq } });
  }
  await tx.done;
}

export async function lockedEditIds(scope: string, messageIds?: ReadonlySet<string>): Promise<IDBValidKey[]> {
  const prefix = lockedEditPrefix(scope);
  const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  const db = await getAppDB();
  if (!messageIds) return (await db.getAllKeys("accountState", range)).reverse();
  if (!messageIds.size) return [];
  const tx = db.transaction("accountState");
  if (await tx.store.getKey(range) === undefined) return [];
  const keys = await Promise.all([...messageIds].map(async (messageId) => {
    const key = prefix + messageId;
    const [revisions, legacyKey] = await Promise.all([
      tx.store.getAllKeys(IDBKeyRange.bound(key + ":", key + ":\uffff")),
      tx.store.getKey(key),
    ]);
    revisions.reverse();
    if (legacyKey !== undefined) revisions.push(legacyKey);
    return revisions;
  }));
  await tx.done;
  return keys.flat();
}

export async function readLockedEdit(id: IDBValidKey): Promise<MessageEditFrame | undefined> {
  return (await (await getAppDB()).get("accountState", id))?.edit;
}

export async function finishLockedEdit(id: IDBValidKey, edit: MessageEditFrame, ownerId: string, deviceId: string, current: () => boolean, invalid: boolean) {
  const tx = (await getAppDB()).transaction(["displayMessages", "accountState"], "readwrite");
  const state = tx.objectStore("accountState");
  const queued = await state.get(id);
  if (queued?.edit?.mutationSeq !== edit.mutationSeq || !current()) { await tx.done; return; }
  const row = await readDisplayMessage(tx.objectStore("displayMessages"), edit.messageId, ownerId);
  const finished = invalid || edit.expiresAt <= Date.now() ||
    await originalBlocksEdit(state, edit, row, ownerId, deviceId);
  if (finished && current()) await state.delete(id);
  await tx.done;
}

async function originalBlocksEdit(
  state: DeletionStore & HideStore, edit: MessageEditFrame, row: LocalMessage | undefined, ownerId: string, deviceId: string,
): Promise<boolean> {
  for (const id of new Set([edit.messageId, `${edit.messageId}:${deviceId}`, row?.wireId])) {
    if (!id) continue;
    if (permanentHide(await readMessageHide(state, id, ownerId, row))
      || await readMessageDeletion(state, id, ownerId, edit, !!row?.direct)) return true;
  }
  if (row?.conversationId !== edit.conversationId || row.senderId !== edit.senderId) return false;
  const edits = await readEditState(state, row);
  return normalizeExpiryMetadata(row).expiresAt <= Date.now()
    || (!!edits && (edits.editSenderDeviceId !== edit.senderDeviceId || edits.editSequence >= edit.editSeq));
}

/** Resolve the account's canonical original or atomically mark a missing key for repair. */
export async function getOriginalForEdit(edit: MessageEditFrame, ownerId: string, deviceId: string, current: () => boolean, repairScope?: string): Promise<LocalMessage | undefined> {
  const db = await getAppDB();
  assertCurrentEdit(current);
  const tx = db.transaction(["displayMessages", "accountState"], "readwrite");
  const state = tx.objectStore("accountState");
  const row = await readDisplayMessage(tx.objectStore("displayMessages"), edit.messageId, ownerId);
  const original = row?.conversationId === edit.conversationId && row.senderId === edit.senderId ? row : undefined;
  const edits = original && await readEditState(state, original);
  if (repairScope && !edits && !await originalBlocksEdit(state, edit, original, ownerId, deviceId)) {
    const wireId = `${edit.messageId}:${deviceId}`;
    const received = await readReceiveReceipt(state, edit.messageId, ownerId, deviceId)
      || await readReceiveReceipt(state, wireId, ownerId, deviceId);
    if (!received && (!original || original.importedAt !== undefined) && current()) {
      const { conversationId, senderId, senderDeviceId, expiresAt } = edit;
      await state.put({ id: editRepairId(repairScope, edit.messageId), conversationId, senderId, senderDeviceId, expiresAt } satisfies EditRepairMarker);
    }
  }
  await tx.done;
  assertCurrentEdit(current);
  if (!original || !edits?.editKeyAccepted || edits.editSenderDeviceId !== edit.senderDeviceId) return;
  const record = { ...withoutEditCredentials(original), ...editCredentials(edits), editSequence: edits.editSequence };
  if (edits.editSequence >= edit.editSeq) return record;
  const key = await openEditKey(edits);
  assertCurrentEdit(current);
  return key ? { ...record, editKey: key, editKeyVersion: edits.wrappedKey.iv, editSigningKey: edits.editSigningKey } : undefined;
}

export async function applyReceivedEdit(edit: MessageEditFrame, original: LocalMessage, content: string, current: () => boolean) {
  if (isSticker({ type: "text", content })) return "invalid" as const;
  if (!original.ownerId) return;
  const db = await getAppDB();
  assertCurrentEdit(current);
  const tx = db.transaction(["displayMessages", "accountState", "accountFiles"], "readwrite");
  const state = tx.objectStore("accountState");
  try {
    const existing = await readDisplayMessage(tx.objectStore("displayMessages"), original.id, original.ownerId);
    const edits = existing && await readEditState(state, existing);
    let updated: LocalMessage | undefined;
    if (existing && edits?.editKeyAccepted && !await originalBlocksEdit(state, edit, existing, original.ownerId, "")
      && edits.wrappedKey.iv === original.editKeyVersion && edits.editSigningKey === original.editSigningKey
      && edits.editSenderDeviceId === edit.senderDeviceId && existing.conversationId === edit.conversationId
      && existing.senderId === edit.senderId && edits.editSequence < edit.editSeq) {
      const result = await mergeDisplayMessage(tx, editMessage(existing, { content, editedAt: edit.editedAt, editSeq: edit.editSeq }), { editing: true });
      if (result.row && !result.row.deletedAt) {
        updated = result.row;
        await state.put({ ...edits, editSequence: edit.editSeq, editedAt: edit.editedAt, envelope: editEnvelope(edit), pendingId: undefined });
      }
    }
    assertCurrentEdit(current);
    await tx.done;
    if (updated) publishLocalMessageChange(updated.id, "edit", updated.conversationId);
    return updated;
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished. */ }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

export interface LocalReceiveReceipt {
  deviceId?: string;
  id: string;
  ownerId?: string;
  expiresAt: number | null;
  failure?: ReceiveEffects["failure"];
  hidden?: true;
  pendingCallId?: string;
}

export const RECEIVED_PREFIX = "received:";
const PENDING_RECEIVE_PREFIX = "pending-receive:";

export function receiveKey(prefix: string, id: string, ownerId?: string, deviceId?: string): string {
  return prefix + JSON.stringify([ownerId, deviceId, id]);
}

async function readReceiveReceipt(
  store: { get(id: string): Promise<LocalReceiveReceipt | undefined> },
  id: string,
  ownerId?: string,
  deviceId?: string,
): Promise<LocalReceiveReceipt | undefined> {
  return store.get(receiveKey(RECEIVED_PREFIX, id, ownerId, deviceId));
}

export async function getReceiveReceipt(id: string, ownerId?: string, deviceId?: string): Promise<LocalReceiveReceipt | undefined> {
  return readReceiveReceipt((await getAppDB()).transaction("accountState").store, id, ownerId, deviceId);
}

async function deletePendingReceive(
  store: { getAll(range: IDBKeyRange): Promise<{ id: string; userId?: string; deviceId?: string; frame: WSMessageFrame }[]>;
    delete(id: string): Promise<void> },
  id: string,
  ownerId?: string,
  deviceId?: string,
): Promise<void> {
  if (deviceId) {
    await store.delete(receiveKey(PENDING_RECEIVE_PREFIX, id, ownerId, deviceId));
  } else {
    const prefix = PENDING_RECEIVE_PREFIX + JSON.stringify([ownerId ?? null]).slice(0, -1) + ",";
    const pending = await store.getAll(IDBKeyRange.bound(prefix, prefix + "\uffff"));
    for (const row of pending) if (row.userId === ownerId && row.frame.id === id) await store.delete(row.id);
  }
}

/** Missing group keys defer encrypted envelopes while their ratchet is pending. */
export async function savePendingReceive(frame: WSMessageFrame, userId: string | undefined, deviceId: string | undefined): Promise<void> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  if (!await readReceiveReceipt(tx.store, frame.id, userId, deviceId)) {
    await tx.store.put({ id: receiveKey(PENDING_RECEIVE_PREFIX, frame.id, userId, deviceId), userId, deviceId, frame });
  }
  await tx.done;
}

export async function getPendingReceives(userId: string | undefined, deviceId: string | undefined): Promise<WSMessageFrame[]> {
  const db = await getAppDB();
  const records = await db.getAll("accountState", IDBKeyRange.bound(PENDING_RECEIVE_PREFIX, `${PENDING_RECEIVE_PREFIX}\uffff`));
  const frames = new Map<string, WSMessageFrame>();
  for (const record of records) {
    if (record.userId === userId && record.deviceId === deviceId) frames.set(record.frame.id, record.frame);
  }
  return [...frames.values()];
}

export async function hasReceivedMessage(id: string, ownerId?: string, deviceId?: string): Promise<boolean> {
  return !!await getReceiveReceipt(id, ownerId, deviceId);
}

/** All crypto must finish before entering this transaction: only IDB awaits belong here. */
export async function commitReceivedMessage(
  id: string,
  effects: ReceiveEffects,
  state: { session?: LocalSession; senderKey?: LocalSenderKey } = {},
): Promise<boolean> {
  const wrappedEditState = effects.message && await prepareEditState({ ...effects.message, ownerId: effects.ownerId });
  const db = await getAppDB();
  const tx = db.transaction(["displayMessages", "receiveSessions", "receiveSenderKeys", "receivePendingCalls", "accountState", "accountFiles"], "readwrite");
  // Observe aborts even when an individual request rejects first.
  const done = tx.done;
  void done.catch(() => undefined);
  try {
    const { ownerId, deviceId, message } = effects;
    const store = tx.objectStore("accountState");
    if (await readReceiveReceipt(store, id, ownerId, deviceId)) {
      await deletePendingReceive(store, id, ownerId, deviceId);
      await done;
      return false;
    }
    const pending = await store.get(receiveKey(PENDING_RECEIVE_PREFIX, id, ownerId, deviceId));
    await deletePendingReceive(store, id, ownerId, deviceId);
    if (state.session) await tx.objectStore("receiveSessions").put(state.session);
    if (state.senderKey) await tx.objectStore("receiveSenderKeys").put(state.senderKey);
    if (effects.senderKey && !await tx.objectStore("receiveSenderKeys").get(effects.senderKey.id)) {
      await tx.objectStore("receiveSenderKeys").put(effects.senderKey);
    }
    if (effects.pendingCall) await tx.objectStore("receivePendingCalls").put(effects.pendingCall);
    const result = message && await mergeDisplayMessage(tx, {
      ...message, ownerId, wireId: id, direct: effects.direct ?? id.includes(":"),
    }, { received: true, wrappedEditState, editKeyResetToken: effects.editKeyResetToken });
    if (result?.row && deviceId && ownerId) {
      const saved = await readEditState(store, result.row);
      const scope = effects.editRepairScope ?? `${ownerId}:${deviceId}`;
      if (saved?.editKeyAccepted) {
        const repairId = editRepairId(scope, result.row.id);
        const repair = await store.get(repairId) as EditRepairMarker | undefined;
        const matches = repair?.conversationId === saved.conversationId && repair.senderId === saved.senderId
          && repair.senderDeviceId === saved.editSenderDeviceId;
        if (matches) await store.delete(repairId);
        if ((matches && repair.expiresAt > Date.now()) || pending) await putEditLookup(store, scope, result.row.id);
      }
    }
    await store.put({
      id: receiveKey(RECEIVED_PREFIX, id, ownerId, deviceId), expiresAt: effects.expiresAt, ownerId, deviceId,
      ...(effects.failure ? { failure: effects.failure } : {}),
      ...(result?.hidden ? { hidden: true } : {}),
      ...(effects.pendingCall ? { pendingCallId: effects.pendingCall.id } : {}),
    } satisfies LocalReceiveReceipt);
    await done;
    return true;
  } catch (error) {
    try { tx.abort(); } catch { /* Already aborted/committed. */ }
    await done.catch(() => undefined);
    throw error;
  }
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getAppDB();
  await db.delete("receiveSessions", id);
}

export async function saveKey(key: LocalKey) {
  const db = await getAppDB();
  await db.put("deviceKeys", key);
}

export async function getKey(id: string): Promise<LocalKey | undefined> {
  const db = await getAppDB();
  return db.get("deviceKeys", id);
}

export interface PendingSetupRecord {
  id: "setup:pending";
  setupId: string;
  bundleHash: string;
  deviceId?: string;
  stage: "prepared" | "provisioned" | "unlockReady" | "complete";
  backupPending?: "passkey" | "native" | false;
  createdAt: number;
}

export async function readPendingSetupRecord(): Promise<PendingSetupRecord | undefined> {
  return (await getAppDB()).get("accountState", "setup:pending");
}

export function matchesPendingSetup(current: PendingSetupRecord | undefined, expected: PendingSetupRecord): boolean {
  return current?.setupId === expected.setupId && current.deviceId === expected.deviceId &&
    current.bundleHash === expected.bundleHash && current.stage === expected.stage &&
    current.backupPending === expected.backupPending && current.createdAt === expected.createdAt;
}

const SETUP_LEASE_ID = "setup:lease";

export async function claimPasskeySetupLease(owner: string, duration: number, renew = false): Promise<boolean> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const lease = await tx.store.get(SETUP_LEASE_ID) as { owner: string; expiresAt: number } | undefined;
  const now = Date.now();
  const allowed = lease?.owner === owner || (!renew && (!lease || lease.expiresAt <= now));
  if (allowed) await tx.store.put({ id: SETUP_LEASE_ID, owner, expiresAt: now + duration });
  await tx.done;
  return allowed;
}

export async function releasePasskeySetupLease(owner: string): Promise<void> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  if ((await tx.store.get(SETUP_LEASE_ID))?.owner === owner) await tx.store.delete(SETUP_LEASE_ID);
  await tx.done;
}

export async function updatePendingSetupRecord(
  record: PendingSetupRecord | undefined, expected?: string | PendingSetupRecord, assertCurrent?: () => void,
): Promise<boolean> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const current = await tx.store.get("setup:pending") as PendingSetupRecord | undefined;
  if (typeof expected === "object" ? !matchesPendingSetup(current, expected) : current?.setupId !== expected) {
    await tx.done;
    return false;
  }
  assertCurrent?.();
  if (record) await tx.store.put(record);
  else await tx.store.delete("setup:pending");
  await tx.done;
  return true;
}

type ExpectedLocalKey = { id: string; type?: string; data?: string };

async function localKeysMatch(
  store: { get(id: string): Promise<LocalKey | undefined> },
  expected: ExpectedLocalKey[],
): Promise<boolean> {
  const current = await Promise.all(expected.map(({ id }) => store.get(id)));
  return expected.every(({ type, data }, i) => current[i]?.type === type && current[i]?.data === data);
}

export async function saveKeys(
  keys: LocalKey[],
  expected: ExpectedLocalKey[] = [],
  setup?: PendingSetupRecord,
  assertCurrent?: () => void,
  nativeEnrollmentId?: string,
): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction(["deviceKeys", "accountState"], "readwrite");
  const keysStore = tx.objectStore("deviceKeys");
  const syncStore = tx.objectStore("accountState");
  if (setup && (await syncStore.get(setup.id))?.setupId !== setup.setupId) {
    await tx.done;
    throw new Error("Device setup changed");
  }
  if (expected.length && !await localKeysMatch(keysStore, expected)) {
    await tx.done;
    throw new Error("Local keys changed in another session");
  }
  const cleanupId = nativeEnrollmentId && NATIVE_REMOVAL_PREFIX + nativeEnrollmentId;
  if (cleanupId && !await syncStore.getKey(cleanupId)) {
    await tx.done;
    throw new Error("Native unlock enrollment changed");
  }
  assertCurrent?.();
  await Promise.all([...keys.map((key) => keysStore.put(key)), ...(setup ? [syncStore.put(setup)] : []),
    ...(cleanupId ? [syncStore.delete(cleanupId)] : []), tx.done]);
}

export function sameLocalKey(a: LocalKey | undefined, b: LocalKey | undefined): boolean {
  return a?.id === b?.id && a?.type === b?.type && a?.data === b?.data;
}

const NATIVE_REMOVAL_PREFIX = "native-unlock:remove:";

function nativeRemovalRange() {
  return IDBKeyRange.bound(NATIVE_REMOVAL_PREFIX, `${NATIVE_REMOVAL_PREFIX}\uffff`);
}

export async function pendingResetNativeKeyIds(): Promise<string[]> {
  const keys = await (await getAppDB()).getAllKeys("accountState", nativeRemovalRange());
  return keys.map(id => String(id).slice(NATIVE_REMOVAL_PREFIX.length));
}

export async function clearResetNativeKeyId(keyId: string): Promise<void> {
  await (await getAppDB()).delete("accountState", NATIVE_REMOVAL_PREFIX + keyId);
}

export async function recordNativeKeyCleanup(keyId: string): Promise<void> {
  await (await getAppDB()).add("accountState", { id: NATIVE_REMOVAL_PREFIX + keyId });
}

export async function hasNativeKeyCleanup(keyId: string): Promise<boolean> {
  return !!(await (await getAppDB()).getKey("accountState", NATIVE_REMOVAL_PREFIX + keyId));
}

type NativeKeyForCleanup = (record: LocalKey | undefined) => string | undefined;

export async function clearAll(expectedKey?: LocalKey, beforeClear?: () => void, nativeKeyForCleanup?: NativeKeyForCleanup): Promise<boolean> {
  const db = await getAppDB();
  const stores = Array.from(db.objectStoreNames);
  const tx = db.transaction(stores, "readwrite");
  if (expectedKey && !sameLocalKey(await tx.objectStore("deviceKeys").get(expectedKey.id), expectedKey)) {
    await tx.done;
    return false;
  }
  const sync = tx.objectStore("accountState");
  const cleanupIds = await sync.getAllKeys(nativeRemovalRange());
  const nativeKeyId = nativeKeyForCleanup?.(await tx.objectStore("deviceKeys").get("dbKey"));
  if (nativeKeyId) cleanupIds.push(NATIVE_REMOVAL_PREFIX + nativeKeyId);
  beforeClear?.();
  const clears = stores.map(name => tx.objectStore(name).clear());
  await Promise.all([...clears, ...cleanupIds.map(id => sync.put({ id })),
    sync.put({ id: EDIT_KEY_RESET_ID, token: crypto.randomUUID() }), tx.done]);
  return true;
}

export async function getEditKeyResetToken(): Promise<string | null> {
  return (await (await getAppDB()).get("accountState", EDIT_KEY_RESET_ID))?.token ?? null;
}

const EDIT_MESSAGE_STORES = ["displayMessages", "legacyMessages"] as const;
type EditMessageStore = typeof EDIT_MESSAGE_STORES[number];
type MigratingEditState = LocalEditState & Partial<PlaintextEditState>;
type LegacyVaultMigration = { key: CryptoKey; keys: LocalKey[]; expected: ExpectedLocalKey[] };
const CACHED_FILE_PREFIX = "history-file:";
const TRANSFERRED_FILE_PREFIX = "history-transfer-file:";

/** Preview builds also sealed cached attachments with the old password-derived key. */
async function rewrapCachedAttachments(db: IDBPDatabase, oldKey: CryptoKey, key: CryptoKey) {
  const records = await db.getAll("accountFiles") as CachedFile[];
  const updates: { record: CachedFile; sealed: SealedAttachment }[] = [];
  for (const record of records) {
    const { id, ownerId, sealed, expiresAt } = record;
    if (!sealed || !ownerId || expiresAt <= Date.now()) continue;
    const prefix = [CACHED_FILE_PREFIX, TRANSFERRED_FILE_PREFIX].find((prefix) => id.startsWith(prefix));
    const fileId = prefix ? (JSON.parse(id.slice(prefix.length)) as [string, string])[1] : id;
    let wire: ArrayBuffer;
    try {
      wire = await openAttachmentBytes(oldKey, ownerId, fileId, sealed);
    } catch (error) {
      // An unreadable cached copy can be fetched or imported again.
      if (error && typeof error === "object" && "name" in error && error.name === "OperationError") continue;
      throw error;
    }
    try { updates.push({ record, sealed: await sealAttachmentBytes(key, ownerId, fileId, wire) }); }
    finally { new Uint8Array(wire).fill(0); }
  }
  return updates;
}

function storedEditKey(store: EditMessageStore, row: LocalMessage): string {
  return editStateKey(row.id, store === "displayMessages" ? row.ownerId : undefined);
}

function hasInlineEditCredentials(row: LocalMessage): boolean {
  return !!(row.editKey || row.editKeyVersion || row.editSigningKey || row.editSenderDeviceId || row.editKeyAccepted || row.pendingEdit);
}

async function recoverEditRevision(row: LocalMessage, edit: LocalEditState | undefined, key: CryptoKey) {
  if (!edit?.envelope || edit.editedAt === undefined || edit.editSequence <= (row.editSequence ?? 0)
    || edit.senderId !== row.senderId || edit.conversationId !== row.conversationId
    || row.type !== "text" || isSticker(row) || row.deletedAt != null || normalizeExpiryMetadata(row).expiresAt <= Date.now()) return;
  const content = await openStoredEdit(edit, edit.envelope, await openEditKey(edit, key));
  if (content !== undefined && !isSticker({ type: "text", content })) {
    return { content, editedAt: edit.editedAt, editSeq: edit.editSequence };
  }
}

/** Cryptographic work runs outside IndexedDB. A legacy vault and its edit keys commit together. */
export async function migrateLocalEditKeys(
  key: CryptoKey, vault: LocalKey, assertCurrent: () => void, legacy?: LegacyVaultMigration,
): Promise<void> {
  const db = await getAppDB();
  const range = outgoingKeyRange(undefined, EDIT_STATE_PREFIX);
  const scan = db.transaction([...EDIT_MESSAGE_STORES, "accountState"], "readonly");
  const state = scan.objectStore("accountState");
  if (!legacy && await state.get(EDIT_KEY_MIGRATION_ID)) { await scan.done; return; }
  const token = (await state.get(EDIT_KEY_RESET_ID))?.token;
  const saved = new Map((await state.getAll(range) as MigratingEditState[]).map(edit => [edit.id, edit]));
  const candidates: { store: EditMessageStore; row: LocalMessage; id: string }[] = [];
  for (const store of EDIT_MESSAGE_STORES) {
    for (let cursor = await scan.objectStore(store).openCursor(); cursor; cursor = await cursor.continue()) {
      const row = cursor.value as LocalMessage;
      const id = storedEditKey(store, row);
      const edit = saved.get(id);
      if (hasInlineEditCredentials(row) || edit?.editKey || (edit?.envelope && edit.editSequence > (row.editSequence ?? 0))) {
        candidates.push({ store, row, id });
      }
    }
  }
  await scan.done;

  const rewrapped = new Map<string, EncryptedLocalData>();
  if (legacy) {
    for (const edit of saved.values()) {
      if (!edit.wrappedKey) continue;
      const aad = editStorageAAD(edit);
      const raw = await decryptData(legacy.key, edit.wrappedKey.iv, edit.wrappedKey.ciphertext, aad);
      try { rewrapped.set(edit.id, await encryptData(key, raw, aad)); }
      finally { raw.fill(0); }
    }
  }
  const updates = await Promise.all(candidates.map(async (candidate) => {
    const { row, id } = candidate;
    const edit = saved.get(id);
    const inline = editKeyFromInline(row);
    const old = edit?.editKey ? edit as PlaintextEditState : inline;
    let wrapped: LocalEditState | undefined;
    if (!edit?.wrappedKey && old?.editSigningKey && old.editSenderDeviceId) {
      try {
        if (fromBase64Url(old.editKey).length === 32) wrapped = await wrapEditState({ ...old, id }, key);
      } catch (error) {
        if (!(error instanceof TypeError || (error instanceof DOMException && error.name === "InvalidCharacterError"))) throw error;
      }
    }
    const revision = await recoverEditRevision(row, edit?.wrappedKey ? edit : wrapped,
      edit?.wrappedKey && legacy ? legacy.key : key);
    return { ...candidate, wrapped, revision };
  }));

  const attachments = legacy ? await rewrapCachedAttachments(db, legacy.key, key) : [];
  const tx = db.transaction([...EDIT_MESSAGE_STORES, "accountState", "deviceKeys", ...(legacy ? ["accountFiles"] : [])], "readwrite");
  const edits = tx.objectStore("accountState"), keys = tx.objectStore("deviceKeys");
  if (!await localKeysMatch(keys, [vault, ...(legacy?.expected ?? [])])) {
    await tx.done;
    throw new Error("Local keys changed in another session");
  }
  if ((await edits.get(EDIT_KEY_RESET_ID))?.token !== token) {
    await tx.done;
    throw new DOMException("Local keys were reset", "AbortError");
  }
  const current = new Map((await edits.getAll(range) as MigratingEditState[]).map(edit => [edit.id, edit]));
  if (legacy || !await edits.get(EDIT_KEY_MIGRATION_ID)) {
    const changedEdits = [...current.values()].some(edit => JSON.stringify(edit) !== JSON.stringify(saved.get(edit.id)));
    const rows = await Promise.all(updates.map(({ store, row }) =>
      tx.objectStore(store).get(store === "displayMessages" ? [row.ownerId!, row.id] : row.id)));
    if (changedEdits || updates.some(({ row, id }, index) => JSON.stringify(row) !== JSON.stringify(rows[index])
      || (saved.has(id) && !current.has(id)))) {
      await tx.done;
      throw new Error("Local message edit keys changed in another session");
    }
  } else {
    // Another tab finished the same migration while this tab was doing crypto.
    await tx.done;
    assertCurrent();
    return;
  }
  const migratedFiles: CachedFile[] = [];
  if (legacy) {
    const files = tx.objectStore("accountFiles");
    for (const { record, sealed } of attachments) {
      const file = await files.get(record.id) as CachedFile | undefined;
      if (!file || file.expiresAt <= Date.now()) continue;
      if (file.ownerId !== record.ownerId || !file.sealed || toBase64Url(file.sealed.iv) !== toBase64Url(record.sealed!.iv)) {
        await tx.done;
        throw new Error("Local cached attachments changed in another session");
      }
      migratedFiles.push({ ...file, sealed });
    }
  }
  assertCurrent();
  for (const edit of current.values()) {
    const wrappedKey = rewrapped.get(edit.id);
    if (wrappedKey) await edits.put({ ...edit, wrappedKey });
    else if (edit.editKey && !edit.wrappedKey) await edits.delete(edit.id);
  }
  for (const { store, row, wrapped, revision } of updates) {
    const { hidden, deletion } = await readHistoryMessageBarriers(edits, row, row.ownerId, !!row.direct);
    const retained = !deletion && row.type === "text" && !isSticker(row) && normalizeExpiryMetadata(row).expiresAt > Date.now();
    if (retained && wrapped?.conversationId === row.conversationId && wrapped.senderId === row.senderId) await edits.put(wrapped);
    const edited = retained && revision;
    const record = withoutEditCredentials(row);
    if (edited && store === "displayMessages" && !hidden) await noteHistoryRemoval(edits, row.conversationId, row.ownerId);
    if (edited || hasInlineEditCredentials(row)) await tx.objectStore(store).put(edited ? editMessage(record, revision) : record);
  }
  if (legacy) for (const file of migratedFiles) await tx.objectStore("accountFiles").put(file);
  await Promise.all([edits.put({ id: EDIT_KEY_MIGRATION_ID }), ...(legacy?.keys.map(record => keys.put(record)) ?? []), tx.done]);
}

export async function clearCryptoState(
  expectedSetupId?: string, expectedVault?: LocalKey, nativeKeyForCleanup?: NativeKeyForCleanup,
  recovery?: { key: CryptoKey; vault: LocalKey },
): Promise<boolean> {
  const db = await getAppDB();
  const editRange = outgoingKeyRange(undefined, EDIT_STATE_PREFIX);
  const recovered = new Map<string, { edit: LocalEditState; revision: Awaited<ReturnType<typeof recoverEditRevision>> }>();
  const stores = ["receiveSessions", "deviceKeys", "receiveSenderKeys", "receiveSenderKeyRecipients"] as const;
  for (;;) {
    const tx = db.transaction([...stores, ...EDIT_MESSAGE_STORES, "accountState"], "readwrite");
    const state = tx.objectStore("accountState");
    const currentVault = await tx.objectStore("deviceKeys").get("dbKey");
    if ((expectedSetupId && (await state.get("setup:pending"))?.setupId !== expectedSetupId)
      || (expectedVault && !sameLocalKey(currentVault, expectedVault))) {
      await tx.done;
      return false;
    }
    const recoveryKey = recovery && sameLocalKey(currentVault, recovery.vault) ? recovery.key : undefined;
    const pending: { row: LocalMessage; edit: LocalEditState }[] = [];
    for (const store of EDIT_MESSAGE_STORES) {
      for (let cursor = await tx.objectStore(store).openCursor(); cursor; cursor = await cursor.continue()) {
        const row = cursor.value as LocalMessage;
        let updated = hasInlineEditCredentials(row) ? withoutEditCredentials(row) : undefined;
        if (recoveryKey && row.type === "text" && row.deletedAt == null && !isSticker(row)) {
          const id = storedEditKey(store, row);
          const edit = await state.get(id) as LocalEditState | undefined;
          if (edit?.wrappedKey && edit.envelope && edit.editSequence > (row.editSequence ?? 0)) {
            const { hidden, deletion } = await readHistoryMessageBarriers(state, row, row.ownerId, !!row.direct);
            if (!deletion && normalizeExpiryMetadata(row).expiresAt > Date.now()) {
              const previous = recovered.get(id);
              if (JSON.stringify(previous?.edit) !== JSON.stringify(edit)) pending.push({ row, edit });
              else if (previous?.revision && edit.senderId === row.senderId && edit.conversationId === row.conversationId) {
                updated = editMessage(updated ?? row, previous.revision);
                if (store === "displayMessages" && !hidden) await noteHistoryRemoval(state, row.conversationId, row.ownerId);
              }
            }
          }
        }
        if (updated) await cursor.update(updated);
      }
    }
    if (recoveryKey && pending.length) {
      tx.abort();
      await tx.done.catch(() => undefined);
      for (const { row, edit } of pending) recovered.set(edit.id, { edit, revision: await recoverEditRevision(row, edit, recoveryKey) });
      continue;
    }
    const nativeKeyId = nativeKeyForCleanup?.(currentVault);
    await Promise.all([...stores.map((name) => tx.objectStore(name).clear()),
      ...(nativeKeyId ? [state.put({ id: NATIVE_REMOVAL_PREFIX + nativeKeyId })] : []),
      state.delete("setup:pending"),
      state.delete(outgoingKeyRange(undefined, LOCKED_EDIT_PREFIX)),
      state.delete(outgoingKeyRange(undefined, OUTGOING_EDIT_PREFIX)),
      state.delete(outgoingKeyRange(undefined, OUTGOING_EDIT_STATUS_PREFIX)),
      state.delete(outgoingKeyRange(undefined, OUTGOING_EDIT_TARGET_PREFIX)),
      state.delete(outgoingKeyRange(undefined, EDIT_REPAIR_PREFIX)),
      state.delete(EDIT_KEY_MIGRATION_ID),
      state.delete(editRange),
      state.put({ id: EDIT_KEY_RESET_ID, token: crypto.randomUUID() }),
      tx.done,
    ]);
    return true;
  }
}

export async function savePendingCall(call: LocalPendingCall): Promise<void> {
  const db = await getAppDB();
  await db.put("receivePendingCalls", call);
}

export async function getPendingCall(id: string): Promise<LocalPendingCall | undefined> {
  const db = await getAppDB();
  return db.get("receivePendingCalls", id);
}

export async function deletePendingCall(id: string): Promise<void> {
  const db = await getAppDB();
  await db.delete("receivePendingCalls", id);
}

function cachedFileStorageId(ownerId: string, fileId: string, explicitTransfer?: true): string {
  return (explicitTransfer ? TRANSFERRED_FILE_PREFIX : CACHED_FILE_PREFIX) + JSON.stringify([ownerId, fileId]);
}

function isLegacyCachedFileId(id: string): boolean {
  return !id.startsWith(CACHED_FILE_PREFIX) && !id.startsWith(TRANSFERRED_FILE_PREFIX);
}

export async function readCachedFile(store: { get(id: string): Promise<CachedFile | undefined> }, fileId: string, ownerId: string): Promise<CachedFile | undefined> {
  const record = await store.get(cachedFileStorageId(ownerId, fileId, true))
    ?? await store.get(cachedFileStorageId(ownerId, fileId)) ?? (isLegacyCachedFileId(fileId) ? await store.get(fileId) : undefined);
  return record?.ownerId === ownerId ? { ...record, id: fileId } : undefined;
}

export async function writeCachedFile(store: { get(id: string): Promise<CachedFile | undefined>; put(file: CachedFile): Promise<unknown>; delete(id: string): Promise<void> }, file: CachedFile): Promise<void> {
  const { ownerId, id } = file;
  if (ownerId && file.explicitTransfer) {
    await store.delete(cachedFileStorageId(ownerId, id));
    if (isLegacyCachedFileId(id) && (await store.get(id))?.ownerId === ownerId) await store.delete(id);
  }
  await store.put(ownerId ? { ...file, id: cachedFileStorageId(ownerId, id, file.explicitTransfer) } : file);
}

export async function evictCachedFile(
  store: { get(id: string): Promise<CachedFile | undefined>; delete(id: string): Promise<void> },
  fileId: string,
  ownerId?: string | null,
): Promise<void> {
  if (ownerId) {
    await store.delete(cachedFileStorageId(ownerId, fileId));
    await store.delete(cachedFileStorageId(ownerId, fileId, true));
  }
  const legacy = isLegacyCachedFileId(fileId) ? await store.get(fileId) : undefined;
  if (legacy && (legacy.ownerId === ownerId || (!legacy.ownerId && !legacy.sealed))) await store.delete(fileId);
}

export async function getCachedFile(id: string, ownerId: string): Promise<CachedFile | undefined> {
  return readCachedFile((await getAppDB()).transaction("accountFiles").store, id, ownerId);
}

export async function cacheAttachmentForMessage(file: CachedFile, messageId: string, current: () => boolean,
  failedCopy?: { cachedAt: number; iv: Uint8Array }): Promise<void> {
  const cap = 64 * 1024 * 1024;
  const headroom = 32 * 1024 * 1024;
  const size = file.sealed?.ciphertext.size;
  if (!size || !file.ownerId || !current()) return;
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  const available = estimate?.quota === undefined || estimate.usage === undefined ? undefined : estimate.quota - estimate.usage;
  const previewFits = size <= cap && (available === undefined || available >= size + headroom);
  if (!previewFits && !failedCopy) return;
  const db = await getAppDB();
  if (!file.sealed || !file.ownerId || !current()) return;
  const tx = db.transaction(["accountFiles", "displayMessages", "accountState"], "readwrite");
  const row = await readDisplayMessage(tx.objectStore("displayMessages"), messageId, file.ownerId);
  const state = tx.objectStore("accountState");
  const barriers = row && await readHistoryMessageBarriers(state, row, file.ownerId, !!row.direct);
  if (row && barriers && !barriers.hidden && !barriers.deletion && extractFileIdFromMessage(row) === file.id && current()) {
    const expiresAt = Math.min(file.expiresAt, normalizeExpiryMetadata(row).expiresAt);
    if (expiresAt > Date.now()) {
      const cache = tx.objectStore("accountFiles");
      const key = cachedFileStorageId(file.ownerId, file.id);
      const saved = await readCachedFile(cache, file.id, file.ownerId);
      if (saved?.explicitTransfer) {
        const replaceable = saved.expiresAt <= Date.now() || (saved.sealed && failedCopy?.cachedAt === saved.cachedAt
          && toBase64Url(failedCopy.iv) === toBase64Url(saved.sealed.iv));
        const growth = size - (saved.sealed?.ciphertext.size ?? saved.blob?.size ?? 0);
        if (current() && replaceable && (growth <= 0 || (available !== undefined && available >= growth + headroom))) {
          await writeCachedFile(cache, { ...file, expiresAt, explicitTransfer: true });
        }
        await tx.done;
        return;
      }
      if (!previewFits) { await tx.done; return; }
      // History transfer has never shipped, so unflagged cache entries are ordinary previews.
      // Separate key ranges skip explicit copies without requiring an IndexedDB schema change.
      const files = (await Promise.all([
        cache.getAll(IDBKeyRange.upperBound(TRANSFERRED_FILE_PREFIX, true)),
        cache.getAll(IDBKeyRange.lowerBound(TRANSFERRED_FILE_PREFIX.slice(0, -1) + ";")),
      ])).flat().filter((entry: CachedFile) => !entry.explicitTransfer && entry.id !== key) as CachedFile[];
      let used = files.reduce((total, entry) => total + (entry.sealed?.ciphertext.size ?? entry.blob?.size ?? 0), size);
      const evict = files.filter((entry) => entry.ownerId === file.ownerId).sort((a, b) => a.cachedAt - b.cachedAt);
      const victims: string[] = [];
      for (const entry of evict) {
        if (used <= cap) break;
        used -= entry.sealed?.ciphertext.size ?? entry.blob?.size ?? 0;
        victims.push(entry.id);
      }
      if (used <= cap && current()) {
        for (const id of victims) await cache.delete(id);
        await writeCachedFile(cache, { ...file, expiresAt });
      }
    }
  }
  await tx.done;
}

export async function cleanupExpiredFileCache(now = Date.now()): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction("accountFiles", "readwrite");
  const store = tx.objectStore("accountFiles");
  const files = await store.getAll();
  for (const file of files as CachedFile[]) {
    if (!file.sealed || file.expiresAt <= now) {
      await store.delete(file.id);
    }
  }
  await tx.done;
}

export async function cleanupExpiredPendingCalls(now = Date.now()): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction("receivePendingCalls", "readwrite");
  const store = tx.objectStore("receivePendingCalls");
  const calls = await store.getAll();
  for (const call of calls as LocalPendingCall[]) {
    if (call.expiresAt <= now) {
      await store.delete(call.id);
    }
  }
  await tx.done;
}

export function extractFileIdFromMessage(message: LocalMessage): string | null {
  if (message.type !== "file") return null;
  try {
    const parsed = JSON.parse(message.content) as { fileId?: unknown };
    return typeof parsed.fileId === "string" ? parsed.fileId : null;
  } catch {
    return null;
  }
}

export async function cleanupExpiredMessages(now = Date.now(), ownerId?: string): Promise<string[]> {
  const db = await getAppDB();
  const quarantine = db.transaction(["legacyMessages", "accountState"], "readwrite");
  const legacy = quarantine.objectStore("legacyMessages"), legacyState = quarantine.objectStore("accountState");
  const expiredLegacy = await legacy.index("byExpiry").getAllKeys(IDBKeyRange.upperBound(now), 100);
  await Promise.all(expiredLegacy.flatMap((key) => [legacy.delete(key), legacyState.delete(editStateKey(String(key)))]));
  await quarantine.done;

  const tx = db.transaction(["displayMessages", "accountFiles", "accountState"], "readwrite");
  const messageStore = tx.objectStore("displayMessages");
  const fileCacheStore = tx.objectStore("accountFiles");
  const messages = await messageStore.getAll();
  // A queued message's expiry is only an estimate: the server starts the TTL when it accepts the
  // send. Its display record is also the only copy of the content the queue still has to send.
  const queuedIds = await queuedMessageIds(tx.objectStore("accountState"));
  const deletedIds: string[] = [];
  const syncStore = tx.objectStore("accountState");
  const receipts = await syncStore.getAll(IDBKeyRange.bound(RECEIVED_PREFIX, `${RECEIVED_PREFIX}\uffff`));
  for (const receipt of receipts) {
    if (receipt.expiresAt !== null && receipt.expiresAt <= now) await syncStore.delete(receipt.id);
  }

  for (const prefix of [LOCKED_EDIT_PREFIX, EDIT_REPAIR_PREFIX]) {
    for (const record of await syncStore.getAll(IDBKeyRange.bound(prefix, prefix + "\uffff"))) {
      if ((record.edit?.expiresAt ?? record.expiresAt) <= now) await syncStore.delete(record.id);
    }
  }

  const pending = await syncStore.getAll(IDBKeyRange.bound(PENDING_RECEIVE_PREFIX, `${PENDING_RECEIVE_PREFIX}\uffff`));
  for (const record of pending) {
    if (record.frame.expiresAt !== null && record.frame.expiresAt <= now) await syncStore.delete(record.id);
  }

  const retained = new Set<string>();
  for (const message of messages as LocalMessage[]) {
    const { expiresAt } = normalizeExpiryMetadata(message);
    if (expiresAt > now || isQueuedMessage(queuedIds, message)) {
      if (!message.deletedAt && message.type === "text" && !isSticker(message)) retained.add(editStateKey(message.id, message.ownerId));
      continue;
    }
    if (ownerId === undefined || message.ownerId === ownerId) deletedIds.push(message.id);
    await messageStore.delete([message.ownerId!, message.id]);
    await syncStore.delete(editStateKey(message.id, message.ownerId));
    if (message.ownerId) await retireEditsForMessage(syncStore, message.id, message.ownerId, message);
    await unindexImportedDeletion(syncStore, message);

    const fileId = extractFileIdFromMessage(message);
    if (fileId) {
      await evictCachedFile(fileCacheStore, fileId, message.ownerId);
    }
  }

  // Cached state can outlive a row rewritten by a pre-release client.
  for (const key of await syncStore.getAllKeys(outgoingKeyRange(undefined, EDIT_STATE_PREFIX))) {
    if (String(key).startsWith(EDIT_STATE_PREFIX + "[") && !retained.has(String(key))) await syncStore.delete(key);
  }
  for (const hide of await syncStore.getAll(outgoingKeyRange(undefined, MESSAGE_HIDE_PREFIX)) as MessageHide[]) {
    if (!hide.ownerId || !hide.messageId || hide.undoToken || hide.expiresAt === undefined || hide.expiresAt > now) continue;
    await retireEditsForMessage(syncStore, hide.messageId, hide.ownerId);
    const { expiresAt, ...marker } = hide;
    await syncStore.put(marker);
  }
  await tx.done;
  return deletedIds;
}

// Message pipeline lookups (kept separate from key storage helpers).
export async function getMessageById(id: string, ownerId?: string | null, direct?: boolean, includeEditKey = false): Promise<LocalMessage | undefined> {
  const tx = (await getAppDB()).transaction(["displayMessages", "accountState"], "readonly");
  const row = await readDisplayMessage(tx.objectStore("displayMessages"), id, ownerId, direct);
  const snapshot = row && await readEditSnapshot(tx.objectStore("accountState"), row);
  await tx.done;
  return snapshot && restoreEditSnapshot(snapshot, includeEditKey && !!ownerId);
}

/** Envelopes and encrypted upload bytes only. Display content stays in `displayMessages`. */
export type OutgoingStep = ({
  path: "/api/messages/send" | "/api/messages/send-direct-batch";
  body: SendMessageRequest | SendDirectBatchRequest;
} | {
  path: "/api/messages/edit";
  body: MessageEditRequest;
}) & {
  distributed?: { senderDeviceId: string; senderKeyId: number; recipientDeviceIds: string[] };
  completed?: boolean;
  /** Persisted before this step's POST, independently of other envelopes in the row. */
  sendDispatched?: boolean;
};
export interface LocalOutgoing {
  id: string;
  /** Absent on older records; changed by every outbox write. */
  revision?: string;
  queuedAt: number;
  userId: string;
  deviceId: string;
  conversationId: string;
  conversationType: "direct" | "group";
  ttlSeconds: number | null;
  editTargetId?: string;
  fileId?: string;
  upload?: { bytes: Uint8Array; mimeType: string; uploadUrl?: string; uploaded?: boolean };
  steps: OutgoingStep[];
  /** Dispatch of this message's ciphertext, excluding sender-key distributions. */
  sendDispatched?: boolean;
  attempts: number;
  status: "sending" | "failed";
  retryable: boolean;
  nextAttemptAt: number | null;
  error: string | null;
}
export type OutgoingEditStatus = Omit<LocalOutgoing, "steps" | "upload"> & { hasEnvelope: boolean };

const outgoingMessageReadyListeners = new Set<(outgoing: LocalOutgoing) => void>();

export function subscribeOutgoingMessageReady(listener: (outgoing: LocalOutgoing) => void) {
  outgoingMessageReadyListeners.add(listener);
  return () => { outgoingMessageReadyListeners.delete(listener); };
}

export async function saveOutgoing(outgoing: LocalOutgoing): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction("accountState", "readwrite");
  await putOutgoing(tx.store, outgoing);
  await tx.done;
}
export async function getOutgoing(id: string, ownerId?: string): Promise<LocalOutgoing | undefined> {
  const db = await getAppDB();
  if (ownerId) return (await db.get("accountState", outgoingKey(id, ownerId)))?.outgoing;
  const candidates = (await getAllOutgoingMessages()).filter((row) => row.id === id);
  return candidates.length === 1 ? candidates[0] : undefined;
}
export async function getAllOutgoingMessages(ownerId?: string): Promise<LocalOutgoing[]> {
  const db = await getAppDB();
  return (await db.getAll("accountState", outgoingKeyRange(ownerId))).map((record) => record.outgoing);
}
export async function getAllOutgoing(ownerId?: string): Promise<LocalOutgoing[]> {
  const tx = (await getAppDB()).transaction("accountState");
  const rows = await Promise.all([OUTGOING_PREFIX, OUTGOING_EDIT_PREFIX].map((prefix) => tx.store.getAll(outgoingKeyRange(ownerId, prefix))));
  return rows.flat().map(({ outgoing }) => outgoing as LocalOutgoing);
}
export async function getOutgoingOperation(id: string, ownerId?: string): Promise<LocalOutgoing | undefined> {
  if (ownerId) return readOutgoing((await getAppDB()).transaction("accountState").store, id, ownerId);
  const matches = (await getAllOutgoing()).filter((row) => row.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}
export async function getOutgoingEditStatus(id: string, ownerId: string): Promise<OutgoingEditStatus | undefined> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const status = await readOutgoingEditStatus(tx.store, id, ownerId);
  await tx.done;
  return status;
}
export async function getOutgoingEditStatuses(ownerId: string): Promise<OutgoingEditStatus[]> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const operations = await tx.store.getAllKeys(outgoingKeyRange(ownerId, OUTGOING_EDIT_PREFIX));
  const statuses = await Promise.all(operations.map((key) =>
    readOutgoingEditStatus(tx.store, JSON.parse(String(key).slice(OUTGOING_EDIT_PREFIX.length))[1], ownerId)));
  await tx.done;
  return statuses.filter((status) => status !== undefined);
}
export async function deleteOutgoing(id: string, ownerId?: string): Promise<void> {
  const outgoing = await getOutgoing(id, ownerId);
  if (outgoing) await (await getAppDB()).delete("accountState", outgoingKey(id, outgoing.userId));
}
/** Retire only an unsendable orphan, checking current queue/display state atomically. */
export async function retireUnsendableOutgoing(id: string, ownerId: string, edit = false) {
  const db = await getAppDB();
  const tx = db.transaction(["displayMessages", "accountState"], "readwrite");
  const queue = tx.objectStore("accountState");
  const row = edit ? await readOutgoingEditStatus(queue, id, ownerId) : (await queue.get(outgoingKey(id, ownerId)))?.outgoing as LocalOutgoing | undefined;
  if (!row) { await tx.done; return; }
  const message = await readDisplayMessage(tx.objectStore("displayMessages"), row.editTargetId ?? id, ownerId);
  const edits = row.editTargetId && message && await readEditState(queue, message);
  const hasEnvelope = "hasEnvelope" in row ? row.hasEnvelope
    : row.steps.some((step) => step.path !== "/api/messages/send-direct-batch" || step.body.type !== "sender_key_distribution");
  if (row.editTargetId ? !!edits && edits.pendingId === id : !!message || (row.retryable && hasEnvelope)) { await tx.done; return; }
  // Delete for me can purge the key and display row while a signed edit remains retryable.
  if (row.editTargetId && row.retryable && !message && hasEnvelope) {
    const [hidden, deletion] = await Promise.all([
      readMessageHide(queue, row.editTargetId, ownerId),
      readMessageDeletion(queue, row.editTargetId, ownerId),
    ]);
    if (hidden && !hidden.undoToken && (hidden.expiresAt ?? 0) > Date.now()
      && !(deletion && deletionMatches({ conversationId: row.conversationId, senderId: row.userId }, deletion))) {
      await tx.done;
      return undefined;
    }
  }
  // Encrypted upload bytes live only in this record, so deleting it retires them too.
  if (row.editTargetId) await deleteOutgoingEdit(queue, row.id, row.editTargetId, ownerId);
  else await queue.delete(outgoingKey(row.id, ownerId));
  await tx.done;
  if (row.editTargetId) publishLocalMessageChange(row.id, "outbox", row.conversationId);
  return row;
}

export async function saveQueuedEdit(outgoing: LocalOutgoing & { editTargetId: string }, editKeyVersion: string, content: string, current: () => boolean): Promise<LocalMessage | undefined> {
  const db = await getAppDB();
  const tx = db.transaction(["displayMessages", "accountState", "accountFiles"], "readwrite");
  const state = tx.objectStore("accountState"), messages = tx.objectStore("displayMessages");
  const id = outgoing.editTargetId;
  const message = await readDisplayMessage(messages, id, outgoing.userId);
  const edits = message && await readEditState(state, message);
  const { hidden, deletion } = message ? await readHistoryMessageBarriers(state, message, outgoing.userId, !!message.direct) : {};
  const step = outgoing.steps[0];
  if (!current() || !content.trim() || isSticker({ type: "text", content }) || !message || !edits?.editKeyAccepted || edits.wrappedKey.iv !== editKeyVersion
    || edits.editSenderDeviceId !== outgoing.deviceId || step?.path !== "/api/messages/edit"
    || step.body.editSeq !== edits.editSequence + 1 || hidden || (deletion && deletionMatches(message, deletion))
    || message.conversationId !== outgoing.conversationId || message.senderId !== outgoing.userId
    || edits.pendingId
    || !["sent", "delivered", "read"].includes(message.status) || normalizeExpiryMetadata(message).expiresAt <= Date.now()) {
    await tx.done;
    return;
  }
  const updated = { ...message, pendingEdit: { id: outgoing.id, content } };
  await state.put({ ...edits, pendingId: outgoing.id });
  await putOutgoing(state, outgoing);
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return; }
  await tx.done;
  publishLocalMessageChange(id, "edit", message.conversationId);
  publishLocalMessageChange(outgoing.id, "outbox", outgoing.conversationId);
  return { ...updated, ...editCredentials(edits) };
}

export async function finishQueuedEdit(outgoing: LocalOutgoing, current: () => boolean, receipt?: MessageEditReceipt): Promise<boolean> {
  const id = outgoing.editTargetId;
  if (!id || !current()) return false;
  const pending = receipt ? (await getMessageById(id, outgoing.userId))?.pendingEdit : undefined;
  const db = await getAppDB();
  const tx = db.transaction(["displayMessages", "accountState", "accountFiles"], "readwrite");
  const state = tx.objectStore("accountState"), messages = tx.objectStore("displayMessages");
  const stored = await readOutgoing(state, outgoing.id, outgoing.userId);
  const message = await readDisplayMessage(messages, id, outgoing.userId);
  const edits = message && await readEditState(state, message);
  const { hidden, deletion } = message ? await readHistoryMessageBarriers(state, message, outgoing.userId, !!message.direct) : {};
  if (!current() || !stored || stored.revision !== outgoing.revision) { await tx.done; return false; }
  if (message && edits?.pendingId === outgoing.id && message.conversationId === outgoing.conversationId && message.senderId === outgoing.userId
    && !(hidden && permanentHide(await readMessageHide(state, id, outgoing.userId, message))) && !deletion && normalizeExpiryMetadata(message).expiresAt > Date.now()) {
    const step = stored.steps[0];
    const content = pending?.id === outgoing.id ? pending.content : undefined;
    const applied = receipt && step?.path === "/api/messages/edit" && step.body.editSeq === receipt.editSeq && edits.editSequence < receipt.editSeq
      && content !== undefined && !isSticker({ type: "text", content });
    const updated = applied ? editMessage(message, { ...receipt, content }) : message;
    if (applied) await mergeDisplayMessage(tx, updated, { editing: true });
    await state.put({ ...edits, pendingId: undefined,
      ...(applied && { editSequence: receipt.editSeq, editedAt: receipt.editedAt, envelope: editEnvelope(step.body) }) });
  }
  await deleteOutgoingEdit(state, outgoing.id, id, outgoing.userId);
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return false; }
  await tx.done;
  if (message) publishLocalMessageChange(message.id, "edit", message.conversationId);
  publishLocalMessageChange(outgoing.id, "outbox", outgoing.conversationId);
  return true;
}
/** Commit the display record and its outbox entry together before making network requests. */
export async function saveQueuedMessage(message: LocalMessage, outgoing: LocalOutgoing): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction(["displayMessages", "accountState", "accountFiles"], "readwrite");
  const queue = tx.objectStore("accountState");
  const merged = await mergeDisplayMessage(tx, { ...message, id: outgoing.id, wireId: outgoing.id,
    ownerId: outgoing.userId, direct: outgoing.conversationType === "direct" });
  if (!merged.row || merged.hidden || merged.row.deletedAt != null) { await tx.done; return; }
  const existing = (await queue.get(outgoingId(outgoing)))?.outgoing as LocalOutgoing | undefined;
  if (existing) {
    outgoing.queuedAt = existing.queuedAt;
  } else {
    const pending = await queue.getAll(outgoingKeyRange(outgoing.userId));
    outgoing.queuedAt = Math.max(outgoing.queuedAt, ...pending.map((entry) => entry.outgoing.queuedAt + 1));
  }
  await putOutgoing(queue, outgoing);
  await tx.done;
  if (outgoing.retryable && !existing?.retryable) outgoingMessageReadyListeners.forEach((listener) => listener(outgoing));
}
export async function discardQueuedMessage(id: string, current: () => boolean = () => true, ownerId?: string): Promise<void> {
  const db = await getAppDB();
  const owner = ownerId ?? (await getOutgoing(id))?.userId;
  if (!owner || !current()) return;
  const tx = db.transaction(["displayMessages", "accountState", "accountFiles"], "readwrite");
  const key = outgoingKey(id, owner);
  const outgoing = (await tx.objectStore("accountState").get(key))?.outgoing as LocalOutgoing | undefined;
  const message = outgoing && await readDisplayMessage(tx.objectStore("displayMessages"), id, outgoing.userId);
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return; }
  const fileId = message && extractFileIdFromMessage(message);
  if (fileId) await evictCachedFile(tx.objectStore("accountFiles"), fileId, message?.ownerId);
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return; }
  if (message?.ownerId) {
    await tx.objectStore("displayMessages").delete([message.ownerId, message.id]);
    await tx.objectStore("accountState").delete(editStateKey(message.id, message.ownerId));
  }
  await tx.objectStore("accountState").delete(key);
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return; }
  await tx.done;
}


/** Update an existing outbox entry atomically, without resurrecting another tab's discard. */
export async function updateOutgoingIfPresent(outgoing: LocalOutgoing, message?: LocalMessage, options: { ifUnchanged?: boolean; prepareEditKey?: boolean; editKeyResetToken?: string | null } = {}): Promise<boolean> {
  const wrappedEditState = options.prepareEditKey && message ? await prepareEditState({ ...message, ownerId: outgoing.userId }) : undefined;
  const db = await getAppDB();
  const tx = db.transaction(["displayMessages", "accountState", "accountFiles"], "readwrite");
  const queue = tx.objectStore("accountState");
  const current = (await queue.get(outgoingId(outgoing)))?.outgoing as LocalOutgoing | undefined;
  if (!current || (options.ifUnchanged && current.revision !== outgoing.revision)) { await tx.done; return false; }
  await putOutgoing(queue, outgoing);
  if (message) await mergeDisplayMessage(tx, { ...message, ownerId: current.userId, direct: current.conversationType === "direct" }, { ...options, wrappedEditState });
  await tx.done;
  if (outgoing.editTargetId && current.status !== outgoing.status) publishLocalMessageChange(outgoing.id, "outbox", outgoing.conversationId);
  if (!outgoing.editTargetId && !options.ifUnchanged && !current.retryable && outgoing.retryable) {
    outgoingMessageReadyListeners.forEach((listener) => listener(outgoing));
  }
  return true;
}
export async function completeOutgoingIfPresent(outgoing: LocalOutgoing, message?: LocalMessage, options: { ifUnchanged?: boolean; editKeyAccepted?: boolean } = {}): Promise<boolean> {
  const db = await getAppDB();
  const tx = db.transaction(["displayMessages", "accountState", "accountFiles"], "readwrite");
  const queue = tx.objectStore("accountState");
  const current = (await queue.get(outgoingId(outgoing)))?.outgoing as LocalOutgoing | undefined;
  if (!current || (options.ifUnchanged && current.revision !== outgoing.revision)) { await tx.done; return false; }
  if (message) await mergeDisplayMessage(tx, { ...message, ownerId: current.userId, direct: current.conversationType === "direct" }, options);
  await queue.delete(outgoingId(outgoing));
  await tx.done;
  return true;
}

/** Normalize a legacy queue diagnostic without overwriting concurrent send progress. */
export async function updateOutgoingErrorIfUnchanged(id: string, previous: string, next: string, ownerId: string): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction("accountState", "readwrite");
  const row = (await tx.store.get(outgoingKey(id, ownerId)))?.outgoing as LocalOutgoing | undefined;
  if (row?.error === previous) await tx.store.put(outgoingRecord({ ...row, error: next }));
  await tx.done;
}

/** Durable barriers prevent delayed sync/ack writes from restoring removed plaintext. */
/** Last check before publishing any snapshot: pending hides retain their records,
 * and a deletion marker may have arrived since the snapshot was read. */
export async function guardMessageForPublish<T extends LocalMessage>(message: T, ownerId?: string | null, knownDirect?: boolean): Promise<T | null> {
  if (ownerId !== undefined && !messageVisibleToAccount(message, ownerId)) return null;
  const tx = (await getAppDB()).transaction(["accountState", "displayMessages", "accountConversations"], "readonly");
  const state = tx.objectStore("accountState");
  const owner = ownerId ?? message.ownerId;
  const direct = knownDirect ?? (!!owner && (await tx.objectStore("accountConversations").get(historyConversationKey(owner, message.conversationId)))?.conversation.type === "direct");
  const generation = getConversationHideGeneration(message.conversationId);
  const { hidden, deletion } = await readHistoryMessageBarriers(state, message, owner, knownDirect ?? message.direct ?? direct);
  const row = !hidden && !deletion && await readDisplayMessage(tx.objectStore("displayMessages"), message.id, owner, knownDirect);
  const snapshot = row && row.senderId === message.senderId && row.conversationId === message.conversationId
    ? await readEditSnapshot(state, row) : undefined;
  const hasOutgoingEntry = !!owner && await hasQueuedMessage(state, row ? row.id : message.id, owner);
  await tx.done;
  if (hidden) return null;
  if (deletion) return { ...message, ...redactMessage(message, deletion), fileMetadata: undefined, hasOutgoingEntry,
    pendingEdit: undefined, editKey: undefined, editKeyVersion: undefined, editSigningKey: undefined, editSenderDeviceId: undefined,
    editKeyAccepted: undefined, editSequence: undefined, latestEditSeq: undefined, editedAt: undefined, editedByUserId: undefined };
  const restored = snapshot && await restoreEditSnapshot(snapshot);
  if (generation !== getConversationHideGeneration(message.conversationId)) return guardMessageForPublish(message, ownerId, knownDirect);
  const merged = restored ? preserveImportedFields(message, restored) : message;
  return { ...withoutEditCredentials(merged), hasOutgoingEntry, pendingEdit: restored?.pendingEdit,
    editKeyAccepted: restored?.editKeyAccepted, editSenderDeviceId: restored?.editSenderDeviceId } as T;
}

export async function isMessageHidden(id: string, ownerId?: string, direct?: boolean): Promise<boolean> {
  const tx = (await getAppDB()).transaction(["displayMessages", "accountState"], "readonly");
  const row = await readDisplayMessage(tx.objectStore("displayMessages"), id, ownerId, direct);
  const state = tx.objectStore("accountState");
  return !!await readMessageHide(state, row?.id ?? id, ownerId, row)
    || ((direct ?? row?.direct ?? false) && await hasMessageFamilyHide(state, id, ownerId));
}

export async function removeLocalMessageContent(messageId: string, tombstone?: LocalMessage, current: () => boolean = () => true, ownerId?: string | null): Promise<boolean> {
  if (ownerId === null || !current()) return false;
  const tx = (await getAppDB()).transaction(["displayMessages", "legacyMessages", "accountState", "accountFiles"], "readwrite");
  const state = tx.objectStore("accountState");
  const row = await readDisplayMessage(tx.objectStore("displayMessages"), messageId, ownerId, tombstone?.direct);
  const owner = ownerId ?? row?.ownerId ?? tombstone?.ownerId;
  if (!owner || !current()) { await tx.done; return false; }
  const id = row?.id ?? logicalMessageId(messageId, tombstone?.direct ?? messageId.includes(":"));
  let changed = false;
  if (tombstone) {
    const deletion = { conversationId: tombstone.conversationId, senderId: tombstone.senderId,
      deletedAt: tombstone.deletedAt ?? Date.now(), deletedByUserId: tombstone.deletedByUserId ?? tombstone.senderId };
    const result = await mergeDisplayDeletion(tx, tombstone.wireId ?? messageId, owner, deletion, tombstone.direct ?? row?.direct, tombstone);
    if (!result.accepted) { await tx.done; return false; }
    changed = result.changed;
  } else {
    const edits = row && await readEditState(state, row);
    if (row) await mergeDisplayMessage(tx, row, { finalizeHide: true });
    await state.put({ id: messageHideKey(id, owner), messageId: id, ownerId: owner,
      ...(edits?.pendingId && row && { expiresAt: normalizeExpiryMetadata(row).expiresAt }) });
    await noteHistoryRemoval(state, row?.conversationId, owner);
    changed = true;
  }
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return false; }
  await tx.done;
  if (changed) publishLocalMessageChange(id, tombstone ? "commit" : "hide", tombstone?.conversationId ?? row?.conversationId);
  return true;
}

export async function getMessageDeletion(id: string, ownerId?: string, identity?: Pick<LocalMessage, "conversationId" | "senderId">, direct = false): Promise<MessageDeletion | undefined> {
  const state = (await getAppDB()).transaction("accountState").store;
  return readMessageDeletion(state, id, ownerId, identity, direct);
}

export async function mergeDisplayDeletion(
  tx: DisplayTransaction, wireId: string, ownerId: string, deletion: MessageDeletion,
  direct?: boolean, incoming?: LocalMessage,
): Promise<{ accepted: boolean; changed: boolean; row?: LocalMessage }> {
  const state = tx.objectStore("accountState");
  const displayed = await readDisplayMessage(tx.objectStore("displayMessages"), wireId, ownerId, direct);
  const directFamily = direct ?? displayed?.direct ?? wireId.includes(":");
  // A server tombstone applies to matching quarantine rows even if a live row
  // already exists, or if this mutation was seen before the schema migration.
  if (deletion.importedAt === undefined) {
    const legacy = tx.objectStore("legacyMessages");
    for (const prefix of ["", accountMessageStorageId(ownerId, "")]) {
      const range = directFamily ? messageFamilyRange(wireId, prefix) : IDBKeyRange.only(prefix + wireId);
      for (const row of await legacy.getAll(range) as LocalMessage[]) {
        const id = wireMessageId(row.id, ownerId);
        if ((row.ownerId && row.ownerId !== ownerId) || !deletionMatches(row, deletion) || alreadyRedacted(row, deletion)
          || (directFamily ? !sameMessageFamily(id, wireId) : id !== wireId)) continue;
        const fileId = extractFileIdFromMessage(row);
        if (fileId) await evictCachedFile(tx.objectStore("accountFiles"), fileId, ownerId);
        await legacy.put(quarantineMessage(redactMessage(row, deletion)));
        await state.delete(editStateKey(row.id));
      }
    }
  }
  if (displayed && !deletionMatches(displayed, deletion)) return { accepted: false, changed: false };
  const id = displayed?.id ?? logicalMessageId(wireId, directFamily);
  const key = messageDeletionKey(id, ownerId);
  const old = await state.get(key) as DeletionMarker | undefined;
  const markerChanged = !sameDeletion(old, deletion, ownerId);
  if (markerChanged || (old?.importedAt !== undefined && deletion.importedAt === undefined)) {
    await state.put({ ...deletion, id: key, ownerId, transferSourceId: displayed?.transferSourceId ?? old?.transferSourceId });
  }
  await retireEditsForMessage(state, id, ownerId, { conversationId: deletion.conversationId, senderId: deletion.senderId ?? deletion.deletedByUserId });
  const base = displayed ?? incoming;
  const merged = base && await mergeDisplayMessage(tx, { ...base, ...deletion, id, ownerId,
    wireId: base.wireId ?? wireId, direct: direct ?? base.direct ?? wireId.includes(":") });
  if (!merged?.changed && markerChanged) await noteHistoryRemoval(state, deletion.conversationId, ownerId);
  await deletePendingReceive(state, wireId, ownerId);
  return { accepted: true, changed: markerChanged || !!merged?.changed, row: merged?.row };
}

export async function rememberMessageDeletion(id: string, conversationId: string, deletedAt: number, deletedByUserId: string, senderId = deletedByUserId,
  current: () => boolean = () => true, ownerId?: string, direct?: boolean): Promise<boolean> {
  const tx = (await getAppDB()).transaction(["displayMessages", "legacyMessages", "accountState", "accountFiles"], "readwrite");
  const row = await readDisplayMessage(tx.objectStore("displayMessages"), id, ownerId, direct);
  const owner = ownerId ?? row?.ownerId;
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return false; }
  const deletion = { conversationId, senderId, deletedAt, deletedByUserId };
  if (!owner) {
    // An explicitly unowned legacy barrier is conservative and cannot claim a row.
    const state = tx.objectStore("accountState");
    const key = messageDeletionKey(id);
    if (!sameDeletion(await state.get(key), deletion)) {
      await state.put({ id: key, ...deletion });
      await noteHistoryRemoval(state, conversationId);
    }
    if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return false; }
    await tx.done;
    return true;
  }
  const result = await mergeDisplayDeletion(tx, id, owner, deletion, direct);
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return false; }
  await tx.done;
  if (result.changed && result.row) publishLocalMessageChange(result.row.id, "commit", conversationId);
  return result.accepted;
}

export function messageFamilyRange(id: string, prefix = ""): IDBKeyRange {
  const root = prefix + id.split(":")[0];
  return IDBKeyRange.bound(root, root + ":\uffff");
}

export function sameMessageFamily(first: string, second: string): boolean {
  return first.split(":")[0] === second.split(":")[0];
}

async function hasMessageFamilyHide(
  store: Pick<HideStore, "getAll">,
  id: string,
  ownerId?: string,
): Promise<boolean> {
  const wireId = wireMessageId(id, ownerId);
  const prefix = ownerId ? messageHideKey("", ownerId) : MESSAGE_HIDE_PREFIX;
  const markers = await store.getAll(messageFamilyRange(wireId, prefix));
  if (markers.some((marker) => (!marker.ownerId || marker.ownerId === ownerId)
    && sameMessageFamily(wireId, marker.id.slice(prefix.length)))) return true;
  if (!ownerId) return false;
  const legacy = await store.getAll(messageFamilyRange(wireId, MESSAGE_HIDE_PREFIX));
  return legacy.some((marker) => (marker.ownerId === ownerId || (!marker.ownerId && !marker.undoToken))
    && sameMessageFamily(wireId, marker.id.slice(MESSAGE_HIDE_PREFIX.length)));
}

/** Hide durably before showing Undo. The retained record is never returned by history reads. */
export async function beginMessageHide(id: string, current: () => boolean = () => true, ownerId?: string | null): Promise<{ token: string; deadline: number } | null> {
  const tx = (await getAppDB()).transaction(["displayMessages", "accountState"], "readwrite");
  const state = tx.objectStore("accountState");
  const message = await readDisplayMessage(tx.objectStore("displayMessages"), id, ownerId);
  if (!message || (ownerId !== undefined && !messageVisibleToAccount(message, ownerId))) { await tx.done; return null; }
  const owner = message.ownerId ?? ownerId ?? undefined;
  id = message.id;
  if ((owner && await state.get(outgoingKey(id, owner))) || await readMessageHide(state, id, owner, message) || !current()) {
    await tx.done;
    return null;
  }
  const undoToken = crypto.randomUUID(), undoDeadline = Date.now() + 5000;
  await state.put({ id: messageHideKey(id, owner), messageId: id, ownerId: owner, undoToken, undoDeadline } satisfies MessageHide);
  await noteHistoryRemoval(state, message.conversationId, owner);
  if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return null; }
  await tx.done;
  publishLocalMessageChange(id, "hide", message.conversationId);
  return { token: undoToken, deadline: undoDeadline };
}

const pendingHideTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function finishMessageHideInDB(db: IDBPDatabase, markerId: string, token: string, undo: boolean, current: () => boolean = () => true, lookup?: { id: string; ownerId?: string }): Promise<LocalMessage | undefined> {
  const cancelTimer = () => { clearTimeout(pendingHideTimers.get(token)); pendingHideTimers.delete(token); };
  const tx = db.transaction(["displayMessages", "accountState", "accountFiles"], "readwrite");
  const state = tx.objectStore("accountState"), messages = tx.objectStore("displayMessages");
  if (lookup) {
    const row = await readDisplayMessage(messages, lookup.id, lookup.ownerId);
    markerId = messageHideKey(row?.id ?? lookup.id, lookup.ownerId ?? row?.ownerId);
  }
  const hidden = await state.get(markerId) as MessageHide | undefined;
  if (hidden?.undoToken !== token) { await tx.done; cancelTimer(); return; }
  const id = hidden.messageId ?? markerId.slice(MESSAGE_HIDE_PREFIX.length);
  if (!hidden.ownerId) {
    if (!undo) await state.put({ id: markerId, messageId: id } satisfies MessageHide);
    await tx.done;
    cancelTimer();
    return;
  }
  const message = await readDisplayMessage(messages, id, hidden.ownerId);
  const displayId = message?.id ?? wireMessageId(id, hidden.ownerId);
  const expired = message && normalizeExpiryMetadata(message).expiresAt <= Date.now();
  if (undo && !current()) { await tx.done; return; }
  if (undo && message && !expired && Date.now() < (hidden.undoDeadline ?? 0)) {
    await state.delete(markerId);
    const restored = await mergeDisplayMessage(tx, message);
    const snapshot = restored.row && await readEditSnapshot(state, restored.row);
    if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return; }
    await tx.done;
    cancelTimer();
    if (restored.row && !restored.hidden) publishLocalMessageChange(displayId, "undo", restored.row.conversationId);
    return !restored.hidden && snapshot ? restoreEditSnapshot(snapshot) : undefined;
  }
  const edits = message && await readEditState(state, message);
  if (message) await mergeDisplayMessage(tx, message, { finalizeHide: true });
  const finalKey = messageHideKey(displayId, hidden.ownerId);
  if (markerId !== finalKey) await state.delete(markerId);
  await state.put({ id: finalKey, messageId: displayId, ownerId: hidden.ownerId, ...(edits?.pendingId && message && { expiresAt: normalizeExpiryMetadata(message).expiresAt }) } satisfies MessageHide);
  await tx.done;
  cancelTimer();
  publishLocalMessageChange(id, "commit", message?.conversationId);
}
export async function finishMessageHide(id: string, token: string, undo: boolean, current: () => boolean = () => true, ownerId?: string): Promise<LocalMessage | undefined> {
  return finishMessageHideInDB(await getAppDB(), messageHideKey(id, ownerId), token, undo, current, { id, ownerId });
}
/** Preserve active Undo windows and ensure reopened pages still commit at the deadline. */
export async function commitAbandonedMessageHides(db: IDBPDatabase): Promise<void> {
  const pending = await db.getAll("accountState", IDBKeyRange.bound(MESSAGE_HIDE_PREFIX, MESSAGE_HIDE_PREFIX + "\uffff")) as MessageHide[];
  for (const record of pending) {
    const { id, undoToken, undoDeadline } = record;
    if (!undoToken || undoDeadline === undefined || !Number.isFinite(undoDeadline)) continue;
    const remaining = undoDeadline - Date.now();
    if (remaining <= 0) await finishMessageHideInDB(db, id, undoToken, false);
    else if (!pendingHideTimers.has(undoToken)) {
      pendingHideTimers.set(undoToken, setTimeout(() => {
        // A failed write is retried by the unlocked periodic/teardown sweep.
        void finishMessageHideInDB(db, id, undoToken, false).catch(() => undefined);
      }, remaining));
    }
  }
}
