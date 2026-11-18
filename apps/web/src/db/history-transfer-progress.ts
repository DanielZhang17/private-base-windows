import {
  historyTransferCheckpointSchema, type HistoryTransferAddition, type HistoryTransferCheckpoint, type HistoryTransferManifest,
} from "@e2ee-chat/shared";
import { getAppDB } from "./index.js";

const RETAIN_MS = 7 * 24 * 60 * 60_000;
export interface HistoryTransferScope { userId: string; deviceId: string; role: "sender" | "receiver" }
export interface InterruptedHistoryTransfer extends HistoryTransferCheckpoint {
  peerDeviceId: string;
  updatedAt: number;
}

function key(scope: HistoryTransferScope, peerDeviceId: string): string {
  return `transfer:${peerDeviceId}:${JSON.stringify([scope.userId, scope.deviceId, scope.role])}`;
}

const LEASE_MS = 30_000;

export interface HistoryTransferLease { id: string; token: string }
interface StoredLease extends HistoryTransferLease { expiresAt: number }

function leaseKey(scope: HistoryTransferScope, peerDeviceId: string): string {
  return `history-transfer-active:${JSON.stringify([scope.userId, scope.deviceId, peerDeviceId])}`;
}

type LeaseReader = { get(id: string): Promise<StoredLease | undefined> };

export async function ownsHistoryTransferLease(store: LeaseReader, lease: HistoryTransferLease): Promise<boolean> {
  return (await store.get(lease.id))?.token === lease.token;
}

async function activeLease(store: LeaseReader, id: string, now: number): Promise<StoredLease | undefined> {
  const current = await store.get(id);
  return current && current.expiresAt > now ? current : undefined;
}

/** Fence both directions for the same pair, including browsers without the Web Locks API. */
export async function claimHistoryTransferLease(scope: HistoryTransferScope, peerDeviceId: string, now = Date.now()): Promise<HistoryTransferLease | undefined> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const id = leaseKey(scope, peerDeviceId);
  if (await activeLease(tx.store, id, now)) { await tx.done; return; }
  const lease = { id, token: crypto.randomUUID() };
  await tx.store.put({ ...lease, expiresAt: now + LEASE_MS } satisfies StoredLease);
  await tx.done;
  return lease;
}

export async function renewHistoryTransferLease(lease: HistoryTransferLease, now = Date.now()): Promise<boolean> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const matches = await ownsHistoryTransferLease(tx.store, lease);
  if (matches) await tx.store.put({ ...lease, expiresAt: now + LEASE_MS } satisfies StoredLease);
  await tx.done;
  return matches;
}

export async function releaseHistoryTransferLease(lease: HistoryTransferLease): Promise<void> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  if ((await tx.store.get(lease.id))?.token === lease.token) await tx.store.delete(lease.id);
  await tx.done;
}

interface StoredCheckpoint {
  id: string;
  scope: HistoryTransferScope;
  peerDeviceId: string;
  updatedAt: number;
  checkpoint: HistoryTransferCheckpoint;
  writer?: string;
}

export interface HistoryTransferImportContext extends HistoryTransferScope {
  peerDeviceId: string;
  lease: HistoryTransferLease;
}

interface ChatAdditions {
  id: string;
  writer: string;
  additions?: HistoryTransferAddition;
}

function additionsPrefix(scope: HistoryTransferScope, peerDeviceId: string): string {
  return `transfer-additions:${JSON.stringify([scope.userId, scope.deviceId, scope.role, peerDeviceId])}:`;
}

function additionsRange(scope: HistoryTransferScope, peerDeviceId: string): IDBKeyRange {
  const prefix = additionsPrefix(scope, peerDeviceId);
  return IDBKeyRange.bound(prefix, prefix.slice(0, -1) + ";", false, true);
}

/** Estimate the stored checkpoint, completion IDs and per-chat import journals in UTF-8 bytes. */
export function estimateHistoryTransferCheckpointBytes(scope: HistoryTransferScope, peerDeviceId: string, manifest: HistoryTransferManifest): Map<string, number> {
  const checkpoint = checkpointForManifest(manifest);
  const encoder = new TextEncoder();
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const writer = "0".repeat(36);
  const envelope = { id: key(scope, peerDeviceId), scope, peerDeviceId, updatedAt: Date.now(), writer,
    checkpoint: { ...checkpoint, chats: [], completedChatIds: [], bytes: manifest.bytes, confirmationOnly: true } };
  const prefix = additionsPrefix(scope, peerDeviceId);
  return new Map(checkpoint.chats.map((chat, index) => {
    const additions = { messages: chat.messages, attachmentFiles: chat.attachmentFiles ?? 0, attachmentBytes: chat.attachmentBytes, skipped: true };
    return [chat.id, size({ ...chat, additions }) + size(chat.id)
      + size({ id: prefix + chat.id, writer, additions } satisfies ChatAdditions) + 2 + (index === 0 ? size(envelope) : 0)];
  }));
}

export async function recordHistoryTransferAdditions(
  store: { get(key: string): Promise<ChatAdditions | undefined>; put(row: ChatAdditions): Promise<unknown> },
  context: HistoryTransferImportContext, chatId: string, delta: HistoryTransferAddition,
): Promise<void> {
  const row = await store.get(additionsPrefix(context, context.peerDeviceId) + chatId);
  if (row?.writer !== context.lease.token) throw new Error("History transfer progress belongs to another tab");
  const previous = row.additions;
  row.additions = {
    messages: (previous?.messages ?? 0) + delta.messages,
    attachmentFiles: (previous?.attachmentFiles ?? 0) + delta.attachmentFiles,
    attachmentBytes: (previous?.attachmentBytes ?? 0) + delta.attachmentBytes,
    ...(previous?.skipped || delta.skipped ? { skipped: true } : {}),
  };
  await store.put(row);
}

/** Publish the chat's committed counters and completion together, even after a new pairing. */
export async function completeHistoryTransferChat(context: HistoryTransferImportContext, chatId: string, bytes: number,
  current: () => boolean): Promise<HistoryTransferCheckpoint> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const peer = context.peerDeviceId;
  const row = await tx.store.get(key(context, peer)) as StoredCheckpoint | undefined;
  const chat = row?.checkpoint.chats.find(({ id }) => id === chatId);
  const additionsId = additionsPrefix(context, peer) + chatId;
  const pending = await tx.store.get(additionsId) as ChatAdditions | undefined;
  if (!row || !chat || row.writer !== context.lease.token || pending?.writer !== context.lease.token
    || !await ownsHistoryTransferLease(tx.store, context.lease) || !current()) {
    await tx.done;
    throw new Error("History transfer progress belongs to another tab or session");
  }
  if (pending.additions) chat.additions = pending.additions;
  row.checkpoint.completedChatIds.push(chatId);
  row.checkpoint.bytes = bytes;
  row.updatedAt = Date.now();
  await tx.store.put(row);
  await tx.store.delete(additionsId);
  await tx.done;
  return row.checkpoint;
}

function matches(row: StoredCheckpoint, scope: HistoryTransferScope): boolean {
  return row.scope?.userId === scope.userId && row.scope.deviceId === scope.deviceId && row.scope.role === scope.role;
}

export async function listInterruptedHistoryTransfers(scope: HistoryTransferScope, now = Date.now()): Promise<InterruptedHistoryTransfer[]> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const checkpoints = await tx.store.getAll(IDBKeyRange.bound("transfer:", "transfer:\uffff")) as StoredCheckpoint[];
  const active: InterruptedHistoryTransfer[] = [];
  for (const row of checkpoints) {
    if (!matches(row, scope)) continue;
    if (row.updatedAt + RETAIN_MS <= now) {
      await tx.store.delete(row.id);
      await tx.store.delete(additionsRange(scope, row.peerDeviceId));
    }
    else if (row.checkpoint.chats.length && !row.checkpoint.confirmationOnly) {
      active.push({ ...row.checkpoint, peerDeviceId: row.peerDeviceId, updatedAt: row.updatedAt });
    }
  }
  await tx.done;
  return active.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveHistoryTransferCheckpoint(
  scope: HistoryTransferScope, peerDeviceId: string, checkpoint: HistoryTransferCheckpoint,
  current: () => boolean, now = Date.now(), lease?: HistoryTransferLease, beginImport = false,
): Promise<void> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const owned = await tx.store.get(leaseKey(scope, peerDeviceId)) as StoredLease | undefined;
  if (lease ? owned?.token !== lease.token : !!owned && owned.expiresAt > now) {
    await tx.done;
    throw new Error("History transfer checkpoint belongs to another tab");
  }
  if (current()) {
    const { userId, deviceId, role } = scope;
    const id = key(scope, peerDeviceId);
    if (beginImport && lease) {
      const previous = await tx.store.get(id) as StoredCheckpoint | undefined;
      if (!previous || previous.checkpoint.resumeId !== checkpoint.resumeId) await tx.store.delete(additionsRange(scope, peerDeviceId));
      const prefix = additionsPrefix(scope, peerDeviceId);
      const completed = new Set(checkpoint.completedChatIds);
      for (const chat of checkpoint.chats) {
        if (completed.has(chat.id)) continue;
        const id = prefix + chat.id;
        const pending = await tx.store.get(id) as ChatAdditions | undefined;
        await tx.store.put({ id, writer: lease.token, additions: pending?.additions ?? chat.additions } satisfies ChatAdditions);
      }
    }
    if (current()) await tx.store.put({ id, scope: { userId, deviceId, role }, peerDeviceId, updatedAt: now,
      checkpoint: historyTransferCheckpointSchema.parse(checkpoint), writer: lease?.token } satisfies StoredCheckpoint);
    else { tx.abort(); await tx.done.catch(() => undefined); return; }
  }
  await tx.done;
}

export async function loadHistoryTransferCheckpoint(scope: HistoryTransferScope, peerDeviceId: string): Promise<HistoryTransferCheckpoint | undefined> {
  const row = await (await getAppDB()).get("accountState", key(scope, peerDeviceId)) as StoredCheckpoint | undefined;
  if (row && row.updatedAt + RETAIN_MS > Date.now() && matches(row, scope)) return row.checkpoint;
}

export async function clearHistoryTransferCheckpoint(
  scope: HistoryTransferScope, peerDeviceId: string, lease?: HistoryTransferLease, interrupted = false,
): Promise<void> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const stored = await tx.store.get(leaseKey(scope, peerDeviceId)) as StoredLease | undefined;
  const active = stored && stored.expiresAt > Date.now();
  const id = key(scope, peerDeviceId);
  const row = await tx.store.get(id) as StoredCheckpoint | undefined;
  const permitted = interrupted ? !!lease && row?.writer === lease.token && (!stored || stored.token === lease.token)
    : lease ? stored?.token === lease.token : !active;
  if (permitted) {
    await tx.store.delete(id);
    await tx.store.delete(additionsRange(scope, peerDeviceId));
  }
  await tx.done;
}

export function checkpointForManifest(manifest: HistoryTransferManifest, previous?: HistoryTransferCheckpoint): HistoryTransferCheckpoint {
  if (previous?.resumeId !== manifest.resumeId) previous = undefined;
  const liveIds = new Set(manifest.chats.map((chat) => chat.id));
  const completedChatIds = previous?.completedChatIds.filter((id) => !liveIds.has(id)) ?? [];
  const completed = new Set(completedChatIds);
  const priorChats = new Map(previous?.chats.map((chat) => [chat.id, chat]));
  return {
    chats: [...(previous?.chats.filter((chat) => completed.has(chat.id)) ?? []),
      ...manifest.chats.map(({ id, bytes, messages, attachmentBytes, attachmentFiles, missingFiles }) => {
        const prior = priorChats.get(id);
        const missingFileCount = missingFiles?.length ?? 0;
        return { id, bytes, messages, attachmentBytes, ...(attachmentFiles ? { attachmentFiles } : {}),
          ...(prior?.additions ? { additions: prior.additions } : {}), ...(missingFileCount ? { missingFileCount } : {}) };
      })],
    completedChatIds, bytes: 0, copyDownloadedFiles: manifest.copyDownloadedFiles, ...(manifest.resumeId ? { resumeId: manifest.resumeId } : {}),
  };
}
