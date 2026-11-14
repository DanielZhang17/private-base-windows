import { INTERRUPTED_FILE_ERROR, outgoingErrorKey } from "./outgoing-errors.js";
import type {
  ConversationWithMembers,
  DecryptedMessage,
  SendMessageResponse,
} from "@e2ee-chat/shared";
import { api } from "../../services/api.js";
import {
  discardQueuedMessage,
  getAllOutgoing,
  getMessageById,
  getOutgoing,
  retireUnsendableOutgoing,
  updateOutgoingIfPresent,
  updateOutgoingErrorIfUnchanged,
  completeOutgoingIfPresent,
  type LocalOutgoing,
  type LocalMessage,
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
export function setFilePreparing(id: string, preparing: boolean) {
  if (preparing) preparingFiles.add(id); else preparingFiles.delete(id);
}
let preparation: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let consumers = 0;
function compareRows(left: LocalOutgoing, right: LocalOutgoing) { return left.queuedAt - right.queuedAt || left.id.localeCompare(right.id); }
function sameConversation(left: LocalOutgoing, right: LocalOutgoing) {
  return left.userId === right.userId && left.deviceId === right.deviceId && left.conversationId === right.conversationId;
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
    && !queueSnapshot.slice(0, index).some((earlier) => sameConversation(earlier, row)));
  if (due.length) timer = setTimeout(() => { void drain().catch(console.error); }, Math.max(0, Math.min(...due.map((row) => row.nextAttemptAt ?? 0)) - Date.now()));
}

function showMessage(message: LocalMessage) {
  useChatStore.getState().addMessage(message.conversationId, message as DecryptedMessage);
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
  await persistOutgoing(row);
}

/**
 * The display record of a file keeps an empty file id until the send is accepted: the server only
 * serves a file once a message attaches it, so publishing the id earlier mounts a preview that fails.
 */
function contentToSend(row: LocalOutgoing, message: LocalMessage) {
  return message.type === "file" && row.fileId ? JSON.stringify({ ...JSON.parse(message.content), fileId: row.fileId }) : message.content;
}

async function prepare(row: LocalOutgoing, message: LocalMessage | undefined, current: () => boolean) {
  if (!current()) return;
  if (row.upload && !row.upload.uploaded) {
    for (let renewal = 0; ; renewal++) {
      if (!row.upload.uploadUrl) {
        const upload = await api.post<{ fileId: string; uploadUrl: string }>("/api/files/upload-url", {
          conversationId: row.conversationId, mimeType: row.upload.mimeType, sizeBytes: row.upload.bytes.length,
        });
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
      row.steps = [{ path: "/api/messages/send-direct-batch", body }];
    } else {
      const distribution = row.steps.length ? null : await prepareSenderKeyDistribution(conversation);
      if (!current()) return;
      // Persist a prepared distribution even if encrypting the following message fails.
      if (distribution) {
        row.steps = [distribution];
        await persistOutgoing(row);
      }
      const encrypted = await encryptGroupText(row.conversationId, contentToSend(row, message));
      if (!current()) return;
      row.steps.push({ path: "/api/messages/send", body: { id: row.id, conversationId: row.conversationId, type: message.type as DecryptedMessage["type"], ...encrypted, ttlSeconds: row.ttlSeconds, fileId: row.fileId } });
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
  // Sender Keys do not retain skipped receive keys. A later message must never overtake
  // an earlier failed send (or an unfinished sender-key distribution).
  const rows = await getAllOutgoing();
  for (const earlier of rows.filter((entry) => sameConversation(entry, initial) && compareRows(entry, initial) < 0)) {
    // An active attempt can still hold display content while preparing its envelope.
    if (inFlight.has(earlier.id)) return;
    if (!await retireOrphan(earlier) && await getOutgoing(earlier.id)) return;
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
    row.nextAttemptAt = null;
    await persistOutgoing(row);
    if (message) showMessage({ ...message, status: "sending" });
    await refreshOutgoingQueue();
    await prepare(row, message, current);
    if (!current()) return;
    let result: SendMessageResponse | null = null;
    for (let renewal = 0; ; renewal++) {
      try {
        for (const step of row.steps) {
          if (step.completed) continue;
          if (!current()) return;
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
    const sent = message ? { ...message, content: contentToSend(row, message), timestamp: result.serverTimestamp, expiresAt: result.expiresAt, expiryKind: result.expiryKind, status: "sent" } : undefined;
    if (!await completeOutgoingIfPresent(row, sent, { ifUnchanged: true })) return;
    if (sent) showMessage(sent);
    touchConversationInCache(row.conversationId, result.serverTimestamp);
  } catch (error) {
    if (!current() || error instanceof DiscardedSend) return;
    const retryable = isRetryableSendError(error);
    // Preparation can fail on a network lookup before the first POST too.
    row.attempts = Math.max(1, row.attempts);
    row.status = "failed";
    row.retryable = retryable;
    row.error = outgoingErrorKey(error);
    row.nextAttemptAt = retryable ? Date.now() + RETRY_DELAYS[Math.min(row.attempts - 1, RETRY_DELAYS.length - 1)] : null;
    const failed = message ? { ...message, status: "failed" } : undefined;
    if (!await updateOutgoingIfPresent(row, failed, { ifUnchanged: true })) return;
    if (!retryable && await retireOrphan(row)) return;
    if (failed) showMessage(failed);
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
  // An already submitted request cannot be unsent; only discard after its attempt settles.
  await inFlight.get(id);
  const row = await getOutgoing(id);
  if (!row) return;
  await withConversationLock(row, async () => {
    const current = await getOutgoing(id);
    if (!current || !belongsToSession(current)) return;
    await discardQueuedMessage(id);
    useChatStore.getState().removeMessages([id]);
  });
  await refreshOutgoingQueue();
}
async function drain(online = false) {
  const rows = await getAllOutgoing();
  await Promise.all(rows.map(async (snapshot) => {
    if (belongsToSession(snapshot) && !inFlight.has(snapshot.id)) {
      await withConversationLock(snapshot, async () => {
        const row = await getOutgoing(snapshot.id);
        if (!row || !belongsToSession(row) || inFlight.has(row.id) || preparingFiles.has(row.id)) return;
        if (await retireOrphan(row)) return;
        if (row.status === "sending" && !row.retryable && row.error) {
          row.status = "failed";
          const message = await getMessageById(row.id);
          if (message?.type === "file" && !row.fileId && !row.upload && row.steps.length === 0) row.error = INTERRUPTED_FILE_ERROR;
          const failed = message ? { ...message, status: "failed" } : undefined;
          // The lock does not cover another tab's initial file encryption. Compare
          // the revision and write both records in one transaction after the await.
          if (await updateOutgoingIfPresent(row, failed, { ifUnchanged: true }) && failed) showMessage(failed);
        }
      });
    }
    const row = await getOutgoing(snapshot.id);
    if (row && belongsToSession(row) && row.retryable && (online || row.nextAttemptAt === null || row.nextAttemptAt <= Date.now())) await retryOutgoing(row.id);
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
