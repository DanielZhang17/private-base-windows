import { captureMessageActionSession, isMessageActionSessionCurrent } from "./message-action-session.js";
import { INTERRUPTED_FILE_ERROR, outgoingErrorKey } from "./outgoing-errors.js";
import type {
  ConversationWithMembers,
  DecryptedMessage,
  MessageEditReceipt,
  SendMessageResponse,
} from "@e2ee-chat/shared";
import { generateAESKey, toBase64Url } from "@e2ee-chat/crypto";
import { api } from "../../services/api.js";
import { uploadMimeType } from "./uploadMimeType.js";
import {
  claimOutgoingDispatch,
  getAllOutgoingMessages,
  getMessageById,
  getEditKeyResetToken,
  guardMessageForPublish,
  getOutgoingEditStatus,
  getOutgoingEditStatuses,
  getOutgoingOperation,
  retireUnsendableOutgoing,
  updateOutgoingIfPresent,
  updateOutgoingErrorIfUnchanged,
  completeOutgoingIfPresent,
  finishQueuedEdit,
  removeLocalMessageContent,
  rememberMessageDeletion,
  subscribeOutgoingMessageReady,
  type LocalOutgoing,
  type LocalHideTarget,
  type LocalMessage,
  type OutgoingStep,
  type OutgoingEditStatus,
} from "../../db/index.js";
import { editKeyToSeal } from "../../lib/message-edit.js";
import { isSticker } from "../../lib/stickers.js";
import { deleteMessagesForLocalUserOnly, publishCachedEdit } from "../../lib/message-sync.js";
import { prepareDirectPayloadFanout } from "../../lib/direct-messages.js";
import { encryptGroupText } from "../../lib/message-processor.js";
import { finishSenderKeyDistribution, prepareSenderKeyDistribution } from "../../lib/group-session.js";
import { CONVERSATION_QUERY_KEY, touchConversationInCache } from "../../lib/conversation-cache.js";
import { queryClient } from "../../lib/query-client.js";
import { keysLoaded } from "../../lib/key-manager.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";

export const RETRY_DELAYS = [2000, 5000, 15000, 60000];
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();
const drainingMessages = new Map<string, { online: boolean; pending: LocalOutgoing[] }>();
const preparingFiles = new Set<string>();
const cancelledPreparations = new Set<string>();
export const isFilePreparationCancelled = (id: string) => cancelledPreparations.has(id);
export function setFilePreparing(id: string, preparing: boolean) {
  if (preparing) { preparingFiles.add(id); cancelledPreparations.delete(id); }
  else { preparingFiles.delete(id); cancelledPreparations.delete(id); }
}
let preparation: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let consumers = 0;
let unsubscribeOutgoingMessageReady: (() => void) | undefined;
function compareRows(left: LocalOutgoing, right: LocalOutgoing) { return left.queuedAt - right.queuedAt || left.id.localeCompare(right.id); }
function sameConversation(left: LocalOutgoing, right: LocalOutgoing) {
  return left.userId === right.userId && left.deviceId === right.deviceId && left.conversationId === right.conversationId;
}
function isMessageStep(step: OutgoingStep) {
  return step.path !== "/api/messages/send-direct-batch" || step.body.type !== "sender_key_distribution";
}
function stepMayHaveBeenDispatched(row: LocalOutgoing, step: OutgoingStep) {
  // Legacy prepared envelopes lack per-step markers; preserve them conservatively.
  return !!step.completed || (step.sendDispatched ?? row.sendDispatched ?? true);
}
function messageMayHaveBeenDispatched(row: LocalOutgoing) {
  return row.steps.some((step) => isMessageStep(step) && stepMayHaveBeenDispatched(row, step));
}
function blocksLaterMessages(row: LocalOutgoing) {
  return !row.editTargetId && (row.status === "sending" || row.retryable
    || (row.conversationType === "group" && messageMayHaveBeenDispatched(row)));
}
let queueSnapshot: LocalOutgoing[] = [];
export const getQueueSnapshot = () => queueSnapshot;
export function subscribeQueue(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

type QueueScope = Pick<LocalOutgoing, "id" | "userId" | "deviceId" | "conversationId" | "editTargetId">;

function belongsToSession(row: QueueScope) {
  const auth = useAuthStore.getState();
  return !!auth.accessToken && keysLoaded() && auth.user?.id === row.userId && auth.device?.id === row.deviceId;
}
export async function refreshOutgoingQueue(editId?: string) {
  const ownerId = useAuthStore.getState().user?.id;
  if (!ownerId) { updateQueueSnapshot([]); return; }
  if (editId) {
    const edit = await getOutgoingEditStatus(editId, ownerId);
    const rows = queueSnapshot.filter((row) => !row.editTargetId || row.id !== editId);
    if (edit) rows.push({ ...edit, steps: [] });
    updateQueueSnapshot(rows);
    return;
  }
  const rows = await getAllOutgoingMessages(ownerId);
  // Repair older text records without loading the language in which they were created.
  for (const row of rows) {
    if (!belongsToSession(row) || !row.error || preparingFiles.has(row.id)) continue;
    let key = outgoingErrorKey(row.error);
    if (!row.fileId && !row.upload && row.steps.length === 0 && (await getMessageById(row.id, row.userId))?.type === "file") key = INTERRUPTED_FILE_ERROR;
    if (key !== row.error) {
      await updateOutgoingErrorIfUnchanged(row.id, row.error, key, row.userId);
      row.error = key;
    }
  }
  updateQueueSnapshot([...rows, ...(await getOutgoingEditStatuses(ownerId)).map((edit) => ({ ...edit, steps: [] }))]);
}

function updateQueueSnapshot(rows: LocalOutgoing[]) {
  queueSnapshot = rows.filter(belongsToSession).sort(compareRows);
  listeners.forEach((listener) => listener());
  scheduleRetries();
}

function scheduleRetries() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!consumers) return;
  const due = queueSnapshot.filter((row, index) => row.retryable && !inFlight.has(row.id)
    && (row.editTargetId || (!drainingMessages.has(outgoingLockName(row))
      && !queueSnapshot.slice(0, index).some((earlier) => sameConversation(earlier, row) && blocksLaterMessages(earlier)))));
  if (due.length) {
    const nextAt = Math.min(...due.map((row) => row.nextAttemptAt ?? 0));
    const editsOnly = !due.some((row) => !row.editTargetId && (row.nextAttemptAt ?? 0) === nextAt);
    timer = setTimeout(() => { void drain(false, editsOnly).catch(console.error); }, Math.max(0, nextAt - Date.now()));
  }
}

async function showMessage(message: LocalMessage) {
  // Display durable output: another device/tab may have deleted it during this send.
  const session = useAuthStore.getState();
  const ownerId = session.user?.id ?? null;
  const record = await getMessageById(message.id, ownerId);
  const persisted = record ? await guardMessageForPublish(record, ownerId) : null;
  const current = useAuthStore.getState();
  if (session.user?.id !== current.user?.id || session.device?.id !== current.device?.id || session.sessionId !== current.sessionId) return;
  if (persisted) useChatStore.getState().addMessage(persisted.conversationId, persisted as DecryptedMessage);
  else useChatStore.getState().removeMessages([message.id]);
}

async function retireOrphan(row: QueueScope) {
  if (!belongsToSession(row) || preparingFiles.has(row.id)) return false;
  const retired = await retireUnsendableOutgoing(row.id, row.userId, !!row.editTargetId);
  if (!retired) return false;
  if (belongsToSession(retired) && !retired.editTargetId) {
    useChatStore.getState().removeMessages([retired.id]);
    useChatStore.getState().addOutgoingRemovalNotice(retired.conversationId);
  }
  return true;
}

function isRetryableSendError(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(isRetryableSendError);
  const status = (error as { status?: number } | null)?.status;
  return status === undefined ? error instanceof TypeError : status === 0 || status === 429 || status >= 500;
}

function isGroupTimeout(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "GROUP_TIMED_OUT";
}

function needsFreshGroupKeys(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "GROUP_MEMBERSHIP_CHANGED" || code === "GROUP_KEYS_UPGRADE_REQUIRED";
}

class DiscardedSend extends Error {}

async function persistOutgoing(row: LocalOutgoing, message?: LocalMessage, editKeyResetToken?: string | null) {
  if (!await updateOutgoingIfPresent(row, message, { ifUnchanged: true, prepareEditKey: !!message, editKeyResetToken })) throw new DiscardedSend();
}
function expiredReservation(error: unknown, messageSend = false) {
  const { status, message = "" } = error as { status?: number; message?: string };
  return status === 410 || (status === 404 && (!messageSend || /file/i.test(message)))
    || (status === 409 && /unattached|not attached/i.test(message));
}
async function renewUpload(row: LocalOutgoing) {
  delete row.fileId;
  if (row.upload) { delete row.upload.uploadUrl; delete row.upload.uploaded; }
  // The message endpoint explicitly rejected this reservation before accepting its envelope.
  // Keep any completed sender-key distribution, then prepare a new file envelope locally.
  row.steps = row.steps.filter((step) => step.distributed);
  row.sendDispatched = false;
  if (!await updateOutgoingIfPresent(row, undefined, { ifUnchanged: true, releaseDispatch: true })) throw new DiscardedSend();
}

/**
 * The display record of a file keeps an empty file id until the send is accepted: the server only
 * serves a file once a message attaches it, so publishing the id earlier mounts a preview that fails.
 */
function contentToSend(row: LocalOutgoing, message: LocalMessage) {
  return message.type === "file" && row.fileId ? JSON.stringify({ ...JSON.parse(message.content), fileId: row.fileId }) : message.content;
}

function isMimeTypeValidationError(error: unknown) {
  const failure = error as { status?: number; body?: { error?: { fieldErrors?: { mimeType?: unknown } } } } | null;
  const errors = failure?.body?.error?.fieldErrors?.mimeType;
  return failure?.status === 400 && Array.isArray(errors) && errors.length > 0;
}

async function prepare(row: LocalOutgoing, message: LocalMessage | undefined, current: () => boolean) {
  if (!current()) return;
  if (row.upload && !row.upload.uploaded) {
    for (let renewal = 0; ; renewal++) {
      if (!row.upload.uploadUrl) {
        const request = (mimeType: string) => api.post<{ fileId: string; uploadUrl: string }>("/api/files/upload-url", {
          conversationId: row.conversationId, mimeType, sizeBytes: row.upload!.bytes.length,
        });
        const mimeType = uploadMimeType({ type: row.upload.mimeType });
        let upload: { fileId: string; uploadUrl: string };
        try {
          upload = await request(mimeType);
        } catch (error) {
          if (!current()) return;
          if (mimeType === "application/octet-stream" || !isMimeTypeValidationError(error)) throw error;
          // Older servers may reject a newly supported media type during rollout.
          row.upload.mimeType = "application/octet-stream";
          await persistOutgoing(row);
          upload = await request("application/octet-stream");
        }
        if (!current()) return;
        row.fileId = upload.fileId;
        row.upload.uploadUrl = upload.uploadUrl;
        await persistOutgoing(row);
      }
      try {
        // ArrayBuffer selects the API client's binary, refresh-aware, session-scoped PUT path.
        await api.put(row.upload.uploadUrl, new Uint8Array(row.upload.bytes).buffer);
        if (!current()) return;
        row.upload.uploaded = true;
        await persistOutgoing(row);
        break;
      } catch (error) {
        if (!current()) return;
        if (renewal > 0 || !message || !expiredReservation(error)) throw error;
        await renewUpload(row);
      }
    }
  }
  if (row.steps.some(isMessageStep)) return;
  // Legacy v5 retention can delete the display row while leaving the outbox.
  // Prepared envelopes remain sendable; plaintext needed for new encryption does not.
  if (!message || row.editTargetId) throw new Error("messageNotSent");
  const conversation = await api.get<ConversationWithMembers>(`/api/conversations/${row.conversationId}`);
  if (!current()) return;
  // Upload and metadata requests must not hold the shared crypto-state serialization.
  const previous = preparation;
  const task = previous.catch(() => undefined).then(async () => {
    if (!current()) return;
    // Generate credentials only when this client prepares the original. A legacy
    // tab can send an unprepared shared draft without creating a stray edit key.
    const device = useAuthStore.getState().device;
    const editableText = message.type === "text" && !isSticker(message);
    const saved = editableText && message.editSenderDeviceId ? await getMessageById(message.id, row.userId, undefined, true) : undefined;
    const prepareKey = editableText && !saved?.editKey && !!device?.identityKey;
    const editKeyResetToken = prepareKey ? await getEditKeyResetToken() : undefined;
    if (!current()) return;
    const prepared = prepareKey && device ? {
      ...message, editKey: toBase64Url(generateAESKey()), editSigningKey: device.identityKey, editSenderDeviceId: device.id,
    } : undefined;
    const editKey = editableText ? editKeyToSeal(prepared ?? saved ?? message) : undefined;
    if (row.conversationType === "direct") {
      const body = await prepareDirectPayloadFanout(conversation, row.id, contentToSend(row, message), message.type as DecryptedMessage["type"], {
        ttlSeconds: row.ttlSeconds, fileId: row.fileId, ...(editKey && { editKey }),
      });
      if (!current()) return;
      row.steps = [{ path: "/api/messages/send-direct-batch", body, sendDispatched: false }];
    } else {
      const epoch = conversation.groupEpoch;
      const admission = conversation.groupAdmissionVersion;
      row.steps = row.steps.filter((step) => step.path !== "/api/messages/edit"
        && (step.body.groupEpoch ?? 0) === (epoch ?? 0)
        && (step.body.groupAdmissionVersion ?? 0) === (admission ?? 0));
      const distribution = row.steps.length ? null : await prepareSenderKeyDistribution(conversation);
      if (!current()) return;
      // Persist a prepared distribution even if encrypting the following message fails.
      if (distribution) {
        row.steps.push({ ...distribution, sendDispatched: false });
        await persistOutgoing(row);
      }
      const content = contentToSend(row, message);
      const encrypted = epoch !== undefined ? await encryptGroupText(row.conversationId, content, editKey, epoch)
        : editKey ? await encryptGroupText(row.conversationId, content, editKey) : await encryptGroupText(row.conversationId, content);
      if (!current()) return;
      row.steps.push({ path: "/api/messages/send", body: { id: row.id, conversationId: row.conversationId,
        type: message.type as DecryptedMessage["type"], ...encrypted, ttlSeconds: row.ttlSeconds, fileId: row.fileId,
        ...(epoch !== undefined && { groupEpoch: epoch }),
        ...(admission !== undefined && { groupAdmissionVersion: admission }) }, sendDispatched: false });
    }
    await persistOutgoing(row, prepared, editKeyResetToken);
  });
  preparation = task;
  await task;
}

async function attempt(id: string, ownerId: string, scheduledEdit?: { online: boolean }) {
  const initial = await getOutgoingOperation(id, ownerId);
  if (!initial || !belongsToSession(initial)) return;
  if (scheduledEdit && (!initial.retryable || (!scheduledEdit.online && (initial.nextAttemptAt ?? 0) > Date.now()))) return;
  if (await retireOrphan(initial)) return;
  const rows = initial.editTargetId ? [] : await getAllOutgoingMessages(ownerId);
  if (initial.status === "failed" && !initial.retryable) {
    // Unresolved group ciphertext keeps its position so newer chain indices cannot
    // overtake it. Direct and definitely unsent group retries join the queue tail.
    if (!initial.editTargetId && !blocksLaterMessages(initial)) initial.queuedAt = Math.max(Date.now(), ...rows.map((row) => row.queuedAt + 1));
    if (!initial.editTargetId && !messageMayHaveBeenDispatched(initial)) {
      // Replay any possibly accepted distribution unchanged, but encrypt the unsent
      // message at the current chain position after later messages may have passed it.
      initial.steps = initial.steps.filter((step) => !isMessageStep(step) && stepMayHaveBeenDispatched(initial, step))
        .map((step) => ({ ...step, sendDispatched: true }));
      initial.sendDispatched = false;
    }
    initial.status = "sending";
    initial.retryable = true;
    initial.error = null;
    initial.nextAttemptAt = null;
    const message = await getMessageById(id, initial.userId);
    const sending = message && !initial.editTargetId ? { ...message, status: "sending" } : undefined;
    if (!await updateOutgoingIfPresent(initial, sending, { ifUnchanged: true })) return;
    if (sending && belongsToSession(initial)) await showMessage(sending);
  }
  // Pending/auto-retrying envelopes must stay ordered, including sender-key distributions.
  for (const earlier of rows.filter((entry) => entry.id !== id && sameConversation(entry, initial) && compareRows(entry, initial) < 0)) {
    const pending = await getOutgoingOperation(earlier.id, ownerId);
    if (!pending || compareRows(pending, initial) >= 0) continue;
    if (!blocksLaterMessages(pending)) { await retireOrphan(pending); continue; }
    // An active attempt can still hold display content while preparing its envelope.
    if (inFlight.has(pending.id)) return;
    if (!await retireOrphan(pending) && await getOutgoingOperation(pending.id, ownerId)) return;
  }
  // Retirement and ordering checks await IndexedDB; another tab may have progressed meanwhile.
  const row = await getOutgoingOperation(id, ownerId);
  if (!row || !belongsToSession(row)) return;
  const sessionId = useAuthStore.getState().sessionId;
  const current = () => belongsToSession(row!) && useAuthStore.getState().sessionId === sessionId;
  const message = await getMessageById(row.editTargetId ?? id, row.userId);
  let rejectedDispatch = false;
  try {
    if (message?.type === "file" && !row.fileId && !row.upload && row.steps.length === 0) throw new Error(INTERRUPTED_FILE_ERROR);
    row.attempts += 1;
    row.status = "sending";
    row.retryable = true;
    for (const step of row.steps) step.sendDispatched ??= row.sendDispatched ?? true;
    row.sendDispatched = messageMayHaveBeenDispatched(row);
    // A refresh must not normalize an old error and invalidate this attempt's revision.
    row.error = null;
    row.nextAttemptAt = null;
    const sending = message && !row.editTargetId ? { ...message, status: "sending" } : undefined;
    if (!await updateOutgoingIfPresent(row, sending, { ifUnchanged: true })) return;
    if (sending) await showMessage(sending);
    await refreshOutgoingQueue(row.editTargetId ? row.id : undefined);
    await prepare(row, message, current);
    if (!current()) return;
    let result: SendMessageResponse | null = null;
    let editReceipt: MessageEditReceipt | null = null;
    let renewedUpload = false, refreshedGroupKeys = false;
    for (;;) {
      let awaitingEnvelope: OutgoingStep | undefined;
      let dispatch: false | "first" | "replay" = false;
      try {
        for (const [index, step] of row.steps.entries()) {
          if (step.completed) continue;
          if (!current()) return;
          if (isMessageStep(step)) {
            step.sendDispatched = true;
            row.sendDispatched = true;
            dispatch = await claimOutgoingDispatch(row, index, current);
            if (!dispatch || !current()) return;
          } else if (!step.sendDispatched) {
            step.sendDispatched = true;
            await persistOutgoing(row);
            if (!current()) return;
          }
          awaitingEnvelope = isMessageStep(step) ? step : undefined;
          if (step.path === "/api/messages/edit") {
            editReceipt = await api.post<MessageEditReceipt>(step.path, step.body);
            if (!Number.isSafeInteger(editReceipt?.editedAt) || !Number.isSafeInteger(editReceipt?.mutationSeq) || editReceipt.mutationSeq < 1 || editReceipt.editSeq !== step.body.editSeq) {
              throw new SyntaxError("Invalid edit receipt");
            }
          } else result = await api.post<SendMessageResponse>(step.path, step.body);
          awaitingEnvelope = undefined;
          if (!current()) return;
          if (step.distributed) await finishSenderKeyDistribution(row.conversationId, step);
          if (step !== row.steps[row.steps.length - 1]) {
            step.completed = true;
            await persistOutgoing(row);
          }
        }
        break;
      } catch (error) {
        if (!current()) return;
        const status = (error as { status?: number } | null)?.status;
        rejectedDispatch = !!awaitingEnvelope && status !== undefined && status >= 400 && status < 500 && status !== 408
          && (!isGroupTimeout(error) || dispatch === "first");
        if (awaitingEnvelope && isGroupTimeout(error) && dispatch === "first") {
          awaitingEnvelope.sendDispatched = false;
          row.sendDispatched = false;
        }
        if (row.conversationType === "group" && !row.editTargetId && needsFreshGroupKeys(error)) {
          // The membership error is authoritative. Exact committed envelopes get their
          // original receipt, so we can replace these stale prepared steps.
          row.steps = [];
          row.sendDispatched = false;
          if (!await updateOutgoingIfPresent(row, undefined, { ifUnchanged: true, releaseDispatch: true })) return;
          if (!message) throw new Error("messageNotSent");
          if (refreshedGroupKeys) throw error;
          refreshedGroupKeys = true;
          await prepare(row, message, current);
          continue;
        }
        if (renewedUpload || !row.upload || message?.type !== "file" || !expiredReservation(error, true)) throw error;
        renewedUpload = true;
        await renewUpload(row);
        await prepare(row, message, current);
      }
    }
    if (!current()) return;
    if (row.editTargetId) {
      if (editReceipt && await finishQueuedEdit(row, current, editReceipt)) await publishCachedEdit(row.editTargetId, row.conversationId, current);
      return;
    }
    if (!result) return;
    const sent = message ? { ...message, content: result.deleted ? "" : contentToSend(row, message), timestamp: result.serverTimestamp, expiresAt: result.expiresAt, expiryKind: result.expiryKind, status: "sent",
      ...(result.deleted ? { deletedAt: result.deletedAt ?? Date.now(), deletedByUserId: result.deletedByUserId ?? row.userId } : {}) } : undefined;
    if (result.deleted) {
      if (sent) await removeLocalMessageContent(row.id, sent, current, row.userId);
      else await rememberMessageDeletion(row.id, row.conversationId, result.deletedAt ?? Date.now(),
        result.deletedByUserId ?? row.userId, row.userId, current, row.userId);
    }
    if (!await completeOutgoingIfPresent(row, sent, { ifUnchanged: true, editKeyAccepted: result.editKeyAccepted })) return;
    if (sent) await showMessage(sent);
    touchConversationInCache(row.conversationId, result.serverTimestamp);
  } catch (error) {
    if (!current() || error instanceof DiscardedSend) return;
    const timedOut = isGroupTimeout(error);
    if (timedOut) void queryClient.invalidateQueries({ queryKey: [...CONVERSATION_QUERY_KEY, row.conversationId] });
    const retryable = needsFreshGroupKeys(error) || isRetryableSendError(error) || (!!row.editTargetId && error instanceof SyntaxError);
    // Preparation can fail on a network lookup before the first POST too.
    row.attempts = Math.max(1, row.attempts);
    row.status = "failed";
    row.retryable = retryable;
    row.error = timedOut ? "groupTimedOut" : row.editTargetId && !retryable ? "messageEditFailed"
      : !retryable && row.upload && !row.upload.uploaded ? "fileCouldNotBeUploaded" : outgoingErrorKey(error);
    row.nextAttemptAt = retryable ? Date.now() + RETRY_DELAYS[Math.min(row.attempts - 1, RETRY_DELAYS.length - 1)] : null;
    const failed = message && !row.editTargetId ? { ...message, status: "failed" } : undefined;
    if (!await updateOutgoingIfPresent(row, failed, { ifUnchanged: true, rejectedDispatch })) return;
    if (!retryable && await retireOrphan(row)) return;
    if (failed) await showMessage(failed);
  }
}

type QueueLockScope = Pick<QueueScope, "userId" | "deviceId" | "conversationId" | "editTargetId">;

function outgoingLockName(row: QueueLockScope): string {
  return row.editTargetId ? `e2ee-outgoing-edit:${row.userId}:${row.deviceId}:${row.editTargetId}`
    : `e2ee-outgoing:${row.userId}:${row.deviceId}:${row.conversationId}`;
}

async function withOutgoingLock(row: QueueLockScope, action: () => Promise<void>): Promise<void> {
  if (navigator.locks) await navigator.locks.request(outgoingLockName(row), action);
  else await action();
}

/** Single flight in this tab, plus a cross-tab lock where Web Locks are available. */
export function retryOutgoing(id: string, scheduledEdit?: { row: OutgoingEditStatus; online: boolean }): Promise<void> {
  const ownerId = useAuthStore.getState().user?.id;
  if (!ownerId) return Promise.resolve();
  const existing = inFlight.get(id);
  if (existing) return existing;
  let editId = scheduledEdit?.row.id;
  const task = (async () => {
    const row = scheduledEdit?.row ?? await getOutgoingEditStatus(id, ownerId) ?? await getOutgoingOperation(id, ownerId);
    if (!row || !belongsToSession(row)) return;
    if (row.editTargetId) editId = row.id;
    await withOutgoingLock(row, () => attempt(id, ownerId, scheduledEdit));
  })().finally(async () => { inFlight.delete(id); await refreshOutgoingQueue(editId); });
  inFlight.set(id, task);
  return task;
}
export async function discardOutgoing(id: string, conversationId?: string): Promise<"already-sending" | undefined> {
  const session = captureMessageActionSession();
  const active = () => isMessageActionSessionCurrent(session);
  const result = await discardAndHideMessages(conversationId, [id]);
  if (!active()) return;
  if (result.alreadySending.length) return "already-sending";
  if (conversationId || result.discarded) return;
  if (!session.userId) return;
  const row = await getOutgoingOperation(id, session.userId);
  if (!row?.editTargetId || !active() || !belongsToSession(row)) return;
  const outcome = await finishQueuedEdit(row, active);
  if (outcome === "already-sending") return outcome;
  if (outcome) {
    await publishCachedEdit(row.editTargetId, row.conversationId, active);
    await drain();
  }
}

export async function discardAndHideMessages(conversationId: string | undefined, ids: string[], expectedQueued?: ReadonlySet<string>) {
  return discardLocally(conversationId, [...new Set(ids)], expectedQueued);
}

export function discardConversationHistory(conversationId: string, visibleIds: ReadonlySet<string>, direct: boolean) {
  return discardLocally(conversationId, { history: visibleIds, direct });
}

async function discardLocally(conversationId: string | undefined, target: LocalHideTarget, expectedQueued?: ReadonlySet<string>) {
  const session = captureMessageActionSession();
  const current = () => isMessageActionSessionCurrent(session);
  const { hidden, ...result } = await deleteMessagesForLocalUserOnly(conversationId, target, current, expectedQueued);
  if (result.discarded && current()) {
    for (const id of hidden) if (preparingFiles.has(id)) cancelledPreparations.add(id);
    void drain().catch(console.error);
  }
  return result;
}
async function drainEdits(online: boolean) {
  const ownerId = useAuthStore.getState().user?.id;
  if (!ownerId) return;
  const edits = await getOutgoingEditStatuses(ownerId);
  await Promise.all(edits.filter((row) => belongsToSession(row) && !inFlight.has(row.id)).map(async (row) => {
    if (row.retryable && (online || (row.nextAttemptAt ?? 0) <= Date.now())) await retryOutgoing(row.id, { row, online });
    else await withOutgoingLock(row, async () => { if (!inFlight.has(row.id)) await retireOrphan(row); });
  }));
  const remaining = await getOutgoingEditStatuses(ownerId);
  updateQueueSnapshot([...queueSnapshot.filter((row) => !row.editTargetId), ...remaining.map((row) => ({ ...row, steps: [] }))]);
}
async function drainMessages(online: boolean) {
  const ownerId = useAuthStore.getState().user?.id;
  if (!ownerId) return;
  const rows = await getAllOutgoingMessages(ownerId);
  const groups = new Map<string, LocalOutgoing[]>();
  for (const row of rows.sort(compareRows)) {
    const key = outgoingLockName(row);
    const pending = groups.get(key) ?? [];
    pending.push(row);
    groups.set(key, pending);
  }
  await Promise.all([...groups].map(async ([key, pending]) => {
    const active = drainingMessages.get(key);
    if (active) {
      active.online ||= online;
      const seen = new Set(active.pending.map((row) => row.id));
      for (const row of pending) if (!seen.has(row.id)) active.pending.push(row);
      return;
    }
    const drain = { online, pending };
    // Claim the conversation before waiting for another tab to release its lock.
    drainingMessages.set(key, drain);
    try {
      for (const snapshot of drain.pending) {
        if (belongsToSession(snapshot) && !inFlight.has(snapshot.id)) {
          await withOutgoingLock(snapshot, async () => {
            const row = await getOutgoingOperation(snapshot.id, snapshot.userId);
            if (!row || !belongsToSession(row) || inFlight.has(row.id) || preparingFiles.has(row.id)) return;
            if (await retireOrphan(row)) return;
            if (row.status === "sending" && !row.retryable) {
              row.status = "failed";
              row.error ??= "messageNotSent";
              const message = await getMessageById(row.id, row.userId);
              if (message?.type === "file" && !row.fileId && !row.upload && row.steps.length === 0) row.error = INTERRUPTED_FILE_ERROR;
              const failed = message ? { ...message, status: "failed" } : undefined;
              // The lock does not cover another tab's initial file encryption. Compare
              // the revision and write both records in one transaction after the await.
              if (await updateOutgoingIfPresent(row, failed, { ifUnchanged: true }) && failed) await showMessage(failed);
            }
          });
        }
        const row = await getOutgoingOperation(snapshot.id, snapshot.userId);
        if (row && belongsToSession(row) && row.retryable && (drain.online || row.nextAttemptAt === null || row.nextAttemptAt <= Date.now())) await retryOutgoing(row.id);
      }
    } finally {
      drainingMessages.delete(key);
      scheduleRetries();
    }
  }));
  await refreshOutgoingQueue();
}
async function drain(online = false, editsOnly = false) {
  await Promise.all([drainEdits(online), editsOnly ? undefined : drainMessages(online)]);
}
const onOnline = () => { void drain(true).catch(console.error); };
function onOutgoingMessageReady(outgoing: LocalOutgoing) {
  if (!belongsToSession(outgoing)) return;
  const active = drainingMessages.get(outgoingLockName(outgoing));
  // The write already committed. Give the running conversation its new work
  // directly so it does not depend on a refresh after other locks resolve.
  if (active) active.pending.push(outgoing);
  else void drainMessages(false).catch(console.error);
}
export function startOutgoingQueue() {
  if (++consumers === 1) {
    window.addEventListener("online", onOnline);
    unsubscribeOutgoingMessageReady = subscribeOutgoingMessageReady(onOutgoingMessageReady);
    void drain().catch(console.error);
  }
  return () => {
    if (--consumers === 0) {
      window.removeEventListener("online", onOnline);
      unsubscribeOutgoingMessageReady?.();
      unsubscribeOutgoingMessageReady = undefined;
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
  };
}
