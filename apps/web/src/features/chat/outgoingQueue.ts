import { captureMessageActionSession, isMessageActionSessionCurrent } from "./message-action-session.js";
import { INTERRUPTED_FILE_ERROR, outgoingErrorKey } from "./outgoing-errors.js";
import type {
  ConversationWithMembers,
  DecryptedMessage,
  SendMessageResponse,
} from "@e2ee-chat/shared";
import { api } from "../../services/api.js";
import { uploadMimeType } from "./uploadMimeType.js";
import {
  discardQueuedMessage,
  getAllOutgoing,
  getMessageById,
  guardMessageForPublish,
  getOutgoing,
  retireUnsendableOutgoing,
  updateOutgoingIfPresent,
  updateOutgoingErrorIfUnchanged,
  completeOutgoingIfPresent,
  removeLocalMessageContent,
  rememberMessageDeletion,
  type LocalOutgoing,
  type LocalMessage,
  type OutgoingStep,
} from "../../db/index.js";
import { prepareDirectPayloadFanout } from "../../lib/direct-messages.js";
import { encryptGroupText } from "../../lib/message-processor.js";
import { finishSenderKeyDistribution, prepareSenderKeyDistribution } from "../../lib/group-session.js";
import { touchConversationInCache } from "../../lib/conversation-cache.js";
import { keysLoaded } from "../../lib/key-manager.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";

export const RETRY_DELAYS = [2000, 5000, 15000, 60000];
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();
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
function compareRows(left: LocalOutgoing, right: LocalOutgoing) { return left.queuedAt - right.queuedAt || left.id.localeCompare(right.id); }
function sameConversation(left: LocalOutgoing, right: LocalOutgoing) {
  return left.userId === right.userId && left.deviceId === right.deviceId && left.conversationId === right.conversationId;
}
function isMessageStep(step: OutgoingStep) {
  return step.body.type !== "sender_key_distribution";
}
function stepMayHaveBeenDispatched(row: LocalOutgoing, step: OutgoingStep) {
  // Legacy prepared envelopes lack per-step markers; preserve them conservatively.
  return !!step.completed || (step.sendDispatched ?? row.sendDispatched ?? true);
}
function messageMayHaveBeenDispatched(row: LocalOutgoing) {
  return row.steps.some((step) => isMessageStep(step) && stepMayHaveBeenDispatched(row, step));
}
function blocksLaterMessages(row: LocalOutgoing) {
  return row.status === "sending" || row.retryable
    || (row.conversationType === "group" && messageMayHaveBeenDispatched(row));
}
let queueSnapshot: LocalOutgoing[] = [];
export const getQueueSnapshot = () => queueSnapshot;
export function subscribeQueue(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

function belongsToSession(row: LocalOutgoing) {
  const auth = useAuthStore.getState();
  return !!auth.accessToken && keysLoaded() && auth.user?.id === row.userId && auth.device?.id === row.deviceId;
}
export async function refreshOutgoingQueue() {
  const rows = await getAllOutgoing();
  // Repair older text records without loading the language in which they were created.
  for (const row of rows) {
    if (!belongsToSession(row) || !row.error || preparingFiles.has(row.id)) continue;
    let key = outgoingErrorKey(row.error);
    if (!row.fileId && !row.upload && row.steps.length === 0 && (await getMessageById(row.id))?.type === "file") key = INTERRUPTED_FILE_ERROR;
    if (key !== row.error) {
      await updateOutgoingErrorIfUnchanged(row.id, row.error, key);
      row.error = key;
    }
  }
  queueSnapshot = rows.filter(belongsToSession).sort(compareRows);
  listeners.forEach((listener) => listener());
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!consumers) return;
  const due = queueSnapshot.filter((row, index) => row.retryable && !inFlight.has(row.id)
    && !queueSnapshot.slice(0, index).some((earlier) => sameConversation(earlier, row) && blocksLaterMessages(earlier)));
  if (due.length) timer = setTimeout(() => { void drain().catch(console.error); }, Math.max(0, Math.min(...due.map((row) => row.nextAttemptAt ?? 0)) - Date.now()));
}

async function showMessage(message: LocalMessage) {
  // Display durable output: another device/tab may have deleted it during this send.
  const session = useAuthStore.getState();
  const record = await getMessageById(message.id);
  const persisted = record ? await guardMessageForPublish(record) : null;
  const current = useAuthStore.getState();
  if (session.user?.id !== current.user?.id || session.device?.id !== current.device?.id || session.sessionId !== current.sessionId) return;
  if (persisted) useChatStore.getState().addMessage(persisted.conversationId, persisted as DecryptedMessage);
  else useChatStore.getState().removeMessages([message.id]);
}

async function retireOrphan(row: LocalOutgoing) {
  if (!belongsToSession(row) || preparingFiles.has(row.id)) return false;
  const retired = await retireUnsendableOutgoing(row.id);
  if (!retired) return false;
  if (belongsToSession(retired)) {
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

class DiscardedSend extends Error {}
async function persistOutgoing(row: LocalOutgoing, message?: LocalMessage) {
  if (!await updateOutgoingIfPresent(row, message, { ifUnchanged: true })) throw new DiscardedSend();
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
  await persistOutgoing(row);
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
  if (row.steps.some((step) => step.path === "/api/messages/send" || step.body.type !== "sender_key_distribution")) return;
  // Legacy v5 retention can delete the display row while leaving the outbox.
  // Prepared envelopes remain sendable; plaintext needed for new encryption does not.
  if (!message) throw new Error("messageNotSent");
  const conversation = await api.get<ConversationWithMembers>(`/api/conversations/${row.conversationId}`);
  if (!current()) return;
  // Upload and metadata requests must not hold the shared crypto-state serialization.
  const previous = preparation;
  const task = previous.catch(() => undefined).then(async () => {
    if (!current()) return;
    if (row.conversationType === "direct") {
      const body = await prepareDirectPayloadFanout(conversation, row.id, contentToSend(row, message), message.type as DecryptedMessage["type"], { ttlSeconds: row.ttlSeconds, fileId: row.fileId });
      if (!current()) return;
      row.steps = [{ path: "/api/messages/send-direct-batch", body, sendDispatched: false }];
    } else {
      const distribution = row.steps.length ? null : await prepareSenderKeyDistribution(conversation);
      if (!current()) return;
      // Persist a prepared distribution even if encrypting the following message fails.
      if (distribution) {
        row.steps = [{ ...distribution, sendDispatched: false }];
        await persistOutgoing(row);
      }
      const encrypted = await encryptGroupText(row.conversationId, contentToSend(row, message));
      if (!current()) return;
      row.steps.push({ path: "/api/messages/send", body: { id: row.id, conversationId: row.conversationId, type: message.type as DecryptedMessage["type"], ...encrypted, ttlSeconds: row.ttlSeconds, fileId: row.fileId }, sendDispatched: false });
    }
    await persistOutgoing(row);
  });
  preparation = task;
  await task;
}

async function attempt(id: string) {
  const initial = await getOutgoing(id);
  if (!initial || !belongsToSession(initial)) return;
  if (await retireOrphan(initial)) return;
  const rows = await getAllOutgoing();
  if (initial.status === "failed" && !initial.retryable) {
    // Unresolved group ciphertext keeps its position so newer chain indices cannot
    // overtake it. Direct and definitely unsent group retries join the queue tail.
    if (!blocksLaterMessages(initial)) initial.queuedAt = Math.max(Date.now(), ...rows.map((row) => row.queuedAt + 1));
    if (!messageMayHaveBeenDispatched(initial)) {
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
    const message = await getMessageById(id);
    const sending = message ? { ...message, status: "sending" } : undefined;
    if (!await updateOutgoingIfPresent(initial, sending, { ifUnchanged: true })) return;
    if (sending && belongsToSession(initial)) await showMessage(sending);
  }
  // Pending/auto-retrying envelopes must stay ordered, including sender-key distributions.
  for (const earlier of rows.filter((entry) => entry.id !== id && sameConversation(entry, initial) && compareRows(entry, initial) < 0)) {
    const pending = await getOutgoing(earlier.id);
    if (!pending || compareRows(pending, initial) >= 0) continue;
    if (!blocksLaterMessages(pending)) { await retireOrphan(pending); continue; }
    // An active attempt can still hold display content while preparing its envelope.
    if (inFlight.has(pending.id)) return;
    if (!await retireOrphan(pending) && await getOutgoing(pending.id)) return;
  }
  // Retirement and ordering checks await IndexedDB; another tab may have progressed meanwhile.
  const row = await getOutgoing(id);
  if (!row || !belongsToSession(row)) return;
  const sessionId = useAuthStore.getState().sessionId;
  const current = () => belongsToSession(row!) && useAuthStore.getState().sessionId === sessionId;
  const message = await getMessageById(id);
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
    const sending = message ? { ...message, status: "sending" } : undefined;
    if (!await updateOutgoingIfPresent(row, sending, { ifUnchanged: true })) return;
    if (sending) await showMessage(sending);
    await refreshOutgoingQueue();
    await prepare(row, message, current);
    if (!current()) return;
    let result: SendMessageResponse | null = null;
    for (let renewal = 0; ; renewal++) {
      try {
        for (const step of row.steps) {
          if (step.completed) continue;
          if (!current()) return;
          if (!step.sendDispatched) {
            step.sendDispatched = true;
            if (isMessageStep(step)) row.sendDispatched = true;
            await persistOutgoing(row);
            if (!current()) return;
          }
          result = await api.post<SendMessageResponse>(step.path, step.body);
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
        if (renewal > 0 || !row.upload || message?.type !== "file" || !expiredReservation(error, true)) throw error;
        await renewUpload(row);
        await prepare(row, message, current);
      }
    }
    if (!result || !current()) return;
    const sent = message ? { ...message, content: result.deleted ? "" : contentToSend(row, message), timestamp: result.serverTimestamp, expiresAt: result.expiresAt, expiryKind: result.expiryKind, status: "sent",
      ...(result.deleted ? { deletedAt: result.deletedAt ?? Date.now(), deletedByUserId: result.deletedByUserId ?? row.userId } : {}) } : undefined;
    if (result.deleted) {
      if (sent) await removeLocalMessageContent(row.id, sent);
      else await rememberMessageDeletion(row.id, row.conversationId, result.deletedAt ?? Date.now(), result.deletedByUserId ?? row.userId);
    }
    if (!await completeOutgoingIfPresent(row, sent, { ifUnchanged: true })) return;
    if (sent) await showMessage(sent);
    touchConversationInCache(row.conversationId, result.serverTimestamp);
  } catch (error) {
    if (!current() || error instanceof DiscardedSend) return;
    const retryable = isRetryableSendError(error);
    // Preparation can fail on a network lookup before the first POST too.
    row.attempts = Math.max(1, row.attempts);
    row.status = "failed";
    row.retryable = retryable;
    row.error = !retryable && row.upload && !row.upload.uploaded ? "fileCouldNotBeUploaded" : outgoingErrorKey(error);
    row.nextAttemptAt = retryable ? Date.now() + RETRY_DELAYS[Math.min(row.attempts - 1, RETRY_DELAYS.length - 1)] : null;
    const failed = message ? { ...message, status: "failed" } : undefined;
    if (!await updateOutgoingIfPresent(row, failed, { ifUnchanged: true })) return;
    if (!retryable && await retireOrphan(row)) return;
    if (failed) await showMessage(failed);
  }
}

async function withConversationLock(row: LocalOutgoing, action: () => Promise<void>): Promise<void> {
  if (navigator.locks) await navigator.locks.request(`e2ee-outgoing:${row.userId}:${row.deviceId}:${row.conversationId}`, action);
  else await action();
}

/** Single flight in this tab, plus a cross-tab lock where Web Locks are available. */
export function retryOutgoing(id: string): Promise<void> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const task = (async () => {
    const row = await getOutgoing(id);
    if (!row) return;
    await withConversationLock(row, () => attempt(id));
  })().finally(async () => { inFlight.delete(id); await refreshOutgoingQueue(); });
  inFlight.set(id, task);
  return task;
}
export async function discardOutgoing(id: string) {
  const session = captureMessageActionSession();
  const active = () => isMessageActionSessionCurrent(session);
  // Preparation is outside the network attempt; cancel its continuations immediately.
  if (preparingFiles.has(id)) cancelledPreparations.add(id);
  // An already submitted request cannot be unsent; only discard after its attempt settles.
  await inFlight.get(id);
  if (!active()) return;
  const row = await getOutgoing(id);
  if (!row || !active()) return;
  await withConversationLock(row, async () => {
    const current = await getOutgoing(id);
    if (!active() || !current || !belongsToSession(current)) return;
    await discardQueuedMessage(id, active);
    if (active()) useChatStore.getState().removeMessages([id]);
  });
  await drain();
}
async function drain(online = false) {
  const rows = await getAllOutgoing();
  const conversations = new Map<string, LocalOutgoing[]>();
  for (const row of rows.sort(compareRows)) {
    const key = JSON.stringify([row.userId, row.deviceId, row.conversationId]);
    const pending = conversations.get(key) ?? [];
    pending.push(row);
    conversations.set(key, pending);
  }
  await Promise.all([...conversations.values()].map(async (pending) => {
    for (const snapshot of pending) {
      if (belongsToSession(snapshot) && !inFlight.has(snapshot.id)) {
        await withConversationLock(snapshot, async () => {
          const row = await getOutgoing(snapshot.id);
          if (!row || !belongsToSession(row) || inFlight.has(row.id) || preparingFiles.has(row.id)) return;
          if (await retireOrphan(row)) return;
          if (row.status === "sending" && !row.retryable) {
            row.status = "failed";
            row.error ??= "messageNotSent";
            const message = await getMessageById(row.id);
            if (message?.type === "file" && !row.fileId && !row.upload && row.steps.length === 0) row.error = INTERRUPTED_FILE_ERROR;
            const failed = message ? { ...message, status: "failed" } : undefined;
            // The lock does not cover another tab's initial file encryption. Compare
            // the revision and write both records in one transaction after the await.
            if (await updateOutgoingIfPresent(row, failed, { ifUnchanged: true }) && failed) await showMessage(failed);
          }
        });
      }
      const row = await getOutgoing(snapshot.id);
      if (row && belongsToSession(row) && row.retryable && (online || row.nextAttemptAt === null || row.nextAttemptAt <= Date.now())) await retryOutgoing(row.id);
    }
  }));
  await refreshOutgoingQueue();
}
const onOnline = () => { void drain(true).catch(console.error); };
export function startOutgoingQueue() {
  if (++consumers === 1) {
    window.addEventListener("online", onOnline);
    void drain().catch(console.error);
  }
  return () => {
    if (--consumers === 0) {
      window.removeEventListener("online", onOnline);
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
  };
}
