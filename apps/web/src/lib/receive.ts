import type { SenderKeyHeader } from "@e2ee-chat/shared";
import type { EditKeyToOpen } from "@e2ee-chat/crypto";
import { commitReceivedMessage, type LocalSession, type ReceiveEffects, type LocalSenderKey } from "../db/index.js";

export interface ReceiveState {
  session?: LocalSession;
  senderKey?: LocalSenderKey;
  oneTimePreKeyId?: number;
}

export interface ReceiveGap {
  chain: string | number;
  from: number;
  until: number;
}

export interface ReceiveContext {
  messageId: string;
  ownerId?: string;
  deviceId?: string;
  /** Ingestion owns this peer lock through classification and commit. */
  lockedSession?: string;
  waitForEarlier?: boolean;
  beforeSkip?: (gaps: ReceiveGap[]) => Promise<void>;
  advanceOnly?: () => ReceiveEffects;
  stage?: (state: ReceiveState) => void;
  beforeGroupDecrypt?: (header: SenderKeyHeader) => Promise<void>;
  editKey?: EditKeyToOpen;
  prepare: (plaintext: Uint8Array) => Promise<ReceiveEffects>;
}

/** Crypto/decoding failures contain no retryable storage or key-loading work. */
export class ReceiveDecryptionError extends Error {
  constructor(cause: unknown) { super("Could not decrypt message", { cause }); }
}

export class MissingSenderKeyError extends Error {
  constructor(readonly keyId: string) { super("Sender key distribution has not arrived"); }
}

export class ReceivePredecessorError extends Error {
  constructor() { super("Could not decrypt message before earlier envelopes arrive"); }
}

export async function checkReceiveGap(receive: ReceiveContext, ...gaps: ReceiveGap[]): Promise<void> {
  if (receive.waitForEarlier) throw new ReceivePredecessorError();
  await receive.beforeSkip?.(gaps);
}

export class InvalidSenderKeyDistributionError extends Error {}

export class ConversationMetadataError extends Error {
  constructor(cause: unknown) { super("Conversation metadata unavailable", { cause }); }
}

/** The sole receive classification policy. Unrecognised errors are terminal. */
export function classifyReceiveError(error: unknown): "defer" | "retry" | "terminal" {
  // Crypto/decoding failures are terminal; key/IDB reads happen outside that wrapper.
  if (error instanceof ReceiveDecryptionError) return "terminal";
  if (error instanceof MissingSenderKeyError) return "defer";
  if (error instanceof ConversationMetadataError) {
    const cause = error.cause as { status?: number } | undefined;
    if ([0, 401, 408, 429].includes(cause?.status ?? -1) || (cause?.status !== undefined && cause.status >= 500 && cause.status <= 599)
      || (cause?.status === undefined && error.cause instanceof TypeError)) return "retry";
    error = error.cause;
  }
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  return ["KeysLockedError", "AbortError", "QuotaExceededError", "TransactionInactiveError", "InvalidStateError", "UnknownError"].includes(name)
    ? "retry" : "terminal";
}

export async function withReceiveLock<T>(receive: ReceiveContext, key: string, operation: () => Promise<T>): Promise<T> {
  return receive.lockedSession === key ? operation() : withSessionLock(key, operation);
}

export async function decryptPayload<T>(decrypt: () => Promise<T>): Promise<T> {
  try { return await decrypt(); } catch (error) { throw new ReceiveDecryptionError(error); }
}

export async function finishReceive(
  receive: ReceiveContext,
  plaintext: Uint8Array | undefined,
  state: ReceiveState,
): Promise<boolean> {
  if (receive.advanceOnly ? plaintext !== undefined : plaintext === undefined) {
    throw new Error("Receive result does not match the envelope mode");
  }
  receive.stage?.(state);
  const effects = receive.advanceOnly ? receive.advanceOnly() : await receive.prepare(plaintext!);
  return commitReceivedMessage(receive.messageId, { ...effects, ownerId: effects.ownerId ?? receive.ownerId, deviceId: receive.deviceId }, state);
}

const sessionLocks = new Map<string, Promise<unknown>>();

/** Hold the lock through crypto, output preparation, and the durable atomic commit. */
export async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(async () =>
    typeof navigator !== "undefined" && navigator.locks
      ? await navigator.locks.request(`e2ee-session:${key}`, fn)
      : fn(),
  );
  sessionLocks.set(key, next);
  try { return await next; } finally {
    if (sessionLocks.get(key) === next) sessionLocks.delete(key);
  }
}
