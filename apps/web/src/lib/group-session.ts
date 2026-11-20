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
  senderKeyAdvanceOnly,
  senderKeyEncrypt,
  toBase64Url,
  fromBase64Url,
  type SenderKeyEncryptResult,
  type SenderKeyState,
  type EditKeyToSeal,
} from "@e2ee-chat/crypto";
import type {
  ConversationWithMembers,
  Device,
  SenderKeyHeader,
  SendDirectBatchResponse,
} from "@e2ee-chat/shared";
import { api } from "../services/api.js";
import { type OutgoingStep, getAppDB, getSenderKey, getSession, saveSenderKey, hasReceivedMessage, type LocalSenderKey } from "../db/index.js";
import { useAuthStore } from "../stores/authStore.js";
import { encryptMessage } from "./message-processor.js";
import { matchEditSigningIdentity } from "./message-edit.js";
import { checkReceiveGap, decryptPayload, finishReceive, withReceiveLock, MissingSenderKeyError, InvalidSenderKeyDistributionError, type ReceiveContext } from "./receive.js";

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
  joinAdmissionId?: string;
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
  joinAdmissionId?: string,
): string {
  const id = `${conversationId}:${senderDeviceId}:${senderKeyId}:${recipientDeviceId}`;
  return joinAdmissionId ? `admission:${joinAdmissionId}:${id}` : id;
}

async function getOwnSenderKeyRecord(conversationId: string) {
  return getSenderKey(ownSenderKeyId(conversationId));
}

async function persistOwnSenderKey(conversationId: string, state: SenderKeyState, groupEpoch: number): Promise<void> {
  await saveSenderKey({
    id: ownSenderKeyId(conversationId),
    groupEpoch,
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
  const members = new Map(conversation.members.map(member => [member.userId, member.joinAdmissionId]));
  const deviceLists = await Promise.all(
    [...members].map(async ([memberUserId, joinAdmissionId]) => {
      const devices = await api.get<Device[]>(`/api/devices/user/${memberUserId}`);
      return devices.map((device) => ({ userId: memberUserId, deviceId: device.id, joinAdmissionId }));
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
  joinAdmissionId?: string,
): Promise<boolean> {
  const db = await getAppDB();
  const existing = await db.get("receiveSenderKeyRecipients", senderKeyRecipientId(
    conversationId,
    senderDeviceId,
    senderKeyId,
    recipientDeviceId,
    joinAdmissionId,
  ));
  return !!existing;
}

async function markRecipientEntriesDistributed(
  conversationId: string,
  { senderDeviceId, senderKeyId, recipientDeviceIds, joinAdmissionIds }: NonNullable<OutgoingStep["distributed"]>,
): Promise<void> {
  const db = await getAppDB();
  const now = Date.now();
  await Promise.all(recipientDeviceIds.map((recipientDeviceId) =>
    db.put("receiveSenderKeyRecipients", {
      id: senderKeyRecipientId(conversationId, senderDeviceId, senderKeyId, recipientDeviceId,
        joinAdmissionIds && Object.hasOwn(joinAdmissionIds, recipientDeviceId) ? joinAdmissionIds[recipientDeviceId] : undefined),
      conversationId,
      senderDeviceId,
      senderKeyId,
      recipientDeviceId,
      distributedAt: now,
    } satisfies RecipientRegistryEntry)
  ));
}

async function getOrCreateSenderKey(conversationId: string, groupEpoch: number): Promise<SenderKeyState> {
  const stored = await getOwnSenderKeyRecord(conversationId);
  const storedEpoch = stored?.groupEpoch ?? 0;
  if (stored && storedEpoch > groupEpoch) throw new Error("Group membership metadata is stale");
  if (stored && storedEpoch === groupEpoch) {
    return {
      senderKeyId: stored.senderKeyId,
      chainKey: fromBase64Url(stored.chainKey),
      signingPublicKey: fromBase64Url(stored.signingPublicKey),
      signingPrivateKey: fromBase64Url(stored.signingPrivateKey),
      chainIndex: stored.chainIndex,
    };
  }

  const state = await generateSenderKey();
  await persistOwnSenderKey(conversationId, state, groupEpoch);
  return state;
}

export async function prepareSenderKeyDistribution(conversation: ConversationWithMembers): Promise<OutgoingStep | null> {
  const authState = useAuthStore.getState();
  const senderDeviceId = authState.device?.id;
  if (!senderDeviceId) throw new Error("Current device is unavailable");

  const state = await getOrCreateSenderKey(conversation.id, conversation.groupEpoch ?? 0);
  const targets = await resolveGroupTargetDevices(conversation);
  const missingTargets: TargetDevice[] = [];

  for (const target of targets) {
    const alreadyDistributed = await hasRecipientEntry(
      conversation.id,
      senderDeviceId,
      state.senderKeyId,
      target.deviceId,
      target.joinAdmissionId,
    );
    if (!alreadyDistributed) {
      missingTargets.push(target);
    }
  }

  if (missingTargets.length === 0) return null;

  const payload = {
    conversationId: conversation.id,
    distribution: createDistribution(state),
  };

  const prepared = await Promise.allSettled(
    missingTargets.map(async (target) => {
      const encrypted = await encryptMessage("direct", JSON.stringify({ ...payload, joinAdmissionId: target.joinAdmissionId }),
        target.userId, target.deviceId, undefined, target.joinAdmissionId ?? null);
      return {
        id: crypto.randomUUID(),
        recipientDeviceId: target.deviceId,
        joinAdmissionId: target.joinAdmissionId,
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
  const admissionIds = messages.flatMap(message => message.joinAdmissionId
    ? [[message.recipientDeviceId, message.joinAdmissionId]] : []);

  return {
    path: "/api/messages/send-direct-batch",
    body: {
      conversationId: conversation.id,
      groupEpoch: conversation.groupEpoch,
      type: "sender_key_distribution",
      groupAdmissionVersion: conversation.groupAdmissionVersion,
      messages: messages.map(({ id, ciphertext, iv, header }) => ({ id, ciphertext, iv, header })),
    },
    distributed: {
      senderDeviceId, senderKeyId: state.senderKeyId, recipientDeviceIds: messages.map(message => message.recipientDeviceId),
      ...(admissionIds.length && { joinAdmissionIds: Object.fromEntries(admissionIds) }),
    },
  };
}

export async function finishSenderKeyDistribution(conversationId: string, step: OutgoingStep): Promise<void> {
  if (!step.distributed) return;
  await markRecipientEntriesDistributed(conversationId, step.distributed);
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
  joinAdmissionId?: unknown,
): Promise<LocalSenderKey> {
  const distribution = JSON.parse(distributionJson);
  if (!distribution || typeof distribution !== "object"
    || !Number.isInteger(distribution.senderKeyId) || distribution.senderKeyId < 0 || distribution.senderKeyId > 0xffffffff
    || !Number.isSafeInteger(distribution.chainIndex) || distribution.chainIndex < 0
    || typeof distribution.chainKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(distribution.chainKey)
    || typeof distribution.signingPublicKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(distribution.signingPublicKey)
    || (joinAdmissionId !== undefined && (typeof joinAdmissionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(joinAdmissionId)))) {
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
    ...(typeof joinAdmissionId === "string" && { joinAdmissionId }),
  };
}

export async function encryptGroupMessage(
  conversationId: string,
  plaintext: Uint8Array,
  editKey?: EditKeyToSeal,
  groupEpoch = 0,
): Promise<SenderKeyEncryptResult> {
  const state = await getOrCreateSenderKey(conversationId, groupEpoch);
  const result = await senderKeyEncrypt(state, plaintext, editKey);
  await persistOwnSenderKey(conversationId, state, groupEpoch);
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
    if (await hasReceivedMessage(receive.messageId, receive.ownerId, receive.deviceId)) return null;
    if (!await getSenderKey(key)) throw new MissingSenderKeyError(key);
    await receive.beforeGroupDecrypt?.(header);
    // Draining may advance this chain; reload its committed state before decrypting.
    const stored = await getSenderKey(key);
    if (!stored) throw new MissingSenderKeyError(key);
    if (header.chainIndex > stored.chainIndex) {
      await checkReceiveGap(receive, { chain: header.senderKeyId, from: stored.chainIndex, until: header.chainIndex });
    }
    const peer = receive.editKey ? await getSession(`${senderId}:${senderDeviceId}`) : undefined;
    const editKey = matchEditSigningIdentity(receive.editKey, peer?.peerIdentityKey);
    const decrypted = await decryptPayload(async () => {
      const state: SenderKeyState = {
        senderKeyId: stored.senderKeyId,
        chainKey: fromBase64Url(stored.chainKey),
        signingPublicKey: fromBase64Url(stored.signingPublicKey),
        signingPrivateKey: new Uint8Array(0),
        chainIndex: stored.chainIndex,
      };
      if (receive.advanceOnly) {
        await senderKeyAdvanceOnly(state, header, ciphertext, iv);
        return { state };
      }
      const plaintext = await senderKeyDecrypt(state, header, ciphertext, iv, editKey);
      return { state, plaintext };
    });
    const committed = await finishReceive(receive, decrypted.plaintext, {
      senderKey: {
        ...stored, chainKey: toBase64Url(decrypted.state.chainKey), chainIndex: decrypted.state.chainIndex,
      },
    });
    return committed ? decrypted.plaintext ?? null : null;
  });
}
