import {
  MAX_FILE_SIZE,
  MESSAGE_RETENTION_MS,
  historyTransferConversationSchema,
  historyTransferEntrySchema,
  historyTransferFileMetadataSchema,
  historyTransferMessageSchema,
  historyOwnershipCandidateSchema,
  HISTORY_DELETION_BATCH_SIZE,
  HISTORY_OWNERSHIP_BATCH_SIZE,
  transferredMessageId,
  type ConversationWithMembers,
  type HistoryTransferEntry,
  type HistoryOwnershipCandidate,
  type HistoryDeletionLookup,
  type HistoryTransferAddition,
  type HistoryTransferSpaceItem,
} from "@e2ee-chat/shared";
import { normalizeExpiryMetadata } from "../lib/message-retention.js";
import { publishLocalMessageChange } from "../lib/local-message-changes.js";
import { openCachedAttachment, sealCachedAttachment } from "../lib/key-manager.js";
import {
  MESSAGE_DELETION_PREFIX, deletionMatches, extractFileIdFromMessage, messageDeletionWireId,
  importedDeletionPrefix, type ImportedDeletionCandidate,
  getAppDB, HISTORY_REMOVAL_GENERATION_KEY, historyConversationKey, historyRemovalKey,
  getCachedFile, readCachedFile, readDisplayMessage, readHistoryMessageBarriers, writeCachedFile, mergeDisplayMessage, mergeDisplayDeletion, promoteLegacyEditState,
  hasQueuedMessage, redactMessage, wireMessageId, type CachedFile, type LocalMessage,
} from "./index.js";
import { ownsHistoryTransferLease, recordHistoryTransferAdditions, type HistoryTransferImportContext } from "./history-transfer-progress.js";

export interface HistoryTransferSelection {
  conversationId: string;
  includeAttachments?: boolean;
}

export interface HistoryTransferAttachmentSource {
  size: number;
  open(): Promise<Blob>;
}

export interface HistoryTransferItem {
  entry: HistoryTransferEntry;
  blob?: Blob;
  attachmentSource?: HistoryTransferAttachmentSource;
}

export type HistoryDisclosureCandidate = HistoryDeletionLookup & { displayId: string; direct?: boolean };

export async function estimateHistoryStorage(ownerId: string, items: readonly HistoryTransferSpaceItem[]): Promise<number> {
  const tx = (await getAppDB()).transaction(["displayMessages", "accountConversations", "accountState", "accountFiles"]);
  const cached: Array<{ id: string; size: number; sealed: NonNullable<CachedFile["sealed"]> }> = [];
  let bytes = 0;
  for (const item of items) {
    const chat = await tx.objectStore("accountConversations").get(historyConversationKey(ownerId, item.conversationId));
    const unavailable = chat?.hidden || chat?.deleted || chat?.deletedAt != null;
    if (item.kind === "conversation") {
      // The manifest creates checkpoint state even for conversations the receiver hides.
      bytes += item.checkpointBytes;
      if (!unavailable && (!chat || chat.conversation.updatedAt < item.updatedAt)) bytes += item.bytes;
      continue;
    }
    if (unavailable) continue;
    const row = await readDisplayMessage(tx.objectStore("displayMessages"), item.id, ownerId, item.direct);
    if (row && !deletionMatches(row, { ...item, deletedByUserId: item.senderId })) continue;
    const barriers = await readHistoryMessageBarriers(tx.objectStore("accountState"), row ?? item, ownerId, item.direct);
    if (barriers.hidden || barriers.deletion || row?.deletedAt != null) continue;
    if (!row || row.status === "failed" || (item.editedAt ?? 0) > (row.editedAt ?? 0)) bytes += item.bytes;
    if (item.attachment) {
      const file = await readCachedFile(tx.objectStore("accountFiles"), item.attachment.id, ownerId);
      if (file?.sealed && file.expiresAt > Date.now() && file.sealed.ciphertext.size === item.attachment.bytes + 16) {
        cached.push({ id: item.attachment.id, size: item.attachment.bytes, sealed: file.sealed });
      }
      else bytes += item.attachment.bytes;
    }
  }
  await tx.done;
  for (const { id, size, sealed } of cached) {
    try { if ((await openCachedAttachment(ownerId, id, sealed)).size === size) continue; }
    catch { /* An unreadable copy needs to be replaced. */ }
    bytes += size;
  }
  return bytes;
}

function couldExport(row: LocalMessage, now: number): boolean {
  return (row.type === "text" || row.type === "file") && row.status !== "sending"
    && (row.status !== "failed" || row.deletedAt != null) && normalizeExpiryMetadata(row).expiresAt > now;
}

function legacyHistoryRange(conversationId: string): IDBKeyRange {
  return IDBKeyRange.bound([conversationId, 0], [conversationId, Number.MAX_SAFE_INTEGER]);
}

export async function hasQuarantinedHistory(conversationId: string): Promise<boolean> {
  return (await (await getAppDB()).countFromIndex("legacyMessages", "byConversation", legacyHistoryRange(conversationId))) > 0;
}

export async function unverifiedLegacyCount(ownerId: string, chat: Pick<ConversationWithMembers, "id" | "type">, now = Date.now()): Promise<number> {
  const db = await getAppDB();
  let total = 0;
  let after: { key: IDBValidKey; primary: IDBValidKey } | undefined;
  const end = [chat.id, Number.MAX_SAFE_INTEGER];
  do {
    const tx = db.transaction(["legacyMessages", "accountState"], "readonly");
    const state = tx.objectStore("accountState");
    const index = tx.objectStore("legacyMessages").index("byConversation");
    let cursor = await index.openCursor(IDBKeyRange.bound(after?.key ?? [chat.id, 0], end));
    if (cursor && after && indexedDB.cmp(cursor.key, after.key) === 0) {
      if (indexedDB.cmp(cursor.primaryKey, after.primary) < 0) cursor = await cursor.continuePrimaryKey(after.key, after.primary);
      if (cursor && indexedDB.cmp(cursor.key, after.key) === 0 && indexedDB.cmp(cursor.primaryKey, after.primary) === 0) cursor = await cursor.continue();
    }
    for (let n = 0; cursor && n < 100; n++) {
      const row = cursor.value as LocalMessage;
      after = { key: cursor.key, primary: cursor.primaryKey };
      if ((!row.ownerId || row.ownerId === ownerId) && couldExport(row, now)) {
        const { hidden, deletion } = await readHistoryMessageBarriers(state, row, ownerId, chat.type === "direct");
        if (!hidden && (!deletion || row.deletedAt != null)) total++;
      }
      cursor = await cursor.continue();
    }
    if (!cursor) after = undefined;
    await tx.done;
  } while (after);
  return total;
}

export async function verifyLegacyHistoryOwnership(
  ownerId: string,
  conversations: readonly Pick<ConversationWithMembers, "id" | "type">[],
  verify: (messages: HistoryOwnershipCandidate[]) => Promise<readonly string[]>,
  current: () => boolean,
  now = Date.now(),
  onReplaced?: (ids: ReadonlySet<string>) => Promise<void>,
): Promise<void> {
  const db = await getAppDB();
  for (const { id: conversationId, type } of conversations) {
    if (!current()) return;
    const direct = type === "direct";
    const range = legacyHistoryRange(conversationId);
    const candidates = (await db.getAllFromIndex("legacyMessages", "byConversation", range) as LocalMessage[])
      .filter((row) => (!row.ownerId || row.ownerId === ownerId) && couldExport(row, now))
      .flatMap((row) => {
        const parsed = historyOwnershipCandidateSchema.safeParse({
          id: wireMessageId(row.wireId ?? row.id, ownerId), conversationId: row.conversationId,
          senderId: row.senderId, timestamp: row.timestamp, type: row.type, deletedAt: row.deletedAt ?? null,
        });
        return parsed.success ? [{ row, request: parsed.data }] : [];
      });
    // The endpoint responds with IDs. An ambiguous local duplicate cannot use
    // another row's result as proof of its own metadata.
    const seen = new Set<string>(), ambiguous = new Set<string>();
    for (const { request: { id } } of candidates) {
      if (seen.has(id)) ambiguous.add(id);
      seen.add(id);
    }
    const unique = candidates.filter(({ request }) => !ambiguous.has(request.id));
    for (let offset = 0; offset < unique.length && current(); offset += HISTORY_OWNERSHIP_BATCH_SIZE) {
      const batch = unique.slice(offset, offset + HISTORY_OWNERSHIP_BATCH_SIZE);
      let verified: Set<string>;
      try { verified = new Set(await verify(batch.map(({ request }) => request))); }
      catch { return; } // Leave unverified rows in quarantine.
      if (!current()) return;
      const tx = db.transaction(["legacyMessages", "displayMessages", "accountState", "accountFiles"], "readwrite");
      const legacy = tx.objectStore("legacyMessages"), state = tx.objectStore("accountState");
      const replaced = new Set<string>();
      for (const { row: previous, request } of batch) {
        if (!verified.has(request.id)) continue;
        const row = await legacy.get(previous.id) as LocalMessage | undefined;
        if (!row || JSON.stringify(row) !== JSON.stringify(previous) || !couldExport(row, Math.max(now, Date.now()))) continue;
        const barriers = await readHistoryMessageBarriers(state, row, ownerId, direct);
        if (barriers.hidden || (barriers.deletion && row.deletedAt == null)) continue;
        const promoted = { ...row, ownerId, direct, wireId: request.id };
        if (row.deletedAt != null) {
          const result = await mergeDisplayDeletion(tx, request.id, ownerId, {
            conversationId, senderId: row.senderId, deletedAt: row.deletedAt, deletedByUserId: row.deletedByUserId ?? row.senderId,
          }, direct, promoted);
          if (result.accepted) await legacy.delete(row.id);
          if (result.changed && result.row) replaced.add(result.row.id);
        } else {
          const result = await mergeDisplayMessage(tx, promoted, { imported: true, now });
          if (result.row) {
            await promoteLegacyEditState(state, row.id, result.row);
            await legacy.delete(row.id);
          }
          if (result.replaced && result.row) replaced.add(result.row.id);
        }
      }
      if (!current()) { tx.abort(); await tx.done.catch(() => undefined); return; }
      await tx.done;
      if (replaced.size && current()) {
        for (const id of replaced) publishLocalMessageChange(id, "repair", conversationId);
        await onReplaced?.(replaced);
      }
    }
  }
}

export interface HistoryArchiveRevisions {
  selected: ReadonlyMap<string, string | undefined>;
  generation: string | undefined;
}

export async function historyArchiveIsCurrent(revisions: HistoryArchiveRevisions, preflight = false): Promise<boolean> {
  const tx = (await getAppDB()).transaction("accountState", "readonly");
  const generation = (await tx.store.get(HISTORY_REMOVAL_GENERATION_KEY))?.revision;
  // Hints stop a selected archive immediately. The durable generation also
  // catches changes from a tab whose hint is delayed or missing.
  const current = (!preflight && generation === revisions.generation)
    || (await Promise.all([...revisions.selected].map(async ([key, revision]) => (await tx.store.get(key))?.revision === revision))).every(Boolean);
  await tx.done;
  if (current) revisions.generation = generation;
  return current;
}

type Deletion = Extract<HistoryTransferEntry, { kind: "deletion" }> & { transferSourceId?: string; ownerId?: string };
export interface HistoryImportSource { fromDeviceId: string; deviceName: string; at: number }
export interface HistoryTransferMarker extends HistoryImportSource { conversationId: string }

export async function getHistoryTransferMarkers(userId: string, conversationId: string): Promise<HistoryTransferMarker[]> {
  const prefix = `transfer-marker:${JSON.stringify([userId, conversationId])}:`;
  const rows = await (await getAppDB()).getAll("accountState", IDBKeyRange.bound(prefix, prefix + "\uffff"));
  return rows.map(({ marker }) => marker);
}

const DELETION_POLL_MS = 30_000;

/** A durable reservation shares the polling budget between tabs and survives a rate limit or reload. */
export async function reserveImportedDeletionPoll(key: string, now = Date.now()) {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const previous = await tx.store.get(key);
  if (previous?.value > now) { await tx.done; return undefined; }
  const reservation = { id: key, value: now + DELETION_POLL_MS, updatedAt: now, cursorId: previous?.cursorId as string | undefined };
  await tx.store.put(reservation);
  await tx.done;
  return reservation;
}

function importedConversationRange(ownerId: string): IDBKeyRange {
  const prefix = `history:${JSON.stringify([ownerId]).slice(0, -1)},`;
  return IDBKeyRange.bound(prefix, prefix + "\uffff");
}

export async function getImportedConversationIds(ownerId: string): Promise<string[]> {
  const snapshots = await (await getAppDB()).getAll("accountConversations", importedConversationRange(ownerId));
  return snapshots.filter((row) => row.userId === ownerId).map((row) => row.conversation.id);
}

export async function importedDeletionPage(ownerId: string, after?: string, now = Date.now()) {
  const prefix = importedDeletionPrefix(ownerId);
  // Old cursors contained bare message IDs, so restart them at the start of the scoped index.
  const continuation = after?.startsWith(prefix) ? after : undefined;
  const range = IDBKeyRange.bound(continuation ?? prefix, prefix + "\uffff", !!continuation);
  const db = await getAppDB();
  const tx = db.transaction("accountState", "readwrite");
  const rows = await tx.store.getAll(range, HISTORY_DELETION_BATCH_SIZE + 1) as ImportedDeletionCandidate[];
  const candidates: { displayId: string; id: string; conversationId: string; senderId: string }[] = [];
  for (const row of rows.slice(0, HISTORY_DELETION_BATCH_SIZE)) {
    if (row.expiresAt <= now || !transferredMessageId.safeParse(row.wireId).success) await tx.store.delete(row.id);
    else candidates.push({ displayId: row.displayId, id: row.wireId, conversationId: row.conversationId, senderId: row.senderId });
  }
  await tx.done;
  return { candidates, cursorId: rows.length > HISTORY_DELETION_BATCH_SIZE ? rows[HISTORY_DELETION_BATCH_SIZE - 1].id : undefined };
}

export async function selectedImportedDeletionCandidates(ownerId: string, chats: ReadonlySet<string>, now = Date.now()) {
  const prefix = importedDeletionPrefix(ownerId);
  const rows = await (await getAppDB()).getAll("accountState", IDBKeyRange.bound(prefix, prefix + "\uffff")) as ImportedDeletionCandidate[];
  return rows.filter((row) => row.expiresAt > now && chats.has(row.conversationId) && transferredMessageId.safeParse(row.wireId).success);
}

export async function advanceImportedDeletionPoll(reservation: NonNullable<Awaited<ReturnType<typeof reserveImportedDeletionPoll>>>, cursorId?: string) {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const current = await tx.store.get(reservation.id);
  if (current?.value === reservation.value) await tx.store.put({ ...reservation, cursorId });
  await tx.done;
}

function ownedConversation(value: unknown, userId: string): ConversationWithMembers | undefined {
  const parsed = historyTransferConversationSchema.safeParse(value);
  if (parsed.success && parsed.data.members.some((member) => member.userId === userId && member.conversationId === parsed.data.id)) {
    return parsed.data;
  }
}

function fileMetadata(content: string) {
  try {
    const parsed = historyTransferFileMetadataSchema.safeParse(JSON.parse(content));
    if (parsed.success) return parsed.data;
  } catch { /* Legacy or invalid attachment metadata. */ }
}

export function acceptsHistoryTransfer(chat: ConversationWithMembers, userId: string): boolean {
  return chat.members.some((member) => member.conversationId === chat.id && member.userId === userId && member.acceptedAt !== null);
}

export async function historyTransferCatalog(userId: string, currentConversations: readonly ConversationWithMembers[], now = Date.now()) {
  const db = await getAppDB();
  const conversations = currentConversations.filter((chat) => acceptsHistoryTransfer(chat, userId));
  const encoder = new TextEncoder();
  const result = [];
  for (const chat of conversations) {
    const hidden = (await db.get("accountConversations", historyConversationKey(userId, chat.id)))?.hidden === true;
    const peer = chat.members.find((member) => member.userId !== userId)?.user;
    const row = { id: chat.id, name: chat.name || peer?.displayName, avatarUrl: chat.avatarUrl ?? peer?.avatarUrl,
      updatedAt: chat.updatedAt, hidden, messages: 0, bytes: encoder.encode(JSON.stringify(chat)).length + 32,
      cachedBytes: 0, files: 0, cachedFiles: 0, pendingLegacyMessages: await unverifiedLegacyCount(userId, chat, now) };
    const end = [userId, chat.id, Number.MAX_SAFE_INTEGER, "\uffff"];
    let after: IDBValidKey | undefined;
    for (;;) {
      const tx = db.transaction(["displayMessages", "accountState", "accountFiles"], "readonly");
      const state = tx.objectStore("accountState");
      const index = tx.objectStore("displayMessages").index("byAccountConversation");
      const range = IDBKeyRange.bound(after ?? [userId, chat.id, 0], end, after !== undefined);
      let cursor = await index.openCursor(range);
      for (let count = 0; cursor && count < 100; count++) {
        const message = cursor.value as LocalMessage;
        after = cursor.key;
        if (couldExport(message, now) && !await hasQueuedMessage(state, message.id, userId)) {
          const { hidden, deletion } = await readHistoryMessageBarriers(state, message, userId, chat.type === "direct");
          if (!hidden) {
            row.messages++;
            row.bytes += encoder.encode(JSON.stringify(deletion ? redactMessage(message, deletion) : message)).length + 32;
            const fileId = !deletion && message.type === "file" && extractFileIdFromMessage(message);
            if (fileId) {
              row.files++;
              const file = await readCachedFile(tx.objectStore("accountFiles"), fileId, userId);
              if (file?.sealed && file.expiresAt > now) {
                row.cachedFiles++;
                row.cachedBytes += file.sealed.ciphertext.size;
              }
            }
          }
        }
        cursor = await cursor.continue();
      }
      const more = !!cursor;
      await tx.done;
      if (!more) break;
    }
    result.push(row);
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read bounded pages and reject the archive if any selected removal revision changed. */
export async function exportHistoryTransfer(
  userId: string,
  currentConversations: readonly ConversationWithMembers[],
  selection?: readonly HistoryTransferSelection[],
  now = Date.now(),
): Promise<{ items: HistoryTransferItem[]; candidates: HistoryDisclosureCandidate[]; skippedLegacy: ReadonlyMap<string, number>; missingFiles: ReadonlyMap<string, string[]>; revisions: HistoryArchiveRevisions }> {
  const db = await getAppDB();
  const conversations = new Map<string, ConversationWithMembers>();
  const items: HistoryTransferItem[] = [];
  const candidates: HistoryDisclosureCandidate[] = [];
  const skippedLegacy = new Map<string, number>();
  const missingFiles = new Map<string, string[]>();
  const selectedRevisions = new Map<string, string | undefined>();
  const revisions: HistoryArchiveRevisions = { selected: selectedRevisions, generation: undefined };
  for (const current of currentConversations) {
    const conversation = ownedConversation(current, userId);
    if (conversation && acceptsHistoryTransfer(conversation, userId)) conversations.set(conversation.id, conversation);
  }
  const selected = new Map(selection?.map((chat) => [chat.conversationId, !!chat.includeAttachments])
    ?? [...conversations.keys()].map((id) => [id, false]));
  if ([...selected.keys()].some((id) => !conversations.has(id))) throw new Error("Selected conversation metadata unavailable");
  const baseline = db.transaction("accountState");
  for (const owner of [undefined, userId]) for (const chat of [undefined, ...selected.keys()]) {
    const key = historyRemovalKey(chat, owner);
    selectedRevisions.set(key, (await baseline.store.get(key))?.revision);
  }
  revisions.generation = (await baseline.store.get(HISTORY_REMOVAL_GENERATION_KEY))?.revision;
  const deletions = await baseline.store.getAll(IDBKeyRange.bound(MESSAGE_DELETION_PREFIX, MESSAGE_DELETION_PREFIX + "\uffff"));
  await baseline.done;
  const deletionsById = new Map<string, Deletion>();
  for (const deletion of deletions) {
    if (deletion.ownerId !== userId) continue;
    const parsed = historyTransferEntrySchema.safeParse({
      ...deletion, kind: "deletion", id: deletion.transferSourceId ?? messageDeletionWireId(deletion.id, userId),
      senderId: deletion.senderId ?? deletion.deletedByUserId,
    });
    if (parsed.success && parsed.data.kind === "deletion") deletionsById.set(parsed.data.id, parsed.data);
  }
  for (const [conversationId, includeAttachments] of selected) {
    const conversation = conversations.get(conversationId)!;
    items.push({ entry: { kind: "conversation", conversation } });
    const skipped = await unverifiedLegacyCount(userId, conversation, now);
    if (skipped) skippedLegacy.set(conversationId, skipped);
    const end = [userId, conversationId, Number.MAX_SAFE_INTEGER, "\uffff"];
    let after: IDBValidKey | undefined;
    do {
      const tx = db.transaction(["displayMessages", "accountState", "accountFiles"], "readonly");
      const state = tx.objectStore("accountState");
      const index = tx.objectStore("displayMessages").index("byAccountConversation");
      let cursor = await index.openCursor(IDBKeyRange.bound(after ?? [userId, conversationId, 0], end, after !== undefined));
      for (let n = 0; cursor && n < 100; n++) {
        const row = cursor.value as LocalMessage;
        after = cursor.key;
        cursor = await cursor.continue();
        if (!couldExport(row, now) || await hasQueuedMessage(state, row.id, userId)) continue;
        const expiry = normalizeExpiryMetadata(row);
        const { hidden, deletion } = await readHistoryMessageBarriers(state, row, userId, conversation.type === "direct");
        if (hidden) continue;
        const id = row.transferSourceId ?? row.wireId ?? row.id;
        const parsed = historyTransferMessageSchema.safeParse({ ...(deletion ? redactMessage(row, deletion) : row), id, ...expiry });
        if (!parsed.success || (!deletion && parsed.data.status === "failed")) continue;
        const message = parsed.data;
        const metadata = message.type === "file" && !deletion ? fileMetadata(message.content) : undefined;
        if (message.type === "file" && !deletion && !metadata) continue;
        if (metadata) message.content = JSON.stringify(metadata);
        const file = includeAttachments && metadata
          ? await readCachedFile(tx.objectStore("accountFiles"), metadata.fileId, userId) : undefined;
        const entry: Extract<HistoryTransferEntry, { kind: "message" }> = { kind: "message", message };
        const item: HistoryTransferItem = { entry };
        items.push(item);
        if (!deletion) candidates.push({ id, conversationId, senderId: row.senderId, displayId: row.id, direct: conversation.type === "direct" });
        if (metadata && file?.sealed && file.expiresAt > now) {
          const sealed = file.sealed;
          // Cached attachments use AES-GCM with the default 128-bit tag.
          const size = sealed.ciphertext.size - 16;
          if (size < 0 || size > MAX_FILE_SIZE) {
            const names = missingFiles.get(conversationId) ?? [];
            names.push(metadata.fileName);
            missingFiles.set(conversationId, names);
          } else {
            entry.attachment = { id: file.id, fileName: metadata.fileName, mimeType: metadata.mimeType,
              expiresAt: Math.min(message.expiresAt ?? file.expiresAt, file.expiresAt), size };
            item.attachmentSource = { size, open: () => openCachedAttachment(userId, file.id, sealed) };
          }
        }
        const marker = deletionsById.get(id);
        if (marker && deletion && deletionMatches(row, marker) && marker.deletedAt === deletion.deletedAt
          && marker.deletedByUserId === deletion.deletedByUserId) deletionsById.delete(id);
      }
      if (!cursor) after = undefined;
      await tx.done;
    } while (after);
  }
  for (const deletion of deletionsById.values()) {
    if (deletion.deletedAt + MESSAGE_RETENTION_MS > now && selected.has(deletion.conversationId)) items.push({ entry: deletion });
  }
  // Authenticate one cached attachment at a time before promising its byte range.
  // Only the sealed references are retained for the subsequent stream.
  for (const item of items) {
    const { entry, attachmentSource } = item;
    if (entry.kind !== "message" || !entry.attachment || !attachmentSource) continue;
    try {
      if ((await attachmentSource.open()).size === attachmentSource.size) continue;
    } catch (error) {
      if (error instanceof Error && error.name === "KeysLockedError") throw error;
    }
    const chat = entry.message.conversationId;
    const names = missingFiles.get(chat) ?? [];
    names.push(entry.attachment.fileName);
    missingFiles.set(chat, names);
    delete entry.attachment;
    delete item.attachmentSource;
  }
  if (!await historyArchiveIsCurrent(revisions, true)) throw new Error("History changed during export");
  return { items, candidates, skippedLegacy, missingFiles, revisions };
}

/** Each item commits with its barriers and optional attachment, alongside live writers. */
export async function importHistoryTransferItem(
  userId: string,
  item: HistoryTransferItem,
  current: () => boolean = () => true,
  now = Date.now(),
  source?: HistoryImportSource,
  transfer?: HistoryTransferImportContext,
): Promise<LocalMessage | undefined> {
  const { entry, blob } = item;
  const attachment = entry.kind === "message" ? entry.attachment : undefined;
  const cachedBefore = attachment && blob && await getCachedFile(attachment.id, userId);
  let damaged = false;
  if (attachment && cachedBefore && cachedBefore.sealed && cachedBefore.expiresAt > now) {
    try { damaged = (await openCachedAttachment(userId, attachment.id, cachedBefore.sealed)).size !== attachment.size; } catch { damaged = true; }
  }
  const sealed = attachment && blob && attachment.size === blob.size && blob.size <= MAX_FILE_SIZE && attachment.expiresAt > now
    && entry.kind === "message" && entry.message.deletedAt == null
    ? await sealCachedAttachment(userId, attachment.id, blob) : undefined;
  const db = await getAppDB();
  if (!current()) return;
  const tx = db.transaction(["accountConversations", "displayMessages", "legacyMessages", "accountState", "accountFiles"], "readwrite");
  const done = tx.done;
  void done.catch(() => undefined);
  let changed: LocalMessage | undefined;
  let notifyOtherTabs = false;
  const delta: HistoryTransferAddition = { messages: 0, attachmentBytes: 0, attachmentFiles: 0 };
  const chatId = entry.kind === "conversation" ? entry.conversation.id : entry.kind === "message" ? entry.message.conversationId : entry.conversationId;
  try {
    const state = tx.objectStore("accountState");
    if (transfer && !await ownsHistoryTransferLease(state, transfer.lease)) throw new Error("History transfer belongs to another tab");
    const conversations = tx.objectStore("accountConversations");
    const conversationKey = historyConversationKey(userId, chatId);
    const snapshot = await conversations.get(conversationKey);
    if (snapshot?.hidden || snapshot?.deleted || snapshot?.deletedAt != null) {
      delta.skipped = true;
    } else if (entry.kind === "conversation") {
      const conversation = ownedConversation(entry.conversation, userId);
      if (!conversation) throw new Error("Invalid transfer conversation");
      if (!snapshot || snapshot.conversation.updatedAt < conversation.updatedAt) {
        await conversations.put({ ...snapshot, id: conversationKey, userId, conversation, importedAt: now });
      }
    } else {
      const identity = entry.kind === "deletion" ? entry : entry.message;
      const direct = snapshot?.conversation.type === "direct";
      const incoming = entry.kind === "message" ? historyTransferMessageSchema.parse(entry.message) : undefined;
      const row = incoming && { ...incoming, ownerId: userId, direct, wireId: identity.id, importedAt: now,
        transferSourceId: identity.id, imported: source && { fromDeviceId: source.fromDeviceId, at: source.at } };
      if (entry.kind === "deletion" || incoming?.deletedAt != null) {
        const result = await mergeDisplayDeletion(tx, identity.id, userId, {
          conversationId: identity.conversationId, senderId: identity.senderId, importedAt: now,
          deletedAt: entry.kind === "deletion" ? entry.deletedAt : incoming!.deletedAt!,
          deletedByUserId: (entry.kind === "deletion" ? entry.deletedByUserId : incoming?.deletedByUserId) ?? identity.senderId,
        }, direct, row);
        if (result.changed) changed = result.row;
        notifyOtherTabs = true;
      } else if (row) {
        const metadata = row.type === "file" ? fileMetadata(row.content) : undefined;
        if (row.type === "file" && !metadata) throw new Error("Invalid transferred file metadata");
        if (metadata) row.content = JSON.stringify(metadata);
        const result = await mergeDisplayMessage(tx, row, { imported: true, now });
        const stored = result.row;
        if (result.changed) changed = stored;
        if (result.added && stored?.deletedAt == null) delta.messages++;
        notifyOtherTabs = !!result.replaced || !!changed?.editedAt || changed?.deletedAt != null;
        if (source && changed && changed.deletedAt == null) {
          const marker = { ...source, conversationId: identity.conversationId };
          await tx.objectStore("accountState").put({ id: `transfer-marker:${JSON.stringify([userId, identity.conversationId])}:${source.fromDeviceId}`, marker });
        }
        if (attachment && sealed && metadata && stored && !result.hidden && stored.deletedAt == null) {
          const expiresAt = Math.min(attachment.expiresAt, normalizeExpiryMetadata(stored).expiresAt);
          if (metadata.fileId === attachment.id && extractFileIdFromMessage(stored) === attachment.id && expiresAt > now) {
            const files = tx.objectStore("accountFiles");
            const saved = await readCachedFile(files, attachment.id, userId);
            if (!saved?.sealed || saved.expiresAt <= now || (damaged && cachedBefore && saved.cachedAt === cachedBefore.cachedAt)) {
              await writeCachedFile(files, { id: attachment.id, sealed, ownerId: userId, expiresAt, cachedAt: now, explicitTransfer: true });
              delta.attachmentFiles++;
              delta.attachmentBytes += attachment.size;
            } else if (!saved.explicitTransfer) {
              await writeCachedFile(files, { ...saved, explicitTransfer: true });
            }
          }
        }
      }
    }
    if (transfer && (delta.skipped || delta.messages || delta.attachmentFiles)) await recordHistoryTransferAdditions(state, transfer, chatId, delta);
    if (!current()) { tx.abort(); await done.catch(() => undefined); return; }
    await done;
    if (changed && notifyOtherTabs) publishLocalMessageChange(changed.id, "commit", changed.conversationId);
    return changed;
  } catch (error) {
    try { tx.abort(); } catch { /* Transaction already finished. */ }
    await done.catch(() => undefined);
    throw error;
  }
}
