import { openDB, type IDBPDatabase } from "idb";
import type { SendMessageRequest, SendDirectBatchRequest, InitialMessageHeader, ExpiryKind, WSMessageFrame } from "@e2ee-chat/shared";
import { normalizeExpiryMetadata } from "../lib/message-retention.js";

const DB_NAME = "e2ee-chat";
const DB_VERSION = 5;
const OUTGOING_PREFIX = "outgoing:";

function outgoingKeyRange() {
  return IDBKeyRange.bound(OUTGOING_PREFIX, `${OUTGOING_PREFIX}\uffff`);
}

// Keep messages and the outbox in a single transaction without upgrading the
// schema. The rollback client can open version 5 and ignores these keys.
function outgoingRecord(outgoing: LocalOutgoing) {
  // A write token lets queue attempts reject stale snapshots without changing v5 stores.
  outgoing.revision = crypto.randomUUID();
  return { id: OUTGOING_PREFIX + outgoing.id, outgoing };
}

async function queuedMessageIds(store: { getAllKeys(range: IDBKeyRange): Promise<IDBValidKey[]> }) {
  const keys = await store.getAllKeys(outgoingKeyRange());
  return new Set(keys.map((key) => String(key).slice(OUTGOING_PREFIX.length)));
}

export interface LocalMessage {
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

export interface LocalSession {
  id: string; // `${userId}:${deviceId}`
  state: string; // JSON-serialized ratchet state
  updatedAt: number;
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
}

export interface CachedFile {
  id: string; // fileId
  blob: Blob; // decrypted file blob
  mimeType: string;
  fileName: string;
  cachedAt: number; // Date.now()
  expiresAt: number; // same effective expiry as the remote file
}

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getAppDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, _oldVersion, _newVersion, transaction) {
        const msgStore = db.objectStoreNames.contains("messages")
          ? transaction.objectStore("messages")
          : db.createObjectStore("messages", { keyPath: "id" });
        if (!msgStore.indexNames.contains("byConversation")) {
          msgStore.createIndex("byConversation", ["conversationId", "timestamp"]);
        }
        if (!msgStore.indexNames.contains("byTimestamp")) {
          msgStore.createIndex("byTimestamp", "timestamp");
        }
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("localKeys")) {
          db.createObjectStore("localKeys", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("conversations")) {
          db.createObjectStore("conversations", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("senderKeys")) {
          db.createObjectStore("senderKeys", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("fileCache")) {
          db.createObjectStore("fileCache", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("pendingCalls")) {
          db.createObjectStore("pendingCalls", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("senderKeyRecipients")) {
          db.createObjectStore("senderKeyRecipients", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("syncState")) {
          db.createObjectStore("syncState", { keyPath: "id" });
        }
      },
    }).catch(async (error) => {
      if (error.name !== "VersionError") throw error;
      // Pre-release clients may already have opened version 6. Keep their data.
      // v6 never shipped: an open v6 tab can still write outgoingQueue after this
      // one-time copy. Close those pre-release tabs before using this client.
      const db = await openDB(DB_NAME);
      if (db.objectStoreNames.contains("outgoingQueue")) {
        const tx = db.transaction(["outgoingQueue", "syncState"], "readwrite");
        const legacy = tx.objectStore("outgoingQueue");
        for (const outgoing of await legacy.getAll() as LocalOutgoing[]) {
          await tx.objectStore("syncState").put(outgoingRecord(outgoing));
        }
        await legacy.clear();
        await tx.done;
      }
      return db;
    });
  }
  return dbPromise;
}

export async function saveMessage(message: LocalMessage) {
  const db = await getAppDB();
  await db.put("messages", message);
}

async function readConversationMessagePage(
  conversationId: string,
  limit: number,
  before?: number,
): Promise<{ messages: LocalMessage[]; hasOlder: boolean }> {
  const db = await getAppDB();
  const tx = db.transaction(["messages", "syncState"], "readonly");
  const index = tx.objectStore("messages").index("byConversation");
  const queuedIds = await queuedMessageIds(tx.objectStore("syncState"));
  const upperBound = before === undefined
    ? [conversationId, Number.MAX_SAFE_INTEGER]
    : [conversationId, Math.max(0, before - 1)];
  const range = IDBKeyRange.bound([conversationId, 0], upperBound);
  const page: LocalMessage[] = [];

  let cursor = await index.openCursor(range, "prev");
  while (cursor && page.length < limit + 1) {
    page.push({ ...cursor.value as LocalMessage, hasOutgoingEntry: queuedIds.has(cursor.value.id) });
    cursor = await cursor.continue();
  }

  await tx.done;

  return {
    messages: page.slice(0, limit).reverse(),
    hasOlder: page.length > limit,
  };
}

export async function getMessages(conversationId: string, limit = 100): Promise<LocalMessage[]> {
  const page = await readConversationMessagePage(conversationId, limit);
  return page.messages;
}

export async function getCachedConversationMessagesPage(
  conversationId: string,
  options?: { before?: number; limit?: number },
): Promise<{ messages: LocalMessage[]; hasOlder: boolean }> {
  return readConversationMessagePage(conversationId, options?.limit ?? 100, options?.before);
}

export async function getLatestCachedMessageTimestamp(): Promise<number> {
  const db = await getAppDB();
  const tx = db.transaction("messages", "readonly");
  const index = tx.store.index("byTimestamp");
  const cursor = await index.openCursor(null, "prev");
  await tx.done;
  return cursor ? (cursor.value as LocalMessage).timestamp : 0;
}

export async function saveSyncState(id: string, value: number, cursorId?: string): Promise<void> {
  const db = await getAppDB();
  await db.put("syncState", {
    id,
    value,
    cursorId,
    updatedAt: Date.now(),
  } satisfies LocalSyncState);
}

export async function getSyncState(id: string): Promise<LocalSyncState | undefined> {
  const db = await getAppDB();
  return db.get("syncState", id);
}

export async function saveSession(session: LocalSession) {
  const db = await getAppDB();
  await db.put("sessions", session);
}

export async function getSession(id: string): Promise<LocalSession | undefined> {
  const db = await getAppDB();
  return db.get("sessions", id);
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
  return db.get("senderKeys", id);
}

export async function saveSenderKey(key: LocalSenderKey): Promise<void> {
  const db = await getAppDB();
  await db.put("senderKeys", key);
}

export interface ReceiveEffects {
  failure?: "invalid_sender_key_distribution" | "terminal_receive_error";
  expiresAt: number | null;
  message?: LocalMessage;
  senderKey?: LocalSenderKey;
  pendingCall?: LocalPendingCall;
}

export interface LocalReceiveReceipt {
  id: string;
  expiresAt: number | null;
  failure?: ReceiveEffects["failure"];
  pendingCallId?: string;
}

const RECEIVED_PREFIX = "received:";
const PENDING_RECEIVE_PREFIX = "pending-receive:";

export async function getReceiveReceipt(id: string): Promise<LocalReceiveReceipt | undefined> {
  return (await getAppDB()).get("syncState", RECEIVED_PREFIX + id);
}

/** Missing group keys defer only encrypted envelopes; no ratchet has advanced yet. */
export async function savePendingReceive(frame: WSMessageFrame, userId: string | undefined, deviceId: string | undefined): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction(["messages", "syncState"], "readwrite");
  await Promise.all([tx.done, (async () => {
    const store = tx.objectStore("syncState");
    if (!await tx.objectStore("messages").get(frame.id) && !await store.get(RECEIVED_PREFIX + frame.id)) {
      await store.put({ id: PENDING_RECEIVE_PREFIX + frame.id, userId, deviceId, frame });
    }
  })()]);
}

export async function getPendingReceives(userId: string | undefined, deviceId: string | undefined): Promise<WSMessageFrame[]> {
  const db = await getAppDB();
  const records = await db.getAll("syncState", IDBKeyRange.bound(PENDING_RECEIVE_PREFIX, `${PENDING_RECEIVE_PREFIX}\uffff`));
  return records.filter((record) => record.userId === userId && record.deviceId === deviceId).map((record) => record.frame);
}

export async function hasReceivedMessage(id: string): Promise<boolean> {
  const db = await getAppDB();
  return !!(await db.get("messages", id) || await db.get("syncState", RECEIVED_PREFIX + id));
}

/** All crypto must finish before entering this transaction: only IDB awaits belong here. */
export async function commitReceivedMessage(
  id: string,
  effects: ReceiveEffects,
  state: { session?: LocalSession; senderKey?: LocalSenderKey } = {},
): Promise<boolean> {
  const db = await getAppDB();
  const tx = db.transaction(["messages", "sessions", "senderKeys", "pendingCalls", "syncState"], "readwrite");
  // Observe aborts even when an individual request rejects first.
  const done = tx.done;
  void done.catch(() => undefined);
  try {
    if (await tx.objectStore("messages").get(id) || await tx.objectStore("syncState").get(RECEIVED_PREFIX + id)) {
      await tx.objectStore("syncState").delete(PENDING_RECEIVE_PREFIX + id);
      await done;
      return false;
    }
    await tx.objectStore("syncState").delete(PENDING_RECEIVE_PREFIX + id);
    if (state.session) await tx.objectStore("sessions").put(state.session);
    if (state.senderKey) await tx.objectStore("senderKeys").put(state.senderKey);
    // Repeated distributions must never reset an already advanced sender chain.
    if (effects.senderKey && !await tx.objectStore("senderKeys").get(effects.senderKey.id)) {
      await tx.objectStore("senderKeys").put(effects.senderKey);
    }
    if (effects.pendingCall) await tx.objectStore("pendingCalls").put(effects.pendingCall);
    if (effects.message) {
      await tx.objectStore("messages").put(effects.message);
    } else {
      // Control frames need durable dedupe without retaining their decrypted keys/payloads.
      await tx.objectStore("syncState").put({
        id: RECEIVED_PREFIX + id, expiresAt: effects.expiresAt,
        ...(effects.failure ? { failure: effects.failure } : {}),
        ...(effects.pendingCall ? { pendingCallId: effects.pendingCall.id } : {}),
      } satisfies LocalReceiveReceipt);
    }
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
  await db.delete("sessions", id);
}

export async function saveKey(key: LocalKey) {
  const db = await getAppDB();
  await db.put("localKeys", key);
}

export async function getKey(id: string): Promise<LocalKey | undefined> {
  const db = await getAppDB();
  return db.get("localKeys", id);
}

export async function saveKeys(keys: LocalKey[]): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction("localKeys", "readwrite");
  await Promise.all([...keys.map((key) => tx.store.put(key)), tx.done]);
}

export async function clearAll() {
  const db = await getAppDB();
  const tx = db.transaction(db.objectStoreNames, "readwrite");
  for (const name of db.objectStoreNames) {
    tx.objectStore(name).clear();
  }
  await tx.done;
}

export async function clearCryptoState() {
  const db = await getAppDB();
  const tx = db.transaction(["sessions", "localKeys", "senderKeys", "senderKeyRecipients"], "readwrite");
  tx.objectStore("sessions").clear();
  tx.objectStore("localKeys").clear();
  tx.objectStore("senderKeys").clear();
  tx.objectStore("senderKeyRecipients").clear();
  await tx.done;
}

export async function savePendingCall(call: LocalPendingCall): Promise<void> {
  const db = await getAppDB();
  await db.put("pendingCalls", call);
}

export async function getPendingCall(id: string): Promise<LocalPendingCall | undefined> {
  const db = await getAppDB();
  return db.get("pendingCalls", id);
}

export async function deletePendingCall(id: string): Promise<void> {
  const db = await getAppDB();
  await db.delete("pendingCalls", id);
}

export async function getCachedFile(id: string): Promise<CachedFile | undefined> {
  const db = await getAppDB();
  return db.get("fileCache", id);
}

export async function setCachedFile(file: CachedFile): Promise<void> {
  const db = await getAppDB();
  await db.put("fileCache", file);
}

export async function cleanupExpiredFileCache(now = Date.now()): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction("fileCache", "readwrite");
  const store = tx.objectStore("fileCache");
  const files = await store.getAll();
  for (const file of files as CachedFile[]) {
    if (file.expiresAt < now) {
      await store.delete(file.id);
    }
  }
  await tx.done;
}

export async function cleanupExpiredPendingCalls(now = Date.now()): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction("pendingCalls", "readwrite");
  const store = tx.objectStore("pendingCalls");
  const calls = await store.getAll();
  for (const call of calls as LocalPendingCall[]) {
    if (call.expiresAt <= now) {
      await store.delete(call.id);
    }
  }
  await tx.done;
}

function extractFileIdFromMessage(message: LocalMessage): string | null {
  if (message.type !== "file") return null;
  try {
    const parsed = JSON.parse(message.content) as { fileId?: unknown };
    return typeof parsed.fileId === "string" ? parsed.fileId : null;
  } catch {
    return null;
  }
}

export async function cleanupExpiredMessages(now = Date.now()): Promise<string[]> {
  const db = await getAppDB();
  const tx = db.transaction(["messages", "fileCache", "syncState"], "readwrite");
  const messageStore = tx.objectStore("messages");
  const fileCacheStore = tx.objectStore("fileCache");
  const messages = await messageStore.getAll();
  // A queued message's expiry is only an estimate: the server starts the TTL when it accepts the
  // send. Its display record is also the only copy of the content the queue still has to send.
  const queuedIds = await queuedMessageIds(tx.objectStore("syncState"));
  const deletedIds: string[] = [];
  const syncStore = tx.objectStore("syncState");
  const receipts = await syncStore.getAll(IDBKeyRange.bound(RECEIVED_PREFIX, `${RECEIVED_PREFIX}\uffff`));
  for (const receipt of receipts) {
    if (receipt.expiresAt !== null && receipt.expiresAt <= now) await syncStore.delete(receipt.id);
  }

  const pending = await syncStore.getAll(IDBKeyRange.bound(PENDING_RECEIVE_PREFIX, `${PENDING_RECEIVE_PREFIX}\uffff`));
  for (const record of pending) {
    if (record.frame.expiresAt !== null && record.frame.expiresAt <= now) await syncStore.delete(record.id);
  }

  for (const message of messages as LocalMessage[]) {
    const { expiresAt } = normalizeExpiryMetadata(message);
    if (expiresAt > now || queuedIds.has(message.id)) continue;
    deletedIds.push(message.id);
    await messageStore.delete(message.id);

    const fileId = extractFileIdFromMessage(message);
    if (fileId) {
      await fileCacheStore.delete(fileId).catch(() => undefined);
    }
  }

  await tx.done;
  return deletedIds;
}

// Message pipeline lookups (kept separate from key storage helpers).
export async function getMessageById(id: string): Promise<LocalMessage | undefined> {
  const db = await getAppDB();
  return db.get("messages", id);
}


/** Envelopes and encrypted upload bytes only. Display content stays in `messages`. */
export interface OutgoingStep {
  path: "/api/messages/send" | "/api/messages/send-direct-batch";
  body: SendMessageRequest | SendDirectBatchRequest;
  distributed?: { senderDeviceId: string; senderKeyId: number; recipientDeviceIds: string[] };
  completed?: boolean;
}
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
  fileId?: string;
  upload?: { bytes: Uint8Array; mimeType: string; uploadUrl?: string; uploaded?: boolean };
  steps: OutgoingStep[];
  attempts: number;
  status: "sending" | "failed";
  retryable: boolean;
  nextAttemptAt: number | null;
  error: string | null;
}
export async function saveOutgoing(outgoing: LocalOutgoing): Promise<void> {
  const db = await getAppDB();
  await db.put("syncState", outgoingRecord(outgoing));
}
export async function getOutgoing(id: string): Promise<LocalOutgoing | undefined> {
  const db = await getAppDB();
  return (await db.get("syncState", OUTGOING_PREFIX + id))?.outgoing;
}
export async function getAllOutgoing(): Promise<LocalOutgoing[]> {
  const db = await getAppDB();
  return (await db.getAll("syncState", outgoingKeyRange())).map((record) => record.outgoing);
}
export async function deleteOutgoing(id: string): Promise<void> {
  const db = await getAppDB();
  await db.delete("syncState", OUTGOING_PREFIX + id);
}
/** Retire only an unsendable orphan, checking current queue/display state atomically. */
export async function retireUnsendableOutgoing(id: string): Promise<LocalOutgoing | undefined> {
  const db = await getAppDB();
  const tx = db.transaction(["messages", "syncState"], "readwrite");
  const queue = tx.objectStore("syncState");
  const row = (await queue.get(OUTGOING_PREFIX + id))?.outgoing as LocalOutgoing | undefined;
  const message = await tx.objectStore("messages").get(id);
  const hasEnvelope = row?.steps.some((step) => step.path === "/api/messages/send" || step.body.type !== "sender_key_distribution");
  if (!row || message || (row.retryable && hasEnvelope)) { await tx.done; return undefined; }
  // Encrypted upload bytes live only in this record, so deleting it retires them too.
  await queue.delete(OUTGOING_PREFIX + id);
  await tx.done;
  return row;
}
/** Commit the display record and its outbox entry together before making network requests. */
export async function saveQueuedMessage(message: LocalMessage, outgoing: LocalOutgoing): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction(["messages", "syncState"], "readwrite");
  const queue = tx.objectStore("syncState");
  const existing = (await queue.get(OUTGOING_PREFIX + outgoing.id))?.outgoing as LocalOutgoing | undefined;
  if (existing) {
    outgoing.queuedAt = existing.queuedAt;
  } else {
    const pending = await queue.getAll(outgoingKeyRange());
    outgoing.queuedAt = Math.max(outgoing.queuedAt, ...pending.map((entry) => entry.outgoing.queuedAt + 1));
  }
  await Promise.all([tx.objectStore("messages").put(message), queue.put(outgoingRecord(outgoing)), tx.done]);
}
export async function discardQueuedMessage(id: string): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction(["messages", "syncState"], "readwrite");
  await Promise.all([tx.objectStore("messages").delete(id), tx.objectStore("syncState").delete(OUTGOING_PREFIX + id), tx.done]);
}


/** Update an existing outbox entry atomically, without resurrecting another tab's discard. */
export async function updateOutgoingIfPresent(outgoing: LocalOutgoing, message?: LocalMessage, options: { ifUnchanged?: boolean } = {}): Promise<boolean> {
  const db = await getAppDB();
  const tx = db.transaction(["messages", "syncState"], "readwrite");
  const queue = tx.objectStore("syncState");
  const current = (await queue.get(OUTGOING_PREFIX + outgoing.id))?.outgoing as LocalOutgoing | undefined;
  if (!current || (options.ifUnchanged && current.revision !== outgoing.revision)) { await tx.done; return false; }
  await queue.put(outgoingRecord(outgoing));
  if (message) await tx.objectStore("messages").put(message);
  await tx.done;
  return true;
}
export async function completeOutgoingIfPresent(outgoing: LocalOutgoing, message?: LocalMessage, options: { ifUnchanged?: boolean } = {}): Promise<boolean> {
  const db = await getAppDB();
  const tx = db.transaction(["messages", "syncState"], "readwrite");
  const queue = tx.objectStore("syncState");
  const current = (await queue.get(OUTGOING_PREFIX + outgoing.id))?.outgoing as LocalOutgoing | undefined;
  if (!current || (options.ifUnchanged && current.revision !== outgoing.revision)) { await tx.done; return false; }
  if (message) await tx.objectStore("messages").put(message);
  await queue.delete(OUTGOING_PREFIX + outgoing.id);
  await tx.done;
  return true;
}

/** Normalize a legacy queue diagnostic without overwriting concurrent send progress. */
export async function updateOutgoingErrorIfUnchanged(id: string, previous: string, next: string): Promise<void> {
  const db = await getAppDB();
  const tx = db.transaction("syncState", "readwrite");
  const row = (await tx.store.get(OUTGOING_PREFIX + id))?.outgoing as LocalOutgoing | undefined;
  if (row?.error === previous) await tx.store.put(outgoingRecord({ ...row, error: next }));
  await tx.done;
}
