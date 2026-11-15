import type {
  ConversationWithMembers,
  DecryptedMessage,
  SenderKeyHeader,
  WSMessageFrame,
} from "@e2ee-chat/shared";
import { CALL_KEY_RECOVERY_TTL_MS } from "@e2ee-chat/shared";
import { api } from "../services/api.js";
import {
  getCachedConversationMessagesPage,
  cleanupExpiredMessages,
  cleanupExpiredPendingCalls,
  getLatestCachedMessageTimestamp,
  getMessageById,
  getSyncState,
  saveMessage,
  getPendingCall,
  commitReceivedMessage,
  getReceiveReceipt,
  savePendingReceive,
  getPendingReceives,
  getSenderKey,
  type ReceiveEffects,
  saveSyncState,
  type LocalMessage,
} from "../db/index.js";
import { normalizeExpiryMetadata } from "./message-retention.js";
import { useAuthStore } from "../stores/authStore.js";
import { useCallStore } from "../stores/callStore.js";
import { useChatStore } from "../stores/chatStore.js";
import {
  upsertConversationInCache,
  getCachedConversation,
  touchConversationInCache,
} from "./conversation-cache.js";
import { decryptGroupText, decryptMessage, type IncomingMessage } from "./message-processor.js";
import { classifyReceiveError, ConversationMetadataError, MissingSenderKeyError, withSessionLock, type ReceiveContext, type ReceiveState } from "./receive.js";
import { parseCallOffer, validateFilePayload } from "./receive-validation.js";
import { consumeOneTimePreKey } from "./key-manager.js";
import { capabilities } from "../platform/capabilities.js";

const conversationCache = new Map<string, ConversationWithMembers>();
const inFlightDecryptIds = new Map<string, Promise<void>>();
let syncEpoch = 0;
const LOCAL_MESSAGES_PAGE_SIZE = 100;
const SYNC_BATCH_SIZE = 250;
const INITIAL_SYNC_BACKFILL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 5_000;
let lastSyncStartedAt = 0;
let activeGlobalSync: Promise<void> | null = null;

interface SyncCursor {
  ts: number;
  id?: string;
}

interface SyncResponse {
  messages: WSMessageFrame[];
  hasMore: boolean;
}

interface PersistedConversationLoadResult {
  loadedCount: number;
  hasOlder: boolean;
}

function captureSession() {
  const { sessionId, user, device } = useAuthStore.getState();
  return { epoch: syncEpoch, sessionId, userId: user?.id, deviceId: device?.id };
}

type MessageSession = ReturnType<typeof captureSession>;

function isCurrentSession(session: MessageSession): boolean {
  const { sessionId, user, device } = useAuthStore.getState();
  return session.epoch === syncEpoch && session.sessionId === sessionId
    && session.userId === user?.id && session.deviceId === device?.id;
}

async function getConversation(conversationId: string): Promise<ConversationWithMembers> {
  const epoch = syncEpoch;
  const cached = conversationCache.get(conversationId);
  if (cached) return cached;
  const listCached = getCachedConversation(conversationId);
  if (listCached) {
    conversationCache.set(conversationId, listCached);
    return listCached;
  }
  const session = captureSession();
  let conversation: ConversationWithMembers;
  try {
    // Tag only the network request. Cache/shape errors remain terminal input errors.
    conversation = await api.get<ConversationWithMembers>(`/api/conversations/${conversationId}`);
  } catch (error) { throw new ConversationMetadataError(error); }
  if (!conversation || conversation.id !== conversationId || !["direct", "group"].includes(conversation.type)) {
    throw new TypeError("Invalid conversation metadata");
  }
  if (epoch === syncEpoch && isCurrentSession(session)) {
    upsertConversationInCache(conversation);
    conversationCache.set(conversationId, conversation);
  }
  return conversation;
}

function toLocalMessage(message: DecryptedMessage): LocalMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    type: message.type,
    content: message.content,
    timestamp: message.timestamp,
    expiresAt: message.expiresAt,
    expiryKind: message.expiryKind,
    status: message.status,
  };
}

// Metadata updates whose latest state has not yet been saved to IndexedDB.
const unpersistedMessageIds = new Set<string>();

async function persistMessage(message: DecryptedMessage): Promise<void> {
  unpersistedMessageIds.add(message.id);
  await saveMessage(toLocalMessage(message));
  unpersistedMessageIds.delete(message.id);
}

function getFrameTimestamp(frame: Pick<WSMessageFrame, "timestamp" | "serverTimestamp">): number {
  return frame.serverTimestamp ?? frame.timestamp;
}

function getSyncStateId(): string | null {
  const authState = useAuthStore.getState();
  const userId = authState.user?.id;
  const deviceId = authState.device?.id;
  if (!userId || !deviceId) return null;
  return `message-sync:${userId}:${deviceId}`;
}

async function resolveSyncCursor(explicitSince?: number): Promise<SyncCursor> {
  if (explicitSince !== undefined) return { ts: explicitSince };
  const syncStateId = getSyncStateId();
  if (syncStateId) {
    const saved = await getSyncState(syncStateId);
    if (saved && saved.value > 0) {
      return { ts: saved.value, id: saved.cursorId };
    }
  }

  const latestCachedTimestamp = await getLatestCachedMessageTimestamp();
  return { ts: Math.max(0, latestCachedTimestamp - INITIAL_SYNC_BACKFILL_MS) };
}

function receivedMessage(frame: WSMessageFrame, content: string, status: "delivered" | "failed" = "delivered"): DecryptedMessage {
  return {
    id: frame.id, conversationId: frame.conversationId, senderId: frame.senderId,
    type: frame.msgType as DecryptedMessage["type"], content, timestamp: getFrameTimestamp(frame),
    expiresAt: frame.expiresAt, expiryKind: frame.expiryKind, status,
  };
}

async function prepareReceiveEffects(frame: WSMessageFrame, plaintext: Uint8Array): Promise<ReceiveEffects> {
  const content = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  const effects: ReceiveEffects = { expiresAt: frame.expiresAt };
  if (frame.msgType === "system") {
    const payload = parseCallOffer(content, frame.conversationId);
    effects.pendingCall = {
      id: payload.callId, conversationId: frame.conversationId, initiatorId: payload.initiatorId,
      callType: payload.callType, callKey: payload.callKey, createdAt: payload.createdAt,
      expiresAt: Math.max(payload.expiresAt, payload.createdAt + CALL_KEY_RECOVERY_TTL_MS),
      direction: frame.senderId === payload.initiatorId ? "incoming" : "outgoing",
    };
  } else if (frame.msgType === "text" || frame.msgType === "file") {
    if (frame.msgType === "file") validateFilePayload(content);
    effects.message = toLocalMessage(receivedMessage(frame, content));
  } else if (frame.msgType !== "sender_key_distribution") {
    throw new TypeError("Unsupported message/control kind");
  }
  return effects;
}

async function decryptIncomingMessage(frame: WSMessageFrame, session: MessageSession, receive: ReceiveContext): Promise<string | null> {
  const conversation = await getConversation(frame.conversationId);
  if (!isCurrentSession(session)) return null;
  if (!conversation || !["direct", "group"].includes(conversation.type)) throw new TypeError("Invalid conversation metadata");
  const incoming: IncomingMessage = {
    id: frame.id, senderId: frame.senderId, senderDeviceId: frame.senderDeviceId,
    type: frame.msgType, ciphertext: frame.ciphertext, iv: frame.iv, header: frame.header,
  };
  if (conversation.type === "group" || frame.msgType === "sender_key_distribution") {
    return decryptGroupText(frame.conversationId, incoming, receive);
  }
  return decryptMessage("direct", incoming, receive);
}

/**
 * Applies a frame for a message this device already has (a re-synced copy of a live message, or
 * the echo of a sent one). Returns null when the message is unknown; otherwise the merged
 * message and whether the frame changed anything that is stored.
 */
async function mergeExistingMessage(frame: WSMessageFrame, session: MessageSession, isLocalEcho: boolean): Promise<{
  message: DecryptedMessage;
  changed: boolean;
} | null> {
  const existingMessages = useChatStore.getState().messages.get(frame.conversationId) ?? [];
  const inStore = existingMessages.find((message) => message.id === frame.id);
  const existing = inStore ?? await getMessageById(frame.id);
  if (!existing || !isCurrentSession(session)) return null;

  const merged: DecryptedMessage = {
    ...existing,
    type: existing.type as DecryptedMessage["type"],
    status: isLocalEcho ? "delivered" : existing.status as DecryptedMessage["status"],
    timestamp: getFrameTimestamp(frame),
    expiresAt: frame.expiresAt,
    expiryKind: frame.expiryKind,
  };
  const changed = merged.status !== existing.status
    || merged.timestamp !== existing.timestamp
    || merged.expiresAt !== existing.expiresAt
    || merged.expiryKind !== existing.expiryKind;
  // A message known only from IndexedDB is still shown; an identical one in the store is left alone.
  if (changed || !inStore) useChatStore.getState().addMessage(frame.conversationId, merged);
  return { message: merged, changed };
}

/** Re-read durable output when another tab wins either dedupe check or the commit. */
async function restoreCommittedFrame(frame: WSMessageFrame, session: MessageSession, isLocalEcho: boolean): Promise<boolean> {
  const merged = await mergeExistingMessage(frame, session, isLocalEcho);
  if (!isCurrentSession(session)) return false;
  if (merged) {
    if (merged.changed || unpersistedMessageIds.has(frame.id)) await persistMessage(merged.message);
    if (isCurrentSession(session)) touchConversationInCache(frame.conversationId, getFrameTimestamp(frame));
    return true;
  }
  const receipt = await getReceiveReceipt(frame.id);
  if (!receipt) return false;
  if (receipt.pendingCallId && await getPendingCall(receipt.pendingCallId) && isCurrentSession(session)) {
    useCallStore.getState().markKeyReady(receipt.pendingCallId, true);
  }
  return true;
}

/** An untrusted scheduling hint, never a validation/classification result. */
function groupOrder(frame: WSMessageFrame): { senderKeyId: number; chainIndex: number } {
  try {
    const header = JSON.parse(frame.header);
    return {
      senderKeyId: Number.isSafeInteger(header?.senderKeyId) ? header.senderKeyId : -1,
      chainIndex: Number.isSafeInteger(header?.chainIndex) ? header.chainIndex : -1,
    };
  } catch { return { senderKeyId: -1, chainIndex: -1 }; }
}

function sortPending(frames: WSMessageFrame[]): WSMessageFrame[] {
  return frames.sort((left, right) => {
    const a = groupOrder(left), b = groupOrder(right);
    return String(left?.conversationId).localeCompare(String(right?.conversationId))
      || String(left?.senderId).localeCompare(String(right?.senderId)) || String(left?.senderDeviceId).localeCompare(String(right?.senderDeviceId))
      || a.senderKeyId - b.senderKeyId || a.chainIndex - b.chainIndex;
  });
}

async function pendingReceives(): Promise<WSMessageFrame[]> {
  const { user, device } = useAuthStore.getState();
  return sortPending(await getPendingReceives(user?.id, device?.id));
}

async function retryPendingReceives(session: MessageSession): Promise<void> {
  // A pending record (or a failed queue read) must never prevent fetching fresh envelopes.
  let frames: WSMessageFrame[];
  try { frames = await pendingReceives(); } catch (error) {
    console.error("Could not read deferred receives", error);
    return;
  }
  for (const frame of frames) {
    if (!isCurrentSession(session)) return;
    try { await ingestMessageFrame(frame); } catch (error) { console.error("Deferred receive will be retried", error); }
  }
}

/** Called only while this peer's receive lock is held. Never re-enter the public ID queue. */
async function drainPeerReceives(frame: WSMessageFrame, session: MessageSession, lockKey: string, before?: SenderKeyHeader): Promise<void> {
  const frames = (await pendingReceives()).filter((pending) => {
    if (pending.id === frame.id || pending.conversationId !== frame.conversationId
      || pending.senderId !== frame.senderId || pending.senderDeviceId !== frame.senderDeviceId) return false;
    const order = groupOrder(pending);
    return !before || order.senderKeyId < 0 || (order.senderKeyId === before.senderKeyId && order.chainIndex < before.chainIndex);
  });
  const blockedChains = new Set<number>();
  for (const pending of frames) {
    if (!isCurrentSession(session)) return;
    const chain = groupOrder(pending).senderKeyId;
    if (blockedChains.has(chain)) continue;
    try { await ingestFrame(pending, session, lockKey, false); } catch (error) {
      // A failed lower index is a barrier for this chain, including a newer live frame.
      if (before) throw error;
      blockedChains.add(chain);
      console.error("Deferred receive will be retried", error);
    }
  }
}

export async function ingestMessageFrame(frame: WSMessageFrame): Promise<void> {
  const session = captureSession();
  const previous = inFlightDecryptIds.get(frame.id) ?? Promise.resolve();
  const lockKey = `${frame.senderId}:${frame.senderDeviceId}`;
  const pending = previous.catch(() => undefined).then(() => withSessionLock(lockKey, async () => {
    await ingestFrame(frame, session, lockKey);
    if (frame.msgType === "sender_key_distribution" && isCurrentSession(session)) {
      try { await drainPeerReceives(frame, session, lockKey); } catch (error) {
        console.error("Could not read deferred receives after distribution", error);
      }
    }
  }));
  inFlightDecryptIds.set(frame.id, pending);
  try { await pending; } finally {
    if (inFlightDecryptIds.get(frame.id) === pending) inFlightDecryptIds.delete(frame.id);
  }
}

function terminalEffects(frame: WSMessageFrame): ReceiveEffects {
  if (frame.msgType === "text" || frame.msgType === "file") {
    return { expiresAt: frame.expiresAt, message: toLocalMessage(receivedMessage(frame, "", "failed")) };
  }
  return {
    expiresAt: frame.expiresAt,
    failure: frame.msgType === "sender_key_distribution" ? "invalid_sender_key_distribution" : "terminal_receive_error",
  };
}

async function ingestFrame(frame: WSMessageFrame, session: MessageSession, lockKey: string, drainOlder = true): Promise<void> {
  if (!isCurrentSession(session) || (frame.expiresAt !== null && frame.expiresAt <= Date.now())) return;
  const { user, device } = useAuthStore.getState();
  const isLocalEcho = frame.senderId === user?.id && frame.senderDeviceId === device?.id && frame.msgType !== "system";
  let staged: ReceiveState = {};
  try {
    if (await restoreCommittedFrame(frame, session, isLocalEcho) || !isCurrentSession(session)) return;
    if (isLocalEcho) {
      touchConversationInCache(frame.conversationId, getFrameTimestamp(frame));
      useChatStore.getState().updateMessageStatus(frame.id, "delivered");
      return;
    }
    await decryptIncomingMessage(frame, session, {
      messageId: frame.id, lockedSession: lockKey,
      stage: (state) => { staged = state; },
      prepare: (plaintext) => prepareReceiveEffects(frame, plaintext),
      beforeGroupDecrypt: drainOlder ? (header) => drainPeerReceives(frame, session, lockKey, header) : undefined,
    });
  } catch (error) {
    const disposition = classifyReceiveError(error);
    if (disposition === "retry") throw error;
    if (disposition === "defer") {
      await savePendingReceive(frame, user?.id, device?.id);
      // Also cover another tab committing distribution just before this queue write.
      if (error instanceof MissingSenderKeyError && await getSenderKey(error.keyId)) {
        return ingestFrame(frame, session, lockKey, false);
      }
      return;
    }
    // Unauthenticated stale work must not retire a frame belonging to the prior login.
    // Authenticated receives still commit their advanced state and output together.
    if (!staged.session && !staged.senderKey && !isCurrentSession(session)) return;
    const committed = await commitReceivedMessage(frame.id, terminalEffects(frame), staged);
    if (committed && staged.oneTimePreKeyId !== undefined) {
      await consumeOneTimePreKey(staged.oneTimePreKeyId).catch((cleanupError) => console.error("Failed to remove a used one-time pre-key", cleanupError));
    }
  }
  // Both success and losing-tab dedupe publish only the durable output. Controls restore receipts.
  if (!await restoreCommittedFrame(frame, session, isLocalEcho) || !isCurrentSession(session)) return;
  if (frame.msgType !== "text" && frame.msgType !== "file") return;

  const { activeConversationId, incrementUnread, conversations } = useChatStore.getState();
  if (activeConversationId !== frame.conversationId) {
    incrementUnread(frame.conversationId);
  }
  if (activeConversationId !== frame.conversationId || capabilities.nativeCallNotifications) {
    if (Date.now() - frame.timestamp < 30_000 && document.visibilityState !== "visible") {
      const conv = conversations.find((c) => c.id === frame.conversationId);
      const sender = conv?.members.find((m) => m.userId === frame.senderId);
      const { showMessageNotification } = await import("./browser-notifications.js");
      if (isCurrentSession(session)) showMessageNotification(sender?.user.displayName ?? "Someone", frame.conversationId);
    }
  }
}

async function executeSync(session: MessageSession, options?: {
  conversationId?: string;
  since?: number;
  force?: boolean;
}): Promise<void> {
  if (!isCurrentSession(session)) return;
  if (!options?.force && !options?.conversationId) {
    const now = Date.now();
    if (now - lastSyncStartedAt < MIN_SYNC_INTERVAL_MS) {
      return;
    }
    lastSyncStartedAt = now;
  } else if (!options?.conversationId) {
    lastSyncStartedAt = Date.now();
  }

  await retryPendingReceives(session);
  if (!isCurrentSession(session)) return;
  const syncStateId = getSyncStateId();
  let cursor = await resolveSyncCursor(options?.since);

  while (isCurrentSession(session)) {
    const params = new URLSearchParams();
    if (options?.conversationId) params.set("conversationId", options.conversationId);
    params.set("since", String(cursor.ts));
    if (cursor.id !== undefined) params.set("sinceId", cursor.id);
    params.set("limit", String(SYNC_BATCH_SIZE));

    const response = await api.get<SyncResponse>(`/api/messages/sync?${params.toString()}`);
    if (!isCurrentSession(session) || response.messages.length === 0) return;

    for (const frame of response.messages) {
      if (!isCurrentSession(session)) return;
      await ingestMessageFrame(frame);
    }
    if (!isCurrentSession(session)) return;

    const lastFrame = response.messages[response.messages.length - 1];
    cursor = { ts: getFrameTimestamp(lastFrame), id: lastFrame.id };

    // Live frames and conversation-specific backfills never advance this cursor.
    if (!options?.conversationId && syncStateId) {
      await saveSyncState(syncStateId, cursor.ts, cursor.id);
    }

    if (!response.hasMore) {
      return;
    }
  }
}

export async function syncMessages(options?: {
  conversationId?: string;
  since?: number;
  force?: boolean;
}): Promise<void> {
  const session = captureSession();
  if (options?.conversationId) {
    if (activeGlobalSync) {
      await activeGlobalSync;
    }
    await executeSync(session, options);
    return;
  }

  if (!activeGlobalSync) {
    const pending = executeSync(session, options).finally(() => {
      if (activeGlobalSync === pending) activeGlobalSync = null;
    });
    activeGlobalSync = pending;
  }

  await activeGlobalSync;
}

export async function syncConversationMessages(conversationId: string): Promise<void> {
  const session = captureSession();
  await getConversation(conversationId).catch(() => undefined);
  if (isCurrentSession(session)) await syncMessages();
}

function normalizeStoredMessage(message: LocalMessage, now: number): DecryptedMessage | null {
  const { expiresAt, expiryKind } = normalizeExpiryMetadata(message);
  if (expiresAt <= now && !message.hasOutgoingEntry) return null;

  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    type: message.type as DecryptedMessage["type"],
    content: message.content,
    timestamp: message.timestamp,
    expiresAt,
    expiryKind,
    status: message.status as DecryptedMessage["status"],
  };
}

async function hasOlderCachedMessages(
  conversationId: string,
  oldestLoadedTimestamp: number | undefined,
): Promise<boolean> {
  if (!oldestLoadedTimestamp) return false;
  const page = await getCachedConversationMessagesPage(conversationId, {
    before: oldestLoadedTimestamp,
    limit: 1,
  });
  return page.messages.length > 0;
}

export async function loadPersistedConversationMessages(
  conversationId: string,
): Promise<PersistedConversationLoadResult> {
  const session = captureSession();
  const existingBeforeLoad = useChatStore.getState().messages.get(conversationId);
  if (existingBeforeLoad && existingBeforeLoad.length > 0) {
    return {
      loadedCount: 0,
      hasOlder: await hasOlderCachedMessages(conversationId, existingBeforeLoad[0]?.timestamp),
    };
  }

  const page = await getCachedConversationMessagesPage(conversationId, { limit: LOCAL_MESSAGES_PAGE_SIZE });
  if (!isCurrentSession(session)) return { loadedCount: 0, hasOlder: false };
  const existingAfterLoad = useChatStore.getState().messages.get(conversationId);
  if (existingAfterLoad && existingAfterLoad.length > 0) {
    return {
      loadedCount: 0,
      hasOlder: await hasOlderCachedMessages(conversationId, existingAfterLoad[0]?.timestamp),
    };
  }
  const now = Date.now();
  const messages = page.messages
    .map((message) => normalizeStoredMessage(message, now))
    .filter((message): message is DecryptedMessage => message !== null);

  useChatStore.getState().setMessages(conversationId, messages);

  return {
    loadedCount: messages.length,
    hasOlder: page.hasOlder,
  };
}

export async function loadOlderPersistedConversationMessages(
  conversationId: string,
): Promise<PersistedConversationLoadResult> {
  const session = captureSession();
  const existing = useChatStore.getState().messages.get(conversationId) ?? [];
  const oldestLoadedMessage = existing[0];
  if (!oldestLoadedMessage) {
    return { loadedCount: 0, hasOlder: false };
  }

  const page = await getCachedConversationMessagesPage(conversationId, {
    before: oldestLoadedMessage.timestamp,
    limit: LOCAL_MESSAGES_PAGE_SIZE,
  });
  if (!isCurrentSession(session)) return { loadedCount: 0, hasOlder: false };
  const now = Date.now();
  const messages = page.messages
    .map((message) => normalizeStoredMessage(message, now))
    .filter((message): message is DecryptedMessage => message !== null);

  if (messages.length > 0) {
    useChatStore.getState().prependMessages(conversationId, messages);
  }

  return {
    loadedCount: messages.length,
    hasOlder: page.hasOlder,
  };
}

export async function pruneExpiredPlaintext(now = Date.now()): Promise<void> {
  const session = captureSession();
  const deletedIds = await cleanupExpiredMessages(now);
  if (isCurrentSession(session) && deletedIds.length > 0) {
    useChatStore.getState().removeMessages(deletedIds);
  }
}

export async function runUnlockSync(): Promise<void> {
  const session = captureSession();
  await cleanupExpiredPendingCalls();
  if (!isCurrentSession(session)) return;
  await pruneExpiredPlaintext();
  if (!isCurrentSession(session)) return;
  await syncMessages({ force: true });
}

export function resetMessageSyncState(): void {
  syncEpoch++;
  lastSyncStartedAt = 0;
  activeGlobalSync = null;
  conversationCache.clear();
}
