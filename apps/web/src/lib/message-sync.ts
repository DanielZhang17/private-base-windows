import type {
  ConversationWithMembers,
  DecryptedMessage,
  SenderKeyHeader,
  WSMessageFrame,
  MessageEventPayload,
  HistoryDeletionResult,
  MessageEditFrame,
} from "@e2ee-chat/shared";
import { CALL_KEY_RECOVERY_TTL_MS, HISTORY_DELETION_BATCH_SIZE, carriesEditKey, MAX_EDIT_ENVELOPE_BYTES, MAX_LATEST_EDIT_IDS, SYNC_PAGE_TOO_LARGE, WSFrameType } from "@e2ee-chat/shared";
import { decryptMessageEdit, fromBase64Url, toBase64Url, type SealedEditKey } from "@e2ee-chat/crypto";
import { messageEditScope } from "./message-edit.js";
import { api } from "../services/api.js";
import {
  getCachedConversationMessagesPage,
  cleanupExpiredMessages,
  cleanupExpiredPendingCalls,
  getLatestCachedMessageTimestamp,
  getMessageById,
  reconcileMessageEditKey,
  getEditKeyResetToken,
  guardMessageForPublish,
  logicalMessageId,
  beginMessageHide,
  finishMessageHide,
  isMessageHidden, hasReceivedMessage,
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
  getOriginalForEdit,
  applyReceivedEdit,
  queueLockedEdit,
  lockedEditIds,
  readLockedEdit,
  finishLockedEdit,
  queueEditLookups,
  hasEditLookups,
  claimEditLookups,
  finishEditLookups,
  type EditHistoryCheckpoint,
  saveSyncState,
  advanceMutationCursor,
  type LocalMessage,
  type CachedMessageCursor,
} from "../db/index.js";
import { isSticker } from "./stickers.js";
import { normalizeExpiryMetadata } from "./message-retention.js";
import { messageVisibleToAccount } from "./message-account.js";
import {
  advanceImportedDeletionPoll, getImportedConversationIds, hasQuarantinedHistory, importedDeletionPage,
  reserveImportedDeletionPoll, selectedImportedDeletionCandidates, unverifiedLegacyCount, verifyLegacyHistoryOwnership, type HistoryDisclosureCandidate,
} from "../db/history-transfer.js";
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
import { consumeOneTimePreKey, getUnlockGeneration, keysLoaded } from "./key-manager.js";
import { connectLocalMessageChannel, getConversationHideGeneration } from "./local-message-changes.js";
import { capabilities } from "../platform/capabilities.js";

const conversationCache = new Map<string, ConversationWithMembers>();
const inFlightDecryptIds = new Map<string, Promise<void>>();
let syncEpoch = 0;
const LOCAL_MESSAGES_PAGE_SIZE = 100;
const SYNC_BATCH_SIZE = 250;
const INITIAL_SYNC_BACKFILL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 5_000;
const EDIT_HISTORY_RESUME_INTERVAL_MS = 30_000;
let lastSyncStartedAt = 0;
let activeGlobalSync: Promise<void> | null = null;
let activeEditLookup: Promise<number | undefined> | null = null;
let editLookupTimer: ReturnType<typeof setTimeout> | undefined;
let editLookupRequested = false;

interface SyncCursor {
  ts: number;
  id?: string;
  emptyLocal?: boolean;
}

interface SyncResponse {
  messages: WSMessageFrame[];
  hasMore: boolean;
  mutations?: ((WSMessageFrame | { edit: MessageEditFrame }) & { mutationSeq: number })[];
  hasMoreMutations?: boolean;
  mutationCursor?: number;
  mutationHighWater?: number;
  editStream?: true;
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

function knownDirectChat(conversationId: string): boolean | undefined {
  const chat = conversationCache.get(conversationId) ?? useChatStore.getState().conversations.find(({ id }) => id === conversationId);
  return chat && chat.type === "direct";
}

function editScope(session: MessageSession) {
  return session.userId && session.deviceId ? `${session.userId}:${session.deviceId}` : undefined;
}

function isCurrentSession(session: MessageSession): boolean {
  return session.epoch === syncEpoch && sameLogin(session);
}

function sameLogin(session: MessageSession): boolean {
  const { sessionId, user, device } = useAuthStore.getState();
  return session.sessionId === sessionId && session.userId === user?.id && session.deviceId === device?.id;
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

function toLocalMessage(message: DecryptedMessage & Pick<LocalMessage, "direct" | "wireId">): LocalMessage {
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
    direct: message.direct,
    wireId: message.wireId,
    ...(message.importedAt !== undefined ? { importedAt: message.importedAt } : {}),
    ...(message.ownerId ? { ownerId: message.ownerId } : {}),
    ...(message.transferSourceId ? { transferSourceId: message.transferSourceId } : {}),
    ...(message.imported ? { imported: message.imported } : {}),
    ...(message.editedAt !== undefined ? { editedAt: message.editedAt, editedByUserId: message.editedByUserId } : {}),
    editSequence: message.editSequence,
    latestEditSeq: message.latestEditSeq,
    editKeyAccepted: message.editKeyAccepted,
    pendingEdit: message.deletedAt ? null : message.pendingEdit,
    editSenderDeviceId: message.deletedAt ? undefined : message.editSenderDeviceId,
  };
}

// Metadata updates whose latest state has not yet been saved to IndexedDB.
const unpersistedMessageIds = new Set<string>();

async function persistMessage(message: DecryptedMessage, ownerId?: string): Promise<void> {
  unpersistedMessageIds.add(message.id);
  await saveMessage(toLocalMessage(message), undefined, ownerId);
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
    if (await getSyncState(`cached-live-empty:${syncStateId}`)) return { ts: 0 };
  }

  const latestCachedTimestamp = await getLatestCachedMessageTimestamp(useAuthStore.getState().user?.id ?? null);
  return { ts: Math.max(0, latestCachedTimestamp - INITIAL_SYNC_BACKFILL_MS), emptyLocal: latestCachedTimestamp === 0 };
}

function receivedMessage(frame: WSMessageFrame, content: string, status: "delivered" | "failed" = "delivered"): DecryptedMessage {
  return {
    id: frame.id, conversationId: frame.conversationId, senderId: frame.senderId,
    type: frame.msgType as DecryptedMessage["type"], content, timestamp: getFrameTimestamp(frame),
    latestEditSeq: frame.latestEditSeq,
    expiresAt: frame.expiresAt, expiryKind: frame.expiryKind, status,
  };
}

async function prepareReceiveEffects(frame: WSMessageFrame, plaintext: Uint8Array, editKey?: Uint8Array, editKeyResetToken?: string | null, repairScope?: string): Promise<ReceiveEffects> {
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
    effects.message = {
      ...toLocalMessage(receivedMessage(frame, content)),
      ...(frame.msgType === "text" && frame.editKeyAccepted !== false && editKey && {
        editKey: toBase64Url(editKey.subarray(0, 32)), editSigningKey: toBase64Url(editKey.subarray(32, 64)),
        editSenderDeviceId: frame.senderDeviceId, editKeyAccepted: true,
      }),
    };
    if (effects.message.editKey) {
      effects.editKeyResetToken = editKeyResetToken;
      effects.editRepairScope = repairScope;
    }
  } else if (frame.msgType !== "sender_key_distribution") {
    throw new TypeError("Unsupported message/control kind");
  }
  return effects;
}

export async function ingestMessageEdit(edit: MessageEditFrame, repairMissing = true): Promise<"invalid" | void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(edit.messageId) || !Number.isSafeInteger(edit.editSeq) || edit.editSeq < 1
    || !Number.isSafeInteger(edit.mutationSeq) || edit.mutationSeq < 1
    || typeof edit.ciphertext !== "string" || edit.ciphertext.length > MAX_EDIT_ENVELOPE_BYTES
    || typeof edit.nonce !== "string" || edit.nonce.length !== 16 || typeof edit.signature !== "string" || edit.signature.length !== 86
    || !Number.isSafeInteger(edit.editedAt) || !Number.isSafeInteger(edit.expiresAt) || edit.expiresAt <= Date.now()) return "invalid";
  const session = captureSession();
  const scope = editScope(session);
  if (!scope) return;
  if (!keysLoaded()) {
    await queueLockedEdit(scope, edit, () => sameLogin(session));
    return;
  }
  const generation = getUnlockGeneration();
  const current = () => isCurrentSession(session) && keysLoaded() && getUnlockGeneration() === generation;
  try {
    if (!current()) throw new DOMException("Edit session changed", "AbortError");
    return await applyMessageEdit(edit, session, current, repairMissing ? scope : undefined);
  } catch (error) {
    if (!current() && sameLogin(session)) {
      await queueLockedEdit(scope, edit, () => sameLogin(session));
    } else {
      throw error;
    }
  }
}

async function applyMessageEdit(edit: MessageEditFrame, session: MessageSession, current: () => boolean, repairScope?: string) {
  // The Worker delivers edits only to devices eligible for an original envelope.
  if (!session.userId || !session.deviceId) return;
  const original = await getOriginalForEdit(edit, session.userId, session.deviceId, current, repairScope);
  if (!original) return;
  const refreshStaleVisibleEdit = async (sequence: number) => {
    const visible = useChatStore.getState().messages.get(original.conversationId)?.find((row) => row.id === original.id);
    if (visible && (visible.editSequence ?? 0) < sequence) await reconcileLocalMessageChange(original.id, undefined, current);
  };
  const sequence = original.editSequence ?? 0;
  if (sequence >= edit.editSeq) {
    await refreshStaleVisibleEdit(sequence);
    return;
  }
  if (!original.editKey || !original.editSigningKey) return;
  let content: string;
  try {
    content = await decryptMessageEdit(fromBase64Url(original.editKey), fromBase64Url(original.editSigningKey), edit, edit.editSeq, edit);
  } catch (error) {
    if (!current()) throw error;
    return "invalid" as const;
  }
  const updated = await applyReceivedEdit(edit, original, content, current);
  if (!current()) return;
  if (updated === "invalid") return updated;
  if (updated) await publishCachedEdit(updated.id, updated.conversationId, current);
  else await refreshStaleVisibleEdit(edit.editSeq);
}

async function drainLockedEdits(session: MessageSession, messageIds?: ReadonlySet<string>) {
  const scope = editScope(session);
  if (!scope || !session.deviceId || !session.userId || !isCurrentSession(session) || !keysLoaded()) return;
  const generation = getUnlockGeneration();
  const current = () => isCurrentSession(session) && keysLoaded() && getUnlockGeneration() === generation;
  for (const id of await lockedEditIds(scope, messageIds)) {
    if (!current()) return;
    const edit = await readLockedEdit(id);
    if (!edit || !current()) continue;
    const outcome = await ingestMessageEdit(edit, false);
    if (current()) await finishLockedEdit(id, edit, session.userId, session.deviceId, current, outcome === "invalid");
  }
}

function canConfirmEditKey(message: LocalMessage, session: MessageSession) {
  return !!session.deviceId && message.editKeyAccepted === undefined && message.senderId === session.userId
    && message.editSenderDeviceId === session.deviceId && ["sent", "delivered", "read"].includes(message.status);
}

function canLookUpEdit(message: LocalMessage | undefined, session: MessageSession): message is LocalMessage {
  return !!message && (message.editKeyAccepted === true || canConfirmEditKey(message, session))
    && !message.deletedAt && normalizeExpiryMetadata(message).expiresAt > Date.now();
}

async function checkQueuedEdits(session: MessageSession, scope: string): Promise<number | undefined> {
  const { deviceId, userId } = session;
  if (!deviceId || !userId) return;
  const generation = getUnlockGeneration();
  const current = () => isCurrentSession(session) && keysLoaded() && getUnlockGeneration() === generation;
  const claim = await claimEditLookups(scope, MAX_LATEST_EDIT_IDS, current);
  if (!claim || "nextAt" in claim) return claim?.nextAt;
  try {
    const versions = new Map<string, number>();
    const provisional = new Map<string, LocalMessage>();
    for (const job of claim.jobs) {
      const message = await getMessageById(job.messageId, userId);
      if (!canLookUpEdit(message, session)) continue;
      const id = message.id.split(":")[0];
      versions.set(id, Math.max(message.editSequence ?? 0, versions.get(id) ?? 0));
      if (canConfirmEditKey(message, session)) provisional.set(id, message);
    }
    if (!current()) return finishEditLookups(scope, claim, "paused");
    if (versions.size) {
      const response = await api.post<{ edits: MessageEditFrame[]; confirmed?: string[] }>("/api/messages/edits/latest", {
        ids: [...versions.keys()], after: Object.fromEntries(versions), ...(provisional.size && { confirm: true }),
      });
      for (const id of response.confirmed ?? []) {
        if (!current()) break;
        const original = provisional.get(id);
        if (original && await reconcileMessageEditKey({ ...original, senderDeviceId: deviceId }, true, current, userId)) {
          await publishCachedEdit(original.id, original.conversationId, current);
        }
      }
      for (const edit of response.edits) {
        if (!sameLogin(session)) break;
        if (versions.has(edit.messageId)) await ingestMessageEdit(edit);
      }
    }
    return finishEditLookups(scope, claim, current() ? "success" : "paused");
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    return finishEditLookups(scope, claim, !current() ? "paused" : status === 429 ? "rate-limited" : status === 404 ? "unavailable" : "failure");
  }
}

/** Schedule independently of ordinary sync, including when a request is still in flight. */
function startEditLookups(session: MessageSession, at = Date.now()) {
  const scope = editScope(session);
  if (!scope || !isCurrentSession(session) || !keysLoaded() || editLookupTimer !== undefined) return;
  if (activeEditLookup) { editLookupRequested = true; return; }
  if (at > Date.now()) {
    editLookupTimer = setTimeout(() => { editLookupTimer = undefined; startEditLookups(session); }, at - Date.now());
    return;
  }
  const pending = checkQueuedEdits(session, scope).catch(() => Date.now() + 5_000);
  activeEditLookup = pending;
  void pending.then((nextAt) => {
    if (activeEditLookup !== pending) return;
    activeEditLookup = null;
    const requested = editLookupRequested;
    editLookupRequested = false;
    if (nextAt !== undefined || requested) startEditLookups(session, nextAt);
  });
}

async function queueLocalEditChecks(messages: LocalMessage[], session: MessageSession, checkpoint?: EditHistoryCheckpoint) {
  const scope = editScope(session);
  if (!scope || !isCurrentSession(session)) return false;
  const ids = messages.filter((message) => canLookUpEdit(message, session)).map((message) => message.id);
  if ((ids.length || checkpoint) && !await queueEditLookups(scope, ids, () => isCurrentSession(session), checkpoint)) return false;
  if (ids.length) startEditLookups(session);
  return true;
}

interface OriginalEditCheck { frame: WSMessageFrame; deferred?: boolean }

async function reconcileOriginalFrames(originals: OriginalEditCheck[], session: MessageSession) {
  const stale: LocalMessage[] = [];
  for (const { frame, deferred } of originals) {
    if (!isCurrentSession(session)) return;
    if (deferred || frame.deletedAt || frame.msgType !== "text" || !frame.latestEditSeq) continue;
    const original = await getMessageById(frame.id, session.userId ?? null);
    if (original && original.conversationId === frame.conversationId && original.senderId === frame.senderId
      && (original.editSequence ?? 0) < frame.latestEditSeq) stale.push(original);
  }
  await queueLocalEditChecks(stale, session);
  // Saving an original can turn a stored repair marker or deferred receive into a lookup job.
  if (!stale.length && originals.some(({ frame }) => frame.msgType === "text" && !frame.deletedAt && carriesEditKey(frame.header))) startEditLookups(session);
}

async function decryptIncomingMessage(frame: WSMessageFrame, session: MessageSession, context: Omit<ReceiveContext, "prepare">): Promise<string | null> {
  const conversation = await getConversation(frame.conversationId);
  if (!isCurrentSession(session)) return null;
  if (!conversation || !["direct", "group"].includes(conversation.type)) throw new TypeError("Invalid conversation metadata");
  const incoming: IncomingMessage = {
    id: frame.id, senderId: frame.senderId, senderDeviceId: frame.senderDeviceId,
    type: frame.msgType, ciphertext: frame.ciphertext, iv: frame.iv, header: frame.header,
  };
  let editKey: Uint8Array | undefined;
  let sealed: SealedEditKey | undefined;
  if (frame.msgType === "text" && frame.editKeyAccepted !== false) {
    try { sealed = JSON.parse(frame.header)?.editKey; } catch { /* The normal header parser handles malformed headers. */ }
  }
  const editKeyResetToken = sealed ? await getEditKeyResetToken() : undefined;
  const receive: ReceiveContext = {
    ...context,
    ...(sealed && { editKey: {
      scope: messageEditScope(frame, frame.senderDeviceId), sealed,
      accept: (bytes: Uint8Array) => { editKey = bytes; },
    } }),
    prepare: async (plaintext) => ({
      ...await prepareReceiveEffects(frame, plaintext, editKey, editKeyResetToken, editScope(session)),
      ownerId: session.userId, deviceId: session.deviceId, direct: conversation.type === "direct",
    }),
  };
  if (conversation.type === "group" || frame.msgType === "sender_key_distribution") {
    return decryptGroupText(frame.conversationId, incoming, receive);
  }
  return decryptMessage("direct", incoming, receive);
}

function isAcceptanceEcho(frame: WSMessageFrame): boolean {
  return frame.recipientDeviceId === frame.senderDeviceId;
}

/**
 * Applies a frame for a message this device already has (a re-synced copy of a live message, or
 * the echo of a sent one). Returns null when the message is unknown; otherwise the merged
 * message and whether the frame changed anything that is stored.
 */
async function mergeExistingMessage(frame: WSMessageFrame, session: MessageSession, isLocalEcho: boolean, editAcceptanceChanged: boolean): Promise<{
  message: DecryptedMessage;
  changed: boolean;
} | null> {
  const existingMessages = useChatStore.getState().messages.get(frame.conversationId) ?? [];
  const ownerId = session.userId ?? null;
  const inStore = existingMessages.find((message) => message.id === logicalMessageId(frame.id, knownDirectChat(frame.conversationId) === true) && messageVisibleToAccount(message, ownerId));
  const existing = await getMessageById(frame.id, ownerId);
  if (!existing || existing.senderId !== frame.senderId || existing.conversationId !== frame.conversationId || !isCurrentSession(session)) return null;
  // A transferred display row is not a received envelope. The actual live
  // receive must still authenticate and advance this device's ratchet.
  if (!isLocalEcho && !await getReceiveReceipt(frame.id, session.userId, session.deviceId)) return null;

  let status = existing.status as DecryptedMessage["status"];
  if (isLocalEcho) {
    if (!isAcceptanceEcho(frame)) status = "delivered";
    else if (status === "sending" || status === "failed") status = "sent";
  }
  const merged: DecryptedMessage = {
    ...existing,
    type: existing.type as DecryptedMessage["type"],
    status,
    timestamp: getFrameTimestamp(frame),
    expiresAt: frame.expiresAt,
    expiryKind: frame.expiryKind,
    ...(frame.latestEditSeq !== undefined && { latestEditSeq: Math.max(frame.latestEditSeq ?? 0, existing.latestEditSeq ?? 0) || null }),
  };
  const changed = editAcceptanceChanged || merged.status !== existing.status
    || merged.timestamp !== existing.timestamp
    || merged.expiresAt !== existing.expiresAt
    || merged.expiryKind !== existing.expiryKind || merged.latestEditSeq !== existing.latestEditSeq
    || (inStore?.importedAt !== undefined && (inStore.content !== merged.content || inStore.status !== merged.status));
  // A message known only from IndexedDB is still shown; an identical one in the store is left alone.
  const visible = await guardMessageForPublish(merged, ownerId, knownDirectChat(merged.conversationId));
  if (!isCurrentSession(session)) return null;
  if (!visible) { useChatStore.getState().removeMessages([frame.id]); return { message: merged, changed: false }; }
  if (changed || !inStore || visible.deletedAt !== merged.deletedAt) useChatStore.getState().addMessage(frame.conversationId, visible);
  return { message: visible, changed: changed || visible.deletedAt !== merged.deletedAt };
}

/** Re-read durable output when another tab wins either dedupe check or the commit. */
async function restoreCommittedFrame(frame: WSMessageFrame, session: MessageSession, isLocalEcho: boolean): Promise<"restored" | "hidden" | undefined> {
  let editAcceptanceChanged = false;
  if (frame.msgType === "text" && (isLocalEcho || frame.editKeyAccepted === false)) {
    const accepted = carriesEditKey(frame.header) ? frame.editKeyAccepted : false;
    if (accepted !== undefined && session.userId) editAcceptanceChanged = await reconcileMessageEditKey(frame, accepted, () => isCurrentSession(session), session.userId);
  }
  const merged = await mergeExistingMessage(frame, session, isLocalEcho, editAcceptanceChanged);
  if (!isCurrentSession(session)) return;
  if (merged) {
    if (merged.changed || unpersistedMessageIds.has(frame.id)) await persistMessage(merged.message, session.userId);
    if (isCurrentSession(session)) touchConversationInCache(frame.conversationId, getFrameTimestamp(frame));
    return "restored";
  }
  const receipt = await getReceiveReceipt(frame.id, session.userId, session.deviceId);
  if (!receipt) return;
  if (receipt.pendingCallId && await getPendingCall(receipt.pendingCallId) && isCurrentSession(session)) {
    useCallStore.getState().markKeyReady(receipt.pendingCallId, true);
  }
  return receipt.hidden ? "hidden" : "restored";
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
    try { await ingestMessageFrame(frame, undefined, true); } catch (error) { console.error("Deferred receive will be retried", error); }
  }
}

/** Called only while this peer's receive lock is held. Never re-enter the public ID queue. */
async function drainPeerReceives(frame: WSMessageFrame, session: MessageSession, lockKey: string, originals: OriginalEditCheck[], before?: SenderKeyHeader): Promise<void> {
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
    try {
      await ingestFrame(pending, session, lockKey, originals, false);
      originals.push({ frame: pending, deferred: true });
    } catch (error) {
      // A failed lower index is a barrier for this chain, including a newer live frame.
      if (before) throw error;
      blockedChains.add(chain);
      console.error("Deferred receive will be retried", error);
    }
  }
}

export async function ingestMessageFrame(frame: WSMessageFrame, syncOriginals?: OriginalEditCheck[], deferred = false): Promise<void> {
  const session = captureSession();
  const originals = [{ frame, deferred }];
  const previous = inFlightDecryptIds.get(frame.id) ?? Promise.resolve();
  const lockKey = `${frame.senderId}:${frame.senderDeviceId}`;
  const pending = previous.catch(() => undefined).then(() => withSessionLock(lockKey, async () => {
    await ingestFrame(frame, session, lockKey, originals);
    if (frame.msgType === "sender_key_distribution" && isCurrentSession(session)) {
      try { await drainPeerReceives(frame, session, lockKey, originals); } catch (error) {
        console.error("Could not read deferred receives after distribution", error);
      }
    }
  }));
  inFlightDecryptIds.set(frame.id, pending);
  try { await pending; } finally {
    if (inFlightDecryptIds.get(frame.id) === pending) inFlightDecryptIds.delete(frame.id);
  }
  // Never hold a receive lock over a latest-edit request.
  if (syncOriginals) syncOriginals.push(...originals);
  else await reconcileOriginalFrames(originals, session);
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

async function ingestFrame(frame: WSMessageFrame, session: MessageSession, lockKey: string, originals: OriginalEditCheck[], drainOlder = true): Promise<void> {
  if (!isCurrentSession(session) || (frame.expiresAt !== null && frame.expiresAt <= Date.now())) return;
  if (await isMessageHidden(frame.id, session.userId) && (frame.deletedAt || await hasReceivedMessage(frame.id, session.userId, session.deviceId))) {
    if (frame.deletedAt) {
      const direct = knownDirectChat(frame.conversationId) ?? (await getConversation(frame.conversationId)).type === "direct";
      await applyMessageDeletion({ ...receivedMessage(frame, ""), direct, wireId: frame.id }, frame.deletedAt, frame.deletedByUserId ?? frame.senderId, session);
    }
    if (isCurrentSession(session)) useChatStore.getState().removeMessages([frame.id]);
    return;
  }
  const { user, device } = useAuthStore.getState();
  const isLocalEcho = frame.senderId === user?.id && frame.senderDeviceId === device?.id && frame.msgType !== "system";
  const directChat = knownDirectChat(frame.conversationId)
    ?? (frame.id.includes(":") ? (await getConversation(frame.conversationId)).type === "direct" : undefined);
  const deletion = await getMessageDeletion(frame.id, session.userId, frame, directChat);
  if (frame.deletedAt || (deletion && deletion.importedAt === undefined)) {
    const conversation = await getConversation(frame.conversationId);
    const direct = conversation.type === "direct";
    const id = logicalMessageId(frame.id, direct);
    const existing = await getMessageById(id, session.userId ?? null, direct);
    if (!isCurrentSession(session)) return;
    if (!await rememberMessageDeletion(frame.id, frame.conversationId, frame.deletedAt ?? deletion!.deletedAt, frame.deletedByUserId ?? deletion?.deletedByUserId ?? frame.senderId, frame.senderId,
      () => isCurrentSession(session), session.userId, direct)) return;
    if (!existing && isLocalEcho) return;
    const display = existing ? normalizeStoredMessage(existing, Date.now(), session.userId ?? null) : { ...receivedMessage(frame, ""), id, direct, wireId: frame.id };
    if (display) await applyMessageDeletion(display, frame.deletedAt ?? deletion!.deletedAt, frame.deletedByUserId ?? deletion?.deletedByUserId ?? frame.senderId, session);
    return;
  }
  if (await restoreCommittedFrame(frame, session, isLocalEcho)) return;
  let staged: ReceiveState = {};
  try {
    if (!isCurrentSession(session)) return;
    if (isLocalEcho) {
      touchConversationInCache(frame.conversationId, getFrameTimestamp(frame));
      if (!isAcceptanceEcho(frame)) useChatStore.getState().updateMessageStatus(frame.id, "delivered");
      return;
    }
    await decryptIncomingMessage(frame, session, {
      messageId: frame.id, ownerId: session.userId, deviceId: session.deviceId, lockedSession: lockKey,
      stage: (state) => { staged = state; },
      beforeGroupDecrypt: drainOlder ? (header) => drainPeerReceives(frame, session, lockKey, originals, header) : undefined,
    });
  } catch (error) {
    const disposition = classifyReceiveError(error);
    if (disposition === "retry") throw error;
    if (disposition === "defer") {
      await savePendingReceive(frame, user?.id, device?.id);
        // Also cover another tab committing distribution just before this queue write.
      if (error instanceof MissingSenderKeyError && await getSenderKey(error.keyId)) {
        originals.push({ frame, deferred: true });
        return ingestFrame(frame, session, lockKey, originals, false);
      }
      return;
    }
    // Unauthenticated stale work must not retire a frame belonging to the prior login.
    // Authenticated receives still commit their advanced state and output together.
    if (!staged.session && !staged.senderKey && !isCurrentSession(session)) return;
    const committed = await commitReceivedMessage(frame.id, { ...terminalEffects(frame), ownerId: session.userId, deviceId: session.deviceId, direct: knownDirectChat(frame.conversationId) }, staged);
    if (committed && staged.oneTimePreKeyId !== undefined) {
      await consumeOneTimePreKey(staged.oneTimePreKeyId).catch((cleanupError) => console.error("Failed to remove a used one-time pre-key", cleanupError));
    }
  }
  // Both success and losing-tab dedupe publish only the durable output. Controls restore receipts.
  if (await restoreCommittedFrame(frame, session, isLocalEcho) !== "restored" || !isCurrentSession(session)) return;
  if (frame.msgType !== "text" && frame.msgType !== "file") return;
  if (await isMessageHidden(frame.id, session.userId, knownDirectChat(frame.conversationId)) || !isCurrentSession(session)) return;

  const { activeConversationId, incrementUnread, conversations } = useChatStore.getState();
  if (activeConversationId !== frame.conversationId) {
    incrementUnread(frame.conversationId);
  }
  if (activeConversationId !== frame.conversationId || capabilities.nativeCallNotifications) {
    if (Date.now() - frame.timestamp < 30_000 && document.visibilityState !== "visible") {
      const conv = conversations.find((c) => c.id === frame.conversationId);
      const sender = conv?.members.find((m) => m.userId === frame.senderId);
      const { showMessageNotification } = await import("./browser-notifications.js");
      const decrypted = useChatStore.getState().messages.get(frame.conversationId)?.find((message) => message.id === logicalMessageId(frame.id, knownDirectChat(frame.conversationId) === true));
      if (isCurrentSession(session)) {
        const name = sender?.user.displayName ?? "Someone";
        if (decrypted && decrypted.status !== "failed" && isSticker(decrypted)) showMessageNotification(name, frame.conversationId, "sticker");
        else showMessageNotification(name, frame.conversationId);
      }
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
  await drainLockedEdits(session).catch((error) => console.error("Queued edits will retry on the next sync", error));
  startEditLookups(session);
  if (!isCurrentSession(session)) return;
  const syncStateId = getSyncStateId();
  let cursor = await resolveSyncCursor(options?.since);
  const scope = !options?.conversationId && session.userId && session.deviceId ? `${session.userId}:${session.deviceId}` : null;
  const editStateId = scope && `message-mutations-edits:${scope}`;
  const deletionStateId = scope && `message-mutations:${scope}`;
  let editCursor = editStateId ? (await getSyncState(editStateId))?.value ?? 0 : 0;
  let deletionCursor = deletionStateId ? (await getSyncState(deletionStateId))?.value ?? 0 : 0;
  let limit = SYNC_BATCH_SIZE;
  let ordinaryFailure: { error: unknown } | undefined;

  while (isCurrentSession(session)) {
    const params = new URLSearchParams();
    if (options?.conversationId) params.set("conversationId", options.conversationId);
    params.set("since", String(cursor.ts));
    if (cursor.id !== undefined) params.set("sinceId", cursor.id);
    params.set("limit", String(limit));
    params.set("mutationSince", String(deletionCursor));
    params.set("editSince", String(editCursor));
    params.set("edits", "1");
    if (ordinaryFailure) params.set("mutationsOnly", "1");

    let response: SyncResponse;
    try {
      response = await api.get<SyncResponse>(`/api/messages/sync?${params.toString()}`);
    } catch (error) {
      const rejection = error as { status?: number; code?: string } | null;
      if (!isCurrentSession(session)) return;
      if (rejection?.status !== 413 || rejection.code !== SYNC_PAGE_TOO_LARGE || ordinaryFailure) throw error;
      if (limit === 1) ordinaryFailure = { error };
      else limit = Math.max(1, Math.floor(limit / 2));
      continue;
    }
    if (!isCurrentSession(session)) return;
    const mutations = response.mutations ?? [];
    for (const mutation of mutations) {
      if (!isCurrentSession(session)) return;
      if (!("edit" in mutation)) await ingestMessageFrame(mutation);
    }
    for (const mutation of mutations) {
      if (!isCurrentSession(session)) return;
      if ("edit" in mutation) await ingestMessageEdit(mutation.edit);
    }
    if (!isCurrentSession(session)) return;
    // An older Worker ignores editSince. Its deletion sequence is independent of
    // the edit-aware stream. Checkpoint either stream before ordinary frames.
    const mutationStateId = response.editStream ? editStateId : deletionStateId;
    const mutationCursor = Math.max(response.editStream ? editCursor : deletionCursor, mutations.at(-1)?.mutationSeq ?? 0, response.mutationCursor ?? 0);
    if (response.editStream) editCursor = mutationCursor;
    else deletionCursor = mutationCursor;
    if (mutationStateId && (mutations.length || response.mutationCursor !== undefined)) {
      await advanceMutationCursor(mutationStateId, mutationCursor);
    }

    const originals: OriginalEditCheck[] = [];
    let lastFrame: WSMessageFrame | undefined;
    if (!ordinaryFailure) {
      for (const frame of response.messages) {
        if (!isCurrentSession(session)) return;
        try { await ingestMessageFrame(frame, originals); }
        catch (error) { ordinaryFailure = { error }; break; }
        lastFrame = frame;
      }
    }
    try { await reconcileOriginalFrames(originals, session); }
    catch (error) { ordinaryFailure ??= { error }; lastFrame = undefined; }
    const originalIds = new Set(originals.filter(({ frame }) => frame.msgType === "text")
      .map(({ frame }) => messageEditScope(frame, frame.senderDeviceId).messageId));
    if (originalIds.size) await drainLockedEdits(session, originalIds).catch((error) => console.error("Queued edits will retry on the next sync", error));
    if (!isCurrentSession(session)) return;
    if (lastFrame) {
      const next = { ts: lastFrame.syncTimestamp ?? lastFrame.deletedAt ?? getFrameTimestamp(lastFrame), id: lastFrame.id };
      try {
        // Live frames and conversation-specific backfills never advance this cursor.
        if (!options?.conversationId && syncStateId) await saveSyncState(syncStateId, next.ts, next.id);
        cursor = next;
      } catch (error) { ordinaryFailure ??= { error }; }
    }

    // Drain later mutation pages without moving past the failing ordinary frame.
    if (ordinaryFailure) {
      if (!response.hasMoreMutations || !mutations.length) throw ordinaryFailure.error;
    } else if ((!response.hasMore && !response.hasMoreMutations) || (!response.messages.length && !mutations.length)) {
      if (!options?.conversationId) {
        // Keep the local fallback separate from the authoritative server cursor.
        if (syncStateId && cursor.emptyLocal) await advanceMutationCursor(`cached-live-empty:${syncStateId}`, 0);
        await reconcileImportedHistoryDeletions(session);
      }
      return;
    }
  }
}

export async function reconcileImportedHistoryDeletions(session = captureSession()): Promise<void> {
  if (!session.userId || !session.deviceId || !isCurrentSession(session)) return;
  try {
    const reservation = await reserveImportedDeletionPoll(`history-deletions:${JSON.stringify([session.userId, session.deviceId])}`);
    if (!reservation || !isCurrentSession(session)) return;
    const { candidates: batch, cursorId } = await importedDeletionPage(session.userId, reservation.cursorId);
    if (!isCurrentSession(session)) return;
    if (batch.length) {
      const { deletions } = await api.post<{ deletions: HistoryDeletionResult[] }>("/api/messages/history-deletions", {
        messages: batch.map(({ id, conversationId, senderId }) => ({ id, conversationId, senderId })),
      });
      for (const { id, conversationId, senderId, deletedAt, deletedByUserId } of deletions) {
        if (!isCurrentSession(session)) return;
        const match = batch.find((row) => row.id === id && row.conversationId === conversationId && row.senderId === senderId);
        if (match && await rememberMessageDeletion(match.displayId, conversationId, deletedAt, deletedByUserId, senderId,
          () => isCurrentSession(session), session.userId)) {
          await reconcileLocalMessageChange(match.displayId, useChatStore.getState(), () => isCurrentSession(session));
        }
      }
    }
    if (isCurrentSession(session)) await advanceImportedDeletionPoll(reservation, cursorId);
  } catch {
    // The next sync retries imported IDs independently of the already committed cursors.
  }
}

/** Preflight is independent of the throttled background poll and pins one committed boundary. */
export async function verifyHistoryDisclosure(chats: ReadonlySet<string>, current: () => boolean, archive: readonly HistoryDisclosureCandidate[] = []): Promise<void> {
  const session = captureSession();
  const { userId, deviceId } = session;
  const active = () => current() && isCurrentSession(session);
  const assertActive = () => { if (!active()) throw new Error("History disclosure session changed"); };
  const request = async <T>(send: () => Promise<T>): Promise<T> => {
    let delay = 1_000;
    for (;;) {
      assertActive();
      try { return await send(); }
      catch (error) {
        if (!(error && typeof error === "object" && "status" in error && error.status === 429)) throw error;
      }
      assertActive();
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      delay = Math.min(60_000, delay * 2);
    }
  };
  if (!userId || !deviceId) throw new Error("History disclosure requires an active device");
  assertActive();
  const key = `message-mutations:${userId}:${deviceId}`;
  let cursor = (await getSyncState(key))?.value ?? 0;
  let watermark: number | undefined;
  do {
    assertActive();
    const params = new URLSearchParams({ since: String(Number.MAX_SAFE_INTEGER), mutationSince: String(cursor), limit: String(SYNC_BATCH_SIZE) });
    if (watermark !== undefined) params.set("mutationThrough", String(watermark));
    const response = await request(() => api.get<SyncResponse>(`/api/messages/sync?${params.toString()}`));
    assertActive();
    const next = response.mutationCursor;
    watermark ??= response.mutationHighWater;
    if (watermark === undefined || !Number.isSafeInteger(watermark) || response.mutationHighWater !== watermark
      || next === undefined || !Number.isSafeInteger(next) || next < cursor || next > watermark || !Array.isArray(response.mutations)
      || (next < watermark && (next === cursor || response.hasMoreMutations !== true))) throw new Error("Incomplete deletion watermark");
    let last = cursor;
    for (const mutation of response.mutations) {
      assertActive();
      if ("edit" in mutation || !mutation.deletedAt || !Number.isSafeInteger(mutation.mutationSeq) || mutation.mutationSeq <= last || mutation.mutationSeq > next) {
        throw new Error("Invalid committed deletion");
      }
      await ingestMessageFrame(mutation);
      last = mutation.mutationSeq;
    }
    assertActive();
    await advanceMutationCursor(key, next);
    cursor = next;
  } while (cursor < watermark);

  // The current device's watermark can skip envelopes from a previous device
  // on this browser. Also look up every live record in the prepared snapshot.
  const keyFor = ({ id, conversationId, senderId }: HistoryDisclosureCandidate | HistoryDeletionResult) => JSON.stringify([id, conversationId, senderId]);
  const candidates = new Map<string, HistoryDisclosureCandidate>();
  for (const { wireId: id, displayId, conversationId, senderId } of await selectedImportedDeletionCandidates(userId, chats)) {
    const candidate = { id, displayId, conversationId, senderId };
    candidates.set(keyFor(candidate), candidate);
  }
  for (const candidate of archive) candidates.set(keyFor(candidate), candidate);
  const selected = [...candidates.values()];
  for (let offset = 0; offset < selected.length; offset += HISTORY_DELETION_BATCH_SIZE) {
    assertActive();
    const batch = selected.slice(offset, offset + HISTORY_DELETION_BATCH_SIZE);
    const requested = new Set(batch.map(keyFor));
    const { deletions } = await request(() => api.post<{ deletions: HistoryDeletionResult[] }>("/api/messages/history-deletions", {
      messages: batch.map(({ id, conversationId, senderId }) => ({ id, conversationId, senderId })),
    }));
    assertActive();
    if (!Array.isArray(deletions)) throw new Error("Incomplete history deletion lookup");
    for (const deleted of deletions) {
      const key = keyFor(deleted);
      const match = requested.has(key) && candidates.get(key);
      if (!match) throw new Error("Unexpected history deletion");
      if (!Number.isSafeInteger(deleted.deletedAt) || deleted.deletedAt <= 0 || !deleted.deletedByUserId
        || !await rememberMessageDeletion(match.id, deleted.conversationId, deleted.deletedAt, deleted.deletedByUserId, deleted.senderId, active, userId, match.direct)) {
        throw new Error("Unable to apply history deletion");
      }
      await reconcileLocalMessageChange(match.displayId, useChatStore.getState(), active);
    }
  }
  assertActive();
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
    const pending = executeSync(session, options).then(() => {
      const activeConversation = useChatStore.getState().activeConversationId;
      if (activeConversation && isCurrentSession(session) && document.visibilityState === "visible") {
        void queueConversationEditPage(activeConversation, session, "resume").catch(() => undefined);
      }
    }).finally(() => {
      if (activeGlobalSync === pending) activeGlobalSync = null;
    });
    activeGlobalSync = pending;
  }

  await activeGlobalSync;
}

export async function syncConversationMessages(conversationId: string): Promise<void> {
  const session = captureSession();
  await getConversation(conversationId).catch(() => undefined);
  if (isCurrentSession(session)) await Promise.all([syncMessages(), reconcileConversationEdits(conversationId).catch(() => undefined)]);
}

/** The edit cursor may have skipped this conversation while access was absent. */
export async function reconcileConversationEdits(conversationId: string, membershipChanged = false): Promise<void> {
  await queueConversationEditPage(conversationId, captureSession(), membershipChanged ? "restart" : "open");
}

async function queueConversationEditPage(conversationId: string, session: MessageSession, mode: "open" | "resume" | "restart") {
  const scope = editScope(session);
  if (!scope || !isCurrentSession(session) || !keysLoaded()) return;
  const id = `edit-history:${scope}:${conversationId}`;
  const previous = await getSyncState(id);
  let before: CachedMessageCursor | undefined;
  if (mode === "resume") {
    // Check older cache lazily on foreground syncs, yielding to known stale and visible messages.
    if (!previous?.cursorId || Date.now() - previous.updatedAt < EDIT_HISTORY_RESUME_INTERVAL_MS || await hasEditLookups(scope)) return;
    before = { timestamp: previous.value, id: previous.cursorId };
  }
  const page = await getCachedConversationMessagesPage(conversationId, { before, limit: mode === "resume" ? MAX_LATEST_EDIT_IDS : LOCAL_MESSAGES_PAGE_SIZE });
  const next = page.hasOlder ? page.oldestCursor : undefined;
  let checkpoint = mode !== "open" || !previous?.cursorId ? { id, previous, next } : undefined;
  while (!await queueLocalEditChecks(page.messages, session, checkpoint) && mode === "restart" && isCurrentSession(session) && keysLoaded()) {
    // A restart always uses the newest page, so only the expected bookmark changes.
    checkpoint = { id, previous: await getSyncState(id), next };
  }
}

function normalizeStoredMessage(message: LocalMessage, now: number, ownerId: string | null): DecryptedMessage | null {
  if (!messageVisibleToAccount(message, ownerId)) return null;
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
    ...(message.importedAt !== undefined ? { importedAt: message.importedAt } : {}),
    ...(message.ownerId ? { ownerId: message.ownerId } : {}),
    ...(message.transferSourceId ? { transferSourceId: message.transferSourceId } : {}),
    ...(message.imported ? { imported: message.imported } : {}),
    ...(message.editedAt !== undefined ? { editedAt: message.editedAt, editedByUserId: message.editedByUserId } : {}),
    editSequence: message.editSequence,
    latestEditSeq: message.latestEditSeq,
    editKeyAccepted: message.editKeyAccepted,
    pendingEdit: message.pendingEdit,
    editSenderDeviceId: message.editSenderDeviceId,
  };
}

// Only cached page reads extend this window. Mutation/live-injected entries do not.
const historyWindows = new Map<string, { oldest?: CachedMessageCursor; hasOlder: boolean }>();
async function publishCachedPage(conversationId: string, session: MessageSession, before?: CachedMessageCursor, preserveOldest?: CachedMessageCursor): Promise<PersistedConversationLoadResult> {
  while (isCurrentSession(session)) {
    const generation = getConversationHideGeneration(conversationId);
    const page = await getCachedConversationMessagesPage(conversationId, { before, limit: LOCAL_MESSAGES_PAGE_SIZE,
      ownerId: session.userId ?? null, direct: knownDirectChat(conversationId) });
    if (!isCurrentSession(session)) return { loadedCount: 0, hasOlder: false };
    // The page and all guards share one IDB snapshot. If a local/peer hide committed
    // during that await, retry the snapshot; never publish its stale plaintext/keys.
    if (generation !== getConversationHideGeneration(conversationId)) continue;
    const now = Date.now();
    const ownerId = session.userId ?? null;
    const isOlderThanBoundary = (row: CachedMessageCursor) => !!preserveOldest && (row.timestamp < preserveOldest.timestamp
      || (row.timestamp === preserveOldest.timestamp && row.id < preserveOldest.id));
    const foundOlder = !!page.oldestCursor && isOlderThanBoundary(page.oldestCursor);
    const messages = page.messages.filter((row) => !isOlderThanBoundary(row)).map((message) => normalizeStoredMessage(message, now, ownerId))
      .filter((message): message is DecryptedMessage => message !== null);
    const chat = useChatStore.getState();
    const foreignIds = (chat.messages.get(conversationId) ?? [])
      .filter((message) => !messageVisibleToAccount(message, ownerId)).map(({ id }) => id);
    if (foreignIds.length || page.suppressedIds.length) chat.removeMessages([...foreignIds, ...page.suppressedIds]);
    chat.prependMessages(conversationId, messages);
    const oldest = foundOlder ? preserveOldest : page.oldestCursor ?? before;
    const hasOlder = foundOlder || page.hasOlder;
    historyWindows.set(conversationId, { oldest, hasOlder });
    if (before) void queueLocalEditChecks(page.messages, session).catch(() => undefined);
    return { loadedCount: messages.length, hasOlder };
  }
  return { loadedCount: 0, hasOlder: false };
}
export async function loadPersistedConversationMessages(conversationId: string): Promise<PersistedConversationLoadResult> {
  return publishCachedPage(conversationId, captureSession());
}

/** Reuse the exact-envelope promotion from transfer when opening an upgraded chat. */
export async function restoreVerifiedLegacyHistory(conversation: ConversationWithMembers, current: () => boolean): Promise<number | undefined> {
  const session = captureSession();
  const { userId, deviceId } = session;
  const active = () => current() && isCurrentSession(session);
  if (!userId || !deviceId || !conversation.members.some(({ userId: member, conversationId }) => member === userId && conversationId === conversation.id)
    || !await hasQuarantinedHistory(conversation.id) || !active()) return;
  try {
    await verifyLegacyHistoryOwnership(userId, [conversation], async (messages) =>
      (await api.post<{ ids: string[] }>("/api/messages/history-ownership?purpose=local", { messages })).ids, active, Date.now(), async (ids) => {
        for (const id of ids) await reconcileLocalMessageChange(id, useChatStore.getState(), active);
      });
  } catch {
    // Existing canonical history remains usable while verification is unavailable.
  }
  if (!active()) return;
  const pending = await unverifiedLegacyCount(userId, conversation);
  return active() ? pending : undefined;
}

/** Refresh pages inside the existing contiguous window after an import. */
export async function refreshImportedConversationMessages(conversationId: string): Promise<PersistedConversationLoadResult> {
  const previous = historyWindows.get(conversationId)?.oldest;
  const session = captureSession();
  let page = await publishCachedPage(conversationId, session, undefined, previous);
  let loadedCount = page.loadedCount;
  while (previous && isCurrentSession(session) && page.hasOlder) {
    const oldest = historyWindows.get(conversationId)?.oldest;
    if (!oldest || oldest.timestamp < previous.timestamp || (oldest.timestamp === previous.timestamp && oldest.id <= previous.id)) break;
    page = await publishCachedPage(conversationId, session, oldest, previous);
    loadedCount += page.loadedCount;
  }
  return { loadedCount, hasOlder: page.hasOlder };
}

/** Read only the newest visible row for the chat-list preview. */
export async function refreshLatestConversationPreview(conversationId: string, session = captureSession()): Promise<void> {
  if (!session.userId) return;
  while (isCurrentSession(session)) {
    const generation = getConversationHideGeneration(conversationId);
    const { messages, suppressedIds } = await getCachedConversationMessagesPage(conversationId, { limit: 1,
      ownerId: session.userId, direct: knownDirectChat(conversationId) });
    if (!isCurrentSession(session)) return;
    if (generation !== getConversationHideGeneration(conversationId)) continue;
    const preview = messages[0] && normalizeStoredMessage(messages[0], Date.now(), session.userId);
    const chat = useChatStore.getState();
    if (suppressedIds.length) chat.removeMessages(suppressedIds);
    if (preview) {
      const existing = chat.messages.get(conversationId)?.find(({ id }) => id === preview.id);
      if (existing && !messageVisibleToAccount(existing, session.userId)) chat.removeMessages([preview.id]);
      chat.prependMessages(conversationId, [preview]);
    }
    return;
  }
}

export async function hydrateImportedConversationPreviews(conversationIds: ReadonlySet<string>): Promise<void> {
  const session = captureSession();
  if (!session.userId || !isCurrentSession(session)) return;
  for (const id of await getImportedConversationIds(session.userId)) {
    if (!isCurrentSession(session)) return;
    if (conversationIds.has(id)) await refreshLatestConversationPreview(id, session);
  }
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
  const deletedIds = await cleanupExpiredMessages(now, session.userId);
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
  activeEditLookup = null;
  clearTimeout(editLookupTimer);
  editLookupTimer = undefined;
  editLookupRequested = false;
  conversationCache.clear();
  historyWindows.clear();
}

async function applyMessageDeletion(message: DecryptedMessage & Pick<LocalMessage, "direct" | "wireId">, deletedAt: number, deletedByUserId: string, session: MessageSession) {
  if (!isCurrentSession(session)) return;
  const inStore = useChatStore.getState().messages.get(message.conversationId)?.find((row) => row.id === message.id);
  if (inStore && (inStore.senderId !== message.senderId || inStore.conversationId !== message.conversationId)) return;
  const tombstone = { ...message, ownerId: message.ownerId ?? session.userId, content: "", fileMetadata: undefined, deletedAt, deletedByUserId };
  if (!await removeLocalMessageContent(message.id, toLocalMessage(tombstone), () => isCurrentSession(session), session.userId ?? null)) return;
  const row = await getMessageById(message.id, session.userId ?? null);
  const visible = row && await guardMessageForPublish(row, session.userId ?? null, knownDirectChat(tombstone.conversationId));
  const canonical = visible && normalizeStoredMessage(visible, Date.now(), session.userId ?? null);
  if (canonical && isCurrentSession(session)) useChatStore.getState().addMessage(message.conversationId, canonical);
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
      const existing = await getMessageById(id, session.userId ?? null);
      if (!isCurrentSession(session)) return;
      if (existing && (existing.conversationId !== payload.conversationId || existing.senderId !== deletedByUserId)) return;
      if (!await rememberMessageDeletion(id, payload.conversationId, deletedAt, deletedByUserId, deletedByUserId, () => isCurrentSession(session), session.userId)) return;
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
  const existing = await getMessageById(messageId, session.userId ?? null);
  if (!current() || !isCurrentSession(session) || (existing && existing.conversationId !== conversationId)) return;
  await removeLocalMessageContent(messageId, undefined, () => current() && isCurrentSession(session), session.userId ?? null);
  if (current() && isCurrentSession(session)) useChatStore.getState().removeMessages([messageId]);
}

/** The timer lives outside the bubble lifecycle: removing the bubble must not cancel commit. */
export async function hideMessageWithUndo(conversationId: string, messageId: string, current: () => boolean = () => true): Promise<(() => Promise<boolean>) | null> {
  const session = captureSession();
  await inFlightDecryptIds.get(messageId)?.catch(() => undefined);
  if (!current() || !isCurrentSession(session)) return null;
  const pending = await beginMessageHide(messageId, () => current() && isCurrentSession(session), session.userId ?? null);
  if (!pending) return null;
  const { token, deadline } = pending;
  const commit = () => finishMessageHide(messageId, token, false, undefined, session.userId);
  const timer = setTimeout(() => { void commit().catch(() => undefined); }, Math.max(0, deadline - Date.now()));
  if (!current() || !isCurrentSession(session)) return null;
  useChatStore.getState().removeMessages([messageId]);
  return async () => {
    if (!current() || !isCurrentSession(session)) return false;
    if (Date.now() >= deadline) { await commit(); return false; }
    const record = await finishMessageHide(messageId, token, true, () => current() && isCurrentSession(session), session.userId);
    if (record) clearTimeout(timer);
    const visible = record ? await guardMessageForPublish(record, session.userId ?? null, knownDirectChat(record.conversationId)) : null;
    if (!visible || !current() || !isCurrentSession(session)) return false;
    const message = normalizeStoredMessage(visible, Date.now(), session.userId ?? null);
    if (!message) return false;
    useChatStore.getState().addMessage(conversationId, message);
    void queueLocalEditChecks([visible], session).catch(() => undefined);
    return true;
  };
}

/** Re-read shared state, never trust content carried by another tab. Removal unmounts
 * FilePreview, whose cleanup aborts decryption and revokes attachment object URLs. */
export async function reconcileLocalMessageChange(id: string, target: { addMessage: (conversationId: string, message: DecryptedMessage) => void; removeMessages: (ids: string[]) => void } = useChatStore.getState(), current: () => boolean = () => true): Promise<void> {
  const session = captureSession();
  const ownerId = session.userId ?? null;
  const record = await getMessageById(id, ownerId);
  const visible = record ? await guardMessageForPublish(record, ownerId, knownDirectChat(record.conversationId)) : null;
  if (!current() || !isCurrentSession(session)) return;
  const message = visible ? normalizeStoredMessage(visible, Date.now(), ownerId) : null;
  if (message) target.addMessage(message.conversationId, message);
  else target.removeMessages([id]);
}

export async function publishCachedEdit(id: string, conversationId: string, current: () => boolean): Promise<void> {
  const store = useChatStore.getState();
  if (store.messages.get(conversationId)?.some((row) => row.id === id)) {
    await reconcileLocalMessageChange(id, store, current);
    return;
  }
  // An unseen edit must not make an older original the chat-list preview.
  const session = captureSession();
  const { messages } = await getCachedConversationMessagesPage(conversationId, { limit: 1, ownerId: session.userId ?? null, direct: knownDirectChat(conversationId) });
  const latest = messages[0];
  if (!latest || !current() || !isCurrentSession(session)) return;
  const inMemory = useChatStore.getState().messages.get(conversationId)?.at(-1);
  if (!inMemory || latest.timestamp > inMemory.timestamp || (latest.timestamp === inMemory.timestamp && latest.id.localeCompare(inMemory.id) >= 0)) {
    await reconcileLocalMessageChange(latest.id, store, current);
  }
}
export function startLocalHiddenMessageSync(onOutboxChange?: (id: string) => Promise<void>): () => void {
  const session = captureSession();
  if (!session.userId || !session.deviceId) return () => {};
  let stopped = false, pending = Promise.resolve();
  const current = () => !stopped && isCurrentSession(session);
  const close = connectLocalMessageChannel({ userId: session.userId, deviceId: session.deviceId }, ({ id, kind, conversationId }) => {
    pending = pending.then(() => {
      if (!current()) return;
      if (kind === "outbox") return onOutboxChange?.(id);
      return kind === "edit" && conversationId
        ? publishCachedEdit(id, conversationId, current)
        : reconcileLocalMessageChange(id, useChatStore.getState(), current);
    }).catch(() => undefined);
  });
  return () => { stopped = true; close(); };
}
