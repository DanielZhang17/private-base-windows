/**
 * Manages Sender Key sessions for group messaging.
 * - Generates and persists the local device's sender key per conversation
 * - Tracks which recipient devices already received that sender key
 * - Distributes sender keys to missing devices via targeted per-device messages
 * - Decrypts incoming group messages using the sender device's stored sender key
 */
import {
  createDistribution,
  fromDistribution,
  generateSenderKey,
  senderKeyDecrypt,
  senderKeyEncrypt,
  toBase64Url,
  fromBase64Url,
  type SenderKeyEncryptResult,
  type SenderKeyState,
} from "@e2ee-chat/crypto";
import type {
  ConversationWithMembers,
  Device,
  SenderKeyHeader,
  SendDirectBatchResponse,
} from "@e2ee-chat/shared";
import { api } from "../services/api.js";
import { type OutgoingStep, getAppDB, getSenderKey, saveSenderKey, hasReceivedMessage, type LocalSenderKey } from "../db/index.js";
import { useAuthStore } from "../stores/authStore.js";
import { encryptMessage } from "./message-processor.js";
import { decryptPayload, finishReceive, withReceiveLock, MissingSenderKeyError, InvalidSenderKeyDistributionError, type ReceiveContext } from "./receive.js";

interface RecipientRegistryEntry {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  senderKeyId: number;
  recipientDeviceId: string;
  distributedAt: number;
}

interface TargetDevice {
  userId: string;
  deviceId: string;
}

function ownSenderKeyId(conversationId: string): string {
  return `own:${conversationId}`;
}

function remoteSenderKeyId(conversationId: string, senderId: string, senderDeviceId: string, senderKeyId: number): string {
  return `${conversationId}:${senderId}:${senderDeviceId}:${senderKeyId}`;
}

function senderKeyRecipientId(
  conversationId: string,
  senderDeviceId: string,
  senderKeyId: number,
  recipientDeviceId: string,
): string {
  return `${conversationId}:${senderDeviceId}:${senderKeyId}:${recipientDeviceId}`;
}

async function getOwnSenderKeyRecord(conversationId: string) {
  return getSenderKey(ownSenderKeyId(conversationId));
}

async function persistOwnSenderKey(conversationId: string, state: SenderKeyState): Promise<void> {
  await saveSenderKey({
    id: ownSenderKeyId(conversationId),
    senderKeyId: state.senderKeyId,
    chainKey: toBase64Url(state.chainKey),
    signingPublicKey: toBase64Url(state.signingPublicKey),
    signingPrivateKey: toBase64Url(state.signingPrivateKey),
    chainIndex: state.chainIndex,
  });
}

async function resolveGroupTargetDevices(conversation: ConversationWithMembers): Promise<TargetDevice[]> {
  const authState = useAuthStore.getState();
  const localUserId = authState.user?.id;
  const localDeviceId = authState.device?.id;
  const userIds = [...new Set(conversation.members.map((member) => member.userId))];
  const deviceLists = await Promise.all(
    userIds.map(async (memberUserId) => {
      const devices = await api.get<Device[]>(`/api/devices/user/${memberUserId}`);
      return devices.map((device) => ({ userId: memberUserId, deviceId: device.id }));
    }),
  );

  return deviceLists
    .flat()
    .filter((target) => !(target.userId === localUserId && target.deviceId === localDeviceId))
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId) || left.userId.localeCompare(right.userId));
}

async function hasRecipientEntry(
  conversationId: string,
  senderDeviceId: string,
  senderKeyId: number,
  recipientDeviceId: string,
): Promise<boolean> {
  const db = await getAppDB();
  const existing = await db.get("senderKeyRecipients", senderKeyRecipientId(
    conversationId,
    senderDeviceId,
    senderKeyId,
    recipientDeviceId,
  ));
  return !!existing;
}

async function markRecipientEntriesDistributed(
  conversationId: string,
  senderDeviceId: string,
  senderKeyId: number,
  recipientDeviceIds: string[],
): Promise<void> {
  const db = await getAppDB();
  const now = Date.now();
  await Promise.all(recipientDeviceIds.map((recipientDeviceId) =>
    db.put("senderKeyRecipients", {
      id: senderKeyRecipientId(conversationId, senderDeviceId, senderKeyId, recipientDeviceId),
      conversationId,
      senderDeviceId,
      senderKeyId,
      recipientDeviceId,
      distributedAt: now,
    } satisfies RecipientRegistryEntry)
  ));
}

async function getOrCreateSenderKey(conversationId: string): Promise<SenderKeyState> {
  const stored = await getOwnSenderKeyRecord(conversationId);
  if (stored) {
    return {
      senderKeyId: stored.senderKeyId,
      chainKey: fromBase64Url(stored.chainKey),
      signingPublicKey: fromBase64Url(stored.signingPublicKey),
      signingPrivateKey: fromBase64Url(stored.signingPrivateKey),
      chainIndex: stored.chainIndex,
    };
  }

  const state = await generateSenderKey();
  await persistOwnSenderKey(conversationId, state);
  return state;
}

export async function prepareSenderKeyDistribution(conversation: ConversationWithMembers): Promise<OutgoingStep | null> {
  const authState = useAuthStore.getState();
  const senderDeviceId = authState.device?.id;
  if (!senderDeviceId) throw new Error("Current device is unavailable");

  const state = await getOrCreateSenderKey(conversation.id);
  const targets = await resolveGroupTargetDevices(conversation);
  const missingTargets: TargetDevice[] = [];

  for (const target of targets) {
    const alreadyDistributed = await hasRecipientEntry(
      conversation.id,
      senderDeviceId,
      state.senderKeyId,
      target.deviceId,
    );
    if (!alreadyDistributed) {
      missingTargets.push(target);
    }
  }

  if (missingTargets.length === 0) return null;

  const payload = JSON.stringify({
    conversationId: conversation.id,
    distribution: createDistribution(state),
  });

  const prepared = await Promise.allSettled(
    missingTargets.map(async (target) => {
      const encrypted = await encryptMessage("direct", payload, target.userId, target.deviceId);
      return {
        id: crypto.randomUUID(),
        recipientDeviceId: target.deviceId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        header: encrypted.header,
      };
    }),
  );

  const failures = prepared.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures.map((result) => result.reason), `Failed to distribute sender key to ${failures.length} device(s)`);
  }

  const messages = prepared.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);

  return {
    path: "/api/messages/send-direct-batch",
    body: {
      conversationId: conversation.id,
      type: "sender_key_distribution",
      messages: messages.map(({ id, ciphertext, iv, header }) => ({ id, ciphertext, iv, header })),
    },
    distributed: { senderDeviceId, senderKeyId: state.senderKeyId, recipientDeviceIds: messages.map((message) => message.recipientDeviceId) },
  };
}

export async function finishSenderKeyDistribution(conversationId: string, step: OutgoingStep): Promise<void> {
  if (!step.distributed) return;
  await markRecipientEntriesDistributed(conversationId, step.distributed.senderDeviceId, step.distributed.senderKeyId, step.distributed.recipientDeviceIds);
}

export async function ensureSenderKeyDistributed(conversation: ConversationWithMembers): Promise<void> {
  const step = await prepareSenderKeyDistribution(conversation);
  if (!step) return;
  await api.post<SendDirectBatchResponse>(step.path, step.body);
  await finishSenderKeyDistribution(conversation.id, step);
}

export async function prepareRemoteSenderKey(
  conversationId: string,
  senderId: string,
  senderDeviceId: string,
  distributionJson: string,
): Promise<LocalSenderKey> {
  const distribution = JSON.parse(distributionJson);
  if (!distribution || typeof distribution !== "object"
    || !Number.isInteger(distribution.senderKeyId) || distribution.senderKeyId < 0 || distribution.senderKeyId > 0xffffffff
    || !Number.isSafeInteger(distribution.chainIndex) || distribution.chainIndex < 0
    || typeof distribution.chainKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(distribution.chainKey)
    || typeof distribution.signingPublicKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(distribution.signingPublicKey)) {
    throw new InvalidSenderKeyDistributionError("Malformed sender key distribution");
  }
  const state = fromDistribution(distribution);
  if (toBase64Url(state.chainKey) !== distribution.chainKey || toBase64Url(state.signingPublicKey) !== distribution.signingPublicKey) {
    throw new InvalidSenderKeyDistributionError("Non-canonical sender key distribution");
  }
  return {
    id: remoteSenderKeyId(conversationId, senderId, senderDeviceId, distribution.senderKeyId),
    senderKeyId: state.senderKeyId,
    chainKey: toBase64Url(state.chainKey),
    signingPublicKey: toBase64Url(state.signingPublicKey),
    signingPrivateKey: "",
    chainIndex: state.chainIndex,
  };
}

export async function encryptGroupMessage(
  conversationId: string,
  plaintext: Uint8Array,
): Promise<SenderKeyEncryptResult> {
  const state = await getOrCreateSenderKey(conversationId);
  const result = await senderKeyEncrypt(state, plaintext);
  await persistOwnSenderKey(conversationId, state);
  return result;
}

export async function decryptGroupMessage(
  conversationId: string,
  senderId: string,
  senderDeviceId: string,
  header: SenderKeyHeader,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  receive: ReceiveContext,
): Promise<Uint8Array | null> {
  const key = remoteSenderKeyId(conversationId, senderId, senderDeviceId, header.senderKeyId);
  return withReceiveLock(receive, `${senderId}:${senderDeviceId}`, async () => {
    if (await hasReceivedMessage(receive.messageId)) return null;
    if (!await getSenderKey(key)) throw new MissingSenderKeyError(key);
    await receive.beforeGroupDecrypt?.(header);
    // Draining may advance this chain; reload its committed state before decrypting.
    const stored = await getSenderKey(key);
    if (!stored) throw new MissingSenderKeyError(key);
    const decrypted = await decryptPayload(async () => {
      const state: SenderKeyState = {
        senderKeyId: stored.senderKeyId,
        chainKey: fromBase64Url(stored.chainKey),
        signingPublicKey: fromBase64Url(stored.signingPublicKey),
        signingPrivateKey: new Uint8Array(0),
        chainIndex: stored.chainIndex,
      };
      const plaintext = await senderKeyDecrypt(state, header, ciphertext, iv);
      return { state, plaintext };
    });
    return finishReceive(receive, decrypted.plaintext, {
      senderKey: {
        ...stored, chainKey: toBase64Url(decrypted.state.chainKey), chainIndex: decrypted.state.chainIndex,
      },
    });
  });
}
