import type {
  ConversationWithMembers,
  MessageType,
  SendDirectBatchRequest,
  SendDirectBatchResponse,
} from "@e2ee-chat/shared";
import { api } from "../services/api.js";
import { useAuthStore } from "../stores/authStore.js";
import { encryptMessage } from "./message-processor.js";

interface DirectTargetDevice {
  userId: string;
  deviceId: string;
}

interface PreparedDirectMessage extends DirectTargetDevice {
  id: string;
  ciphertext: string;
  iv: string;
  header: string;
}

export async function resolveDirectTargetDevices(
  conversation: ConversationWithMembers,
): Promise<DirectTargetDevice[]> {
  const user = useAuthStore.getState().user;
  const device = useAuthStore.getState().device;
  if (!user || !device) {
    throw new Error("Session identity is still loading");
  }
  const userIds = [...new Set(conversation.members.map((member) => member.userId))];

  const deviceLists = await Promise.all(
    userIds.map(async (memberUserId) => {
      const devices = await api.get<{ id: string; userId: string }[]>(`/api/devices/user/${memberUserId}`);
      return devices.map((entry) => ({ userId: memberUserId, deviceId: entry.id }));
    }),
  );

  const targets = deviceLists
    .flat()
    .filter((target) => !(target.userId === user.id && target.deviceId === device.id));

  if (targets.length === 0) {
    throw new Error("No recipient devices available");
  }

  return targets.sort((left, right) => {
    const leftIsSelf = left.userId === user.id ? 1 : 0;
    const rightIsSelf = right.userId === user.id ? 1 : 0;
    if (leftIsSelf !== rightIsSelf) {
      return leftIsSelf - rightIsSelf;
    }
    return left.deviceId.localeCompare(right.deviceId) || left.userId.localeCompare(right.userId);
  });
}

function fanoutMessageId(localMessageId: string, target: DirectTargetDevice, index: number): string {
  if (index === 0) return localMessageId;
  return `${localMessageId}:${target.deviceId}`;
}

export async function prepareDirectPayloadFanout(
  conversation: ConversationWithMembers,
  localMessageId: string,
  plaintext: string,
  msgType: MessageType,
  options?: {
    ttlSeconds?: number | null;
    fileId?: string | null;
  },
): Promise<SendDirectBatchRequest> {
  const user = useAuthStore.getState().user;
  if (!user) {
    throw new Error("Session identity is still loading");
  }
  const targets = await resolveDirectTargetDevices(conversation);
  const prepared = await Promise.allSettled(
    targets.map(async (target, index) => {
      const encrypted = await encryptMessage("direct", plaintext, target.userId, target.deviceId);
      const preparedMessage: PreparedDirectMessage = {
        ...target,
        id: fanoutMessageId(localMessageId, target, index),
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        header: encrypted.header,
      };
      return preparedMessage;
    }),
  );

  const failedTargets = prepared
    .map((result, index) => ({ result, target: targets[index] }))
    .filter((entry): entry is {
      result: PromiseRejectedResult;
      target: DirectTargetDevice;
    } => entry.result.status === "rejected")
    .map(({ result, target }) => ({
      userId: target.userId,
      deviceId: target.deviceId,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    }));

  if (failedTargets.length > 0) {
    console.warn("Direct fanout encryption failed", failedTargets);
    throw new AggregateError(
      prepared.flatMap((result) => result.status === "rejected" ? [result.reason] : []),
      `Failed to encrypt for ${failedTargets.length} device(s)`,
    );
  }

  const messages = prepared
    .filter((result): result is PromiseFulfilledResult<PreparedDirectMessage> => result.status === "fulfilled")
    .map((result) => result.value);

  const recipientDeviceSends = messages.filter((target) => target.userId !== user.id).length;
  if (recipientDeviceSends === 0) {
    throw new Error("Failed to deliver to recipient devices");
  }

  const request: SendDirectBatchRequest = {
    conversationId: conversation.id,
    type: msgType,
    ttlSeconds: options?.ttlSeconds ?? null,
    fileId: options?.fileId ?? null,
    messages: messages.map(({ id, ciphertext, iv, header }) => ({
      id,
      ciphertext,
      iv,
      header,
    })),
  };

  return request;
}


export async function sendDirectPayloadFanout(
  ...args: Parameters<typeof prepareDirectPayloadFanout>
): Promise<SendDirectBatchResponse> {
  const request = await prepareDirectPayloadFanout(...args);
  return api.post<SendDirectBatchResponse>("/api/messages/send-direct-batch", request);
}
