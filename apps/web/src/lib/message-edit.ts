import { concat, fromBase64Url, toBase64Url, type EditKeyToOpen, type EditKeyToSeal } from "@e2ee-chat/crypto";
import type { LocalMessage } from "../db/index.js";
import type { MessageEditScope } from "@e2ee-chat/shared";

export function messageEditScope(message: Pick<LocalMessage, "id" | "conversationId" | "senderId">, senderDeviceId: string): MessageEditScope {
  return { conversationId: message.conversationId, messageId: message.id.split(":")[0], senderId: message.senderId, senderDeviceId };
}

export function editKeyToSeal(message: LocalMessage): EditKeyToSeal | undefined {
  if (message.type !== "text" || !message.editKey || !message.editSigningKey || !message.editSenderDeviceId) return;
  return {
    scope: messageEditScope(message, message.editSenderDeviceId),
    bytes: concat(fromBase64Url(message.editKey), fromBase64Url(message.editSigningKey)),
  };
}

export function matchEditSigningIdentity(editKey?: EditKeyToOpen, knownIdentity?: string): EditKeyToOpen | undefined {
  if (!editKey || !knownIdentity) return editKey;
  return {
    ...editKey,
    accept: (bytes) => {
      if (toBase64Url(bytes.subarray(32)) === knownIdentity) editKey.accept(bytes);
    },
  };
}
