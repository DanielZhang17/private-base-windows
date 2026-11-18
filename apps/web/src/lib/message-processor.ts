/**
 * High-level encrypt/decrypt interface for the chat UI.
 * Dispatches to Double Ratchet (1:1) or Sender Keys (group) based on conversation type.
 */
import { fromBase64Url, toBase64Url, type EditKeyToSeal, type SealedEditKey } from "@e2ee-chat/crypto";
import type {
  ConversationType,
  InitialMessageHeader,
} from "@e2ee-chat/shared";
import { decryptFromDevice, decryptInitialMessage, encryptForDevice } from "./session-manager.js";
import { decryptGroupMessage, encryptGroupMessage, prepareRemoteSenderKey } from "./group-session.js";
import { keysLoaded, KeysLockedError } from "./key-manager.js";
import { parseDirectHeader, parseGroupHeader } from "./receive-validation.js";
import { useAuthStore } from "../stores/authStore.js";
import { decryptPayload, InvalidSenderKeyDistributionError, type ReceiveContext } from "./receive.js";

export interface OutgoingEncrypted {
  ciphertext: string;
  iv: string;
  header: string;
}

export interface IncomingMessage {
  id: string;
  senderId: string;
  senderDeviceId: string;
  type: string;
  ciphertext: string;
  iv: string;
  header: string;
}

/**
 * Encrypt a direct-message plaintext for a single remote device.
 */
export async function encryptMessage(
  conversationType: ConversationType,
  plaintext: string,
  recipientUserId: string | null,
  recipientDeviceId: string | null,
  editKey?: EditKeyToSeal,
): Promise<OutgoingEncrypted> {
  if (conversationType !== "direct") {
    throw new Error("encryptMessage supports direct conversations only");
  }
  if (!recipientUserId || !recipientDeviceId) {
    throw new Error("Recipient user and device are required for direct messages");
  }

  const plaintextBytes = new TextEncoder().encode(plaintext);
  const { result, isInitial, initialHeader } = await encryptForDevice(
    recipientUserId,
    recipientDeviceId,
    plaintextBytes,
    editKey,
  );

  const header: {
    dhPublicKey: string;
    n: number;
    pn: number;
    recipientDeviceId: string;
    initial?: InitialMessageHeader;
    editKey?: SealedEditKey;
  } = {
    dhPublicKey: result.header.dhPublicKey,
    n: result.header.n,
    pn: result.header.pn,
    recipientDeviceId,
  };

  if (isInitial && initialHeader) {
    header.initial = initialHeader;
  }
  if (result.sealedEditKey) header.editKey = result.sealedEditKey;

  return {
    ciphertext: toBase64Url(result.ciphertext),
    iv: toBase64Url(result.iv),
    header: JSON.stringify(header),
  };
}

/**
 * Decrypt an incoming direct-message payload.
 */
export async function decryptMessage(
  conversationType: ConversationType,
  msg: IncomingMessage,
  receive: ReceiveContext,
): Promise<string | null> {
  if (conversationType !== "direct") {
    throw new Error("decryptMessage supports direct conversations only");
  }

  const authState = useAuthStore.getState();
  const localUserId = authState.user?.id;
  const localDeviceId = authState.device?.id;

  // Never decrypt frames originated by this exact device.
  // They are local echoes and can corrupt ratchet send/recv chain state.
  if (localUserId && localDeviceId && msg.senderId === localUserId && msg.senderDeviceId === localDeviceId) {
    return null;
  }

  const { ciphertext, iv, header } = await decryptPayload(async () => ({
    ciphertext: fromBase64Url(msg.ciphertext),
    iv: fromBase64Url(msg.iv),
    header: parseDirectHeader(msg.header),
  }));

  // In multi-device scenarios the same ciphertext can be delivered to other devices.
  // Skip decryption unless this payload targets the current device.
  if (header.recipientDeviceId && localDeviceId && header.recipientDeviceId !== localDeviceId) {
    return null;
  }

  if (!keysLoaded()) throw new KeysLockedError();
  const ratchetHeader = { dhPublicKey: header.dhPublicKey, n: header.n, pn: header.pn };
  const plaintext = header.initial
    ? await decryptInitialMessage(
      msg.senderId,
      msg.senderDeviceId,
      header.initial,
      ratchetHeader,
      ciphertext,
      iv,
      receive,
    )
    : await decryptFromDevice(
      msg.senderId,
      msg.senderDeviceId,
      ratchetHeader,
      ciphertext,
      iv,
      receive,
    );

  return plaintext === null ? null : new TextDecoder().decode(plaintext);
}

/**
 * Encrypt a group message with the conversation ID properly threaded through.
 */
export async function encryptGroupText(
  conversationId: string,
  plaintext: string,
  editKey?: EditKeyToSeal,
): Promise<OutgoingEncrypted> {
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const result = await encryptGroupMessage(conversationId, plaintextBytes, editKey);
  return {
    ciphertext: toBase64Url(result.ciphertext),
    iv: toBase64Url(result.iv),
    header: JSON.stringify({ ...result.header, editKey: result.sealedEditKey }),
  };
}

/**
 * Decrypt a group message with the conversation ID properly threaded through.
 */
export async function decryptGroupText(
  conversationId: string,
  msg: IncomingMessage,
  receive: ReceiveContext,
): Promise<string | null> {
  if (msg.type === "sender_key_distribution") {
    await decryptMessage("direct", msg, {
      ...receive,
      prepare: async (plaintext) => {
        const effects = await receive.prepare(plaintext);
        const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
        if (!payload || payload.conversationId !== conversationId || !payload.distribution) {
          throw new InvalidSenderKeyDistributionError("Distribution conversation mismatch");
        }
        return {
          ...effects,
          senderKey: await prepareRemoteSenderKey(
            payload.conversationId, msg.senderId, msg.senderDeviceId, JSON.stringify(payload.distribution),
          ),
        };
      },
    });
    return null;
  }
  const { header, ciphertext, iv } = await decryptPayload(async () => ({
    header: parseGroupHeader(msg.header),
    ciphertext: fromBase64Url(msg.ciphertext), iv: fromBase64Url(msg.iv),
  }));
  if (!keysLoaded()) throw new KeysLockedError();
  const plaintext = await decryptGroupMessage(
    conversationId, msg.senderId, msg.senderDeviceId, header,
    ciphertext, iv, receive,
  );
  return plaintext === null ? null : new TextDecoder().decode(plaintext);
}
