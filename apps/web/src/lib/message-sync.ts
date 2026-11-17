import type {
  ConversationWithMembers,
  DecryptedMessage,
  SenderKeyHeader,
  WSMessageFrame,
  MessageEventPayload,
} from "@e2ee-chat/shared";
import { CALL_KEY_RECOVERY_TTL_MS } from "@e2ee-chat/shared";
import { api } from "../services/api.js";
import {
  getCachedConversationMessagesPage,
  cleanupExpiredMessages,
  cleanupExpiredPendingCalls,
  getLatestCachedMessageTimestamp,
  getMessageById,
  guardMessageForPublish,
  getMessageFamily,
  beginMessageHide,
  finishMessageHide,
  isMessageHidden,
  getMessageDeletion,
  rememberMessageDeletion,
  removeLocalMessageContent,
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
  advanceMutationCursor,
  type LocalMessage,
  type CachedMessageCursor,
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
import { connectLocalMessageChannel, getConversationHideGeneration } from "./local-message-changes.js";
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
  mutations?: (WSMessageFrame & { mutationSeq: number })[];
  hasMoreMutations?: boolean;
  mutationCursor?: number;
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
    deletedAt: message.deletedAt,
    deletedByUserId: message.deletedByUserId,
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
  const visible = await guardMessageForPublish(merged);
  if (!isCurrentSession(session)) return null;
  if (!visible) { useChatStore.getState().removeMessages([frame.id]); return { message: merged, changed: false }; }
  if (changed || !inStore || visible.deletedAt !== merged.deletedAt) useChatStore.getState().addMessage(frame.conversationId, visible);
  return { message: visible, changed: changed || visible.deletedAt !== merged.deletedAt };
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
  if (await isMessageHidden(frame.id)) {
    if (frame.deletedAt) await applyMessageDeletion(receivedMessage(frame, ""), frame.deletedAt, frame.deletedByUserId ?? frame.senderId, session);
    useChatStore.getState().removeMessages([frame.id]); return;
  }
  const { user, device } = useAuthStore.getState();
  const isLocalEcho = frame.senderId === user?.id && frame.senderDeviceId === device?.id && frame.msgType !== "system";
  const savedDeletion = await getMessageDeletion(frame.id);
  const deletion = savedDeletion?.conversationId === frame.conversationId && (savedDeletion.senderId ?? savedDeletion.deletedByUserId) === frame.senderId ? savedDeletion : undefined;
  if (frame.deletedAt || deletion) {
    const conversation = await getConversation(frame.conversationId);
    const rootId = conversation.type === "direct" ? frame.id.split(":")[0] : frame.id;
    const family = await getMessageFamily(rootId, frame.conversationId, frame.senderId);
    const exact = family.find((message) => message.id === rootId);
    const candidate = exact ?? (conversation.type === "direct" ? family[0] : undefined);
    const existing = candidate?.senderId === frame.senderId && candidate.conversationId === frame.conversationId ? candidate : undefined;
    if (!isCurrentSession(session)) return;
    // Dedupe is keyed by envelope ID even when the display uses the logical ID.
    if (!await rememberMessageDeletion(frame.id, frame.conversationId, frame.deletedAt ?? deletion!.deletedAt, frame.deletedByUserId ?? deletion?.deletedByUserId ?? frame.senderId, frame.senderId, () => isCurrentSession(session))) return;
    // Sender sync returns every fanout envelope. Unknown local echoes never create display rows.
    if (!existing && isLocalEcho) return;
    const display = existing ? normalizeStoredMessage(existing, Date.now()) : receivedMessage(frame, "");
    if (display) await applyMessageDeletion(display, frame.deletedAt ?? deletion!.deletedAt, frame.deletedByUserId ?? deletion?.deletedByUserId ?? frame.senderId, session);
    return;
  }
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
  const mutationStateId = session.userId && session.deviceId ? `message-mutations:${session.userId}:${session.deviceId}` : null;
  let mutationCursor = !options?.conversationId && mutationStateId ? (await getSyncState(mutationStateId))?.value ?? 0 : 0;

  while (isCurrentSession(session)) {
    const params = new URLSearchParams();
    if (options?.conversationId) params.set("conversationId", options.conversationId);
    params.set("since", String(cursor.ts));
    if (cursor.id !== undefined) params.set("sinceId", cursor.id);
    params.set("limit", String(SYNC_BATCH_SIZE));
    params.set("mutationSince", String(mutationCursor));

    const response = await api.get<SyncResponse>(`/api/messages/sync?${params.toString()}`);
    if (!isCurrentSession(session)) return;
    for (const mutation of response.mutations ?? []) {
      if (!isCurrentSession(session)) return;
      await ingestMessageFrame(mutation);
      mutationCursor = mutation.mutationSeq;
    }
    if (!isCurrentSession(session)) return;
    mutationCursor = Math.max(mutationCursor, response.mutationCursor ?? 0);
    if (!options?.conversationId && mutationStateId && (response.mutations?.length || response.mutationCursor !== undefined)) {
      await advanceMutationCursor(mutationStateId, mutationCursor);
    }

    for (const frame of response.messages) {
      if (!isCurrentSession(session)) return;
      await ingestMessageFrame(frame);
    }
    if (!isCurrentSession(session)) return;

    const lastFrame = response.messages[response.messages.length - 1];
    if (lastFrame) cursor = { ts: lastFrame.syncTimestamp ?? lastFrame.deletedAt ?? getFrameTimestamp(lastFrame), id: lastFrame.id };

    // Live frames and conversation-specific backfills never advance this cursor.
    if (lastFrame && !options?.conversationId && syncStateId) {
      await saveSyncState(syncStateId, cursor.ts, cursor.id);
    }

    if ((!response.hasMore && !response.hasMoreMutations) || (!response.messages.length && !response.mutations?.length)) {
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
    deletedAt: message.deletedAt,
    deletedByUserId: message.deletedByUserId,
  };
}

// Only cached page reads extend this window. Mutation/live-injected entries do not.
const historyWindows = new Map<string, { oldest?: CachedMessageCursor; hasOlder: boolean }>();
async function publishCachedPage(conversationId: string, session: MessageSession, before?: CachedMessageCursor): Promise<PersistedConversationLoadResult> {
  while (isCurrentSession(session)) {
    const generation = getConversationHideGeneration(conversationId);
    const page = await getCachedConversationMessagesPage(conversationId, { before, limit: LOCAL_MESSAGES_PAGE_SIZE });
    if (!isCurrentSession(session)) return { loadedCount: 0, hasOlder: false };
    // The page and all guards share one IDB snapshot. If a local/peer hide committed
    // during that await, retry the snapshot; never publish its stale plaintext/keys.
    if (generation !== getConversationHideGeneration(conversationId)) continue;
    const now = Date.now();
    const messages = page.messages.map((message) => normalizeStoredMessage(message, now))
      .filter((message): message is DecryptedMessage => message !== null);
    useChatStore.getState().prependMessages(conversationId, messages);
    historyWindows.set(conversationId, { oldest: page.oldestCursor ?? before, hasOlder: page.hasOlder });
    return { loadedCount: messages.length, hasOlder: page.hasOlder };
  }
  return { loadedCount: 0, hasOlder: false };
}
export async function loadPersistedConversationMessages(conversationId: string): Promise<PersistedConversationLoadResult> {
  return publishCachedPage(conversationId, captureSession());
}
export async function loadOlderPersistedConversationMessages(conversationId: string): Promise<PersistedConversationLoadResult> {
  const window = historyWindows.get(conversationId);
  // A store populated only by mutations has no contiguous cache window yet.
  if (!window) return loadPersistedConversationMessages(conversationId);
  if (!window.hasOlder || !window.oldest) return { loadedCount: 0, hasOlder: false };
  return publishCachedPage(conversationId, captureSession(), window.oldest);
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
  historyWindows.clear();
}

async function applyMessageDeletion(message: DecryptedMessage, deletedAt: number, deletedByUserId: string, session: MessageSession) {
  if (!isCurrentSession(session)) return;
  const inStore = useChatStore.getState().messages.get(message.conversationId)?.find((row) => row.id === message.id);
  if (inStore && (inStore.senderId !== message.senderId || inStore.conversationId !== message.conversationId)) return;
  const tombstone: DecryptedMessage = { ...message, content: "", fileMetadata: undefined, deletedAt, deletedByUserId };
  if (!await removeLocalMessageContent(message.id, toLocalMessage(tombstone), () => isCurrentSession(session))) return;
  const visible = await guardMessageForPublish(tombstone);
  if (visible && isCurrentSession(session)) useChatStore.getState().addMessage(message.conversationId, visible);
}

export async function handleMessageDeletion(payload: MessageEventPayload): Promise<void> {
  const session = captureSession();
  if (!payload.deletion) return;
  const { ids, deletedAt, deletedByUserId } = payload.deletion;
  for (const id of ids) {
    // Finish any authenticated receive before clearing its output, preserving ratchet progress.
    const previous = inFlightDecryptIds.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      if (!isCurrentSession(session)) return;
      const existing = await getMessageById(id);
      if (!isCurrentSession(session)) return;
      if (existing && (existing.conversationId !== payload.conversationId || existing.senderId !== deletedByUserId)) return;
      if (!await rememberMessageDeletion(id, payload.conversationId, deletedAt, deletedByUserId, deletedByUserId, () => isCurrentSession(session))) return;
      if (existing && existing.conversationId === payload.conversationId) {
        await applyMessageDeletion({ ...existing, type: existing.type as DecryptedMessage["type"], status: existing.status as DecryptedMessage["status"], expiryKind: existing.expiryKind ?? "retention" }, deletedAt, deletedByUserId, session);
      }
    });
    inFlightDecryptIds.set(id, pending);
    try { await pending; } finally { if (inFlightDecryptIds.get(id) === pending) inFlightDecryptIds.delete(id); }
  }
}

export async function deleteMessageForLocalUserOnly(conversationId: string, messageId: string, current: () => boolean = () => true): Promise<void> {
  const session = captureSession();
  await inFlightDecryptIds.get(messageId)?.catch(() => undefined);
  if (!current() || !isCurrentSession(session)) return;
  const existing = await getMessageById(messageId);
  if (!current() || !isCurrentSession(session) || (existing && existing.conversationId !== conversationId)) return;
  await removeLocalMessageContent(messageId, undefined, () => current() && isCurrentSession(session));
  if (current() && isCurrentSession(session)) useChatStore.getState().removeMessages([messageId]);
}

/** The timer lives outside the bubble lifecycle: removing the bubble must not cancel commit. */
export async function hideMessageWithUndo(conversationId: string, messageId: string, current: () => boolean = () => true): Promise<(() => Promise<boolean>) | null> {
  const session = captureSession();
  await inFlightDecryptIds.get(messageId)?.catch(() => undefined);
  if (!current() || !isCurrentSession(session)) return null;
  const pending = await beginMessageHide(messageId, () => current() && isCurrentSession(session));
  if (!pending) return null;
  const { token, deadline } = pending;
  const commit = () => finishMessageHide(messageId, token, false);
  const timer = setTimeout(() => { void commit().catch(() => undefined); }, Math.max(0, deadline - Date.now()));
  if (!current() || !isCurrentSession(session)) return null;
  useChatStore.getState().removeMessages([messageId]);
  return async () => {
    if (!current() || !isCurrentSession(session)) return false;
    if (Date.now() >= deadline) { await commit(); return false; }
    const record = await finishMessageHide(messageId, token, true, () => current() && isCurrentSession(session));
    if (record) clearTimeout(timer);
    const visible = record ? await guardMessageForPublish(record) : null;
    if (!visible || !current() || !isCurrentSession(session)) return false;
    const message = normalizeStoredMessage(visible, Date.now());
    if (!message) return false;
    useChatStore.getState().addMessage(conversationId, message);
    return true;
  };
}

/** Re-read shared state, never trust content carried by another tab. Removal unmounts
 * FilePreview, whose cleanup aborts decryption and revokes attachment object URLs. */
export async function reconcileLocalMessageChange(id: string, target: { addMessage: (conversationId: string, message: DecryptedMessage) => void; removeMessages: (ids: string[]) => void } = useChatStore.getState(), current: () => boolean = () => true): Promise<void> {
  const record = await getMessageById(id);
  const visible = record ? await guardMessageForPublish(record) : null;
  if (!current()) return;
  const message = visible ? normalizeStoredMessage(visible, Date.now()) : null;
  if (message) target.addMessage(message.conversationId, message);
  else target.removeMessages([id]);
}
export function startLocalHiddenMessageSync(): () => void {
  const session = captureSession();
  if (!session.userId || !session.deviceId) return () => {};
  let stopped = false, pending = Promise.resolve();
  const current = () => !stopped && isCurrentSession(session);
  const close = connectLocalMessageChannel({ userId: session.userId, deviceId: session.deviceId }, ({ id }) => {
    pending = pending.then(() => current() ? reconcileLocalMessageChange(id, useChatStore.getState(), current) : undefined).catch(() => undefined);
  });
  return () => { stopped = true; close(); };
}
