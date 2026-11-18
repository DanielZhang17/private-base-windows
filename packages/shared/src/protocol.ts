import type { DeviceAlert } from "./types/users.js";
import type { CallEventPayload } from "./types/calls.js";

export enum WSFrameType {
  Message = "message",
  MessageEvent = "message_event",
  Typing = "typing",
  Presence = "presence",
  DeliveryReceipt = "delivery_receipt",
  Signal = "signal",
  Call = "call",
  Conversation = "conversation",
  DeviceAlert = "device.alert",
  DeviceAlertAcknowledged = "device.alert.acknowledged",
  DeviceRevoked = "device.revoked",
  Profile = "profile",
  Ack = "ack",
  Error = "error",
}

export interface WSMessageFrame {
  latestEditSeq?: number | null;
  editKeyAccepted?: boolean;
  deletedAt?: number | null;
  deletedByUserId?: string | null;
  /** Mutation cursor; timestamp/serverTimestamp remain the original send time. */
  syncTimestamp?: number;
  type: WSFrameType.Message;
  id: string;
  conversationId: string;
  ciphertext: string;
  iv: string;
  header: string;
  msgType: string;
  timestamp: number;
  serverTimestamp?: number;
  expiresAt: number | null;
  expiryKind: "timed" | "retention";
  senderId: string;
  senderDeviceId: string;
  /** Server routing target on a live frame. Targeting the sender confirms acceptance. */
  recipientDeviceId?: string;
}

export interface WSTypingFrame {
  type: WSFrameType.Typing;
  userId: string;
  isTyping: boolean;
}

export interface WSPresenceFrame {
  type: WSFrameType.Presence;
  userId: string;
  status: "online" | "offline";
}

export interface MessageDeletionEvent { ids: string[]; deletedAt: number; deletedByUserId: string }

export interface MessageEventPayload {
  deletion?: MessageDeletionEvent;
  deletionSync?: true;
  replayedDeletions?: { senderId: string; deletions: MessageDeletionEvent[] };
  conversationType?: "direct" | "group";
  edit?: MessageEditFrame;
  editAvailable?: boolean;
  conversationId: string;
}

export interface MessageEditFrame {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  editSeq: number;
  expiresAt: number;
  editedAt: number;
  mutationSeq: number;
}

export interface WSMessageEventFrame {
  type: WSFrameType.MessageEvent;
  payload: MessageEventPayload;
}

export interface WSDeliveryReceiptFrame {
  type: WSFrameType.DeliveryReceipt;
  messageId: string;
  status: "delivered" | "read";
}

export interface WSSignalFrame {
  type: WSFrameType.Signal;
  payload: {
    kind: "offer" | "answer" | "ice-candidate";
    sdp?: string;
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    fromUserId: string;
  };
}

export interface WSCallFrame {
  type: WSFrameType.Call;
  payload: CallEventPayload;
}

export interface ConversationEventPayload {
  conversationId: string;
}

export interface WSConversationFrame {
  type: WSFrameType.Conversation;
  payload: ConversationEventPayload;
}

export interface ProfileEventPayload {
  userId: string;
}

export interface WSProfileFrame {
  type: WSFrameType.Profile;
  payload: ProfileEventPayload;
}

export interface WSAckFrame {
  type: WSFrameType.Ack;
  messageId: string;
  serverTimestamp: number;
}

export interface WSErrorFrame {
  type: WSFrameType.Error;
  code: string;
  message: string;
}

export interface WSDeviceAlertFrame {
  type: WSFrameType.DeviceAlert;
  payload: DeviceAlert;
}

export interface WSDeviceAlertAcknowledgedFrame {
  type: WSFrameType.DeviceAlertAcknowledged;
  alertId: string;
}

export interface WSDeviceRevokedFrame {
  type: WSFrameType.DeviceRevoked;
  deviceId: string;
  replacementDeviceName?: string;
}

export type WSFrame =
  | WSDeviceRevokedFrame
  | WSDeviceAlertFrame
  | WSDeviceAlertAcknowledgedFrame
  | WSMessageFrame
  | WSMessageEventFrame
  | WSTypingFrame
  | WSPresenceFrame
  | WSDeliveryReceiptFrame
  | WSSignalFrame
  | WSCallFrame
  | WSConversationFrame
  | WSProfileFrame
  | WSAckFrame
  | WSErrorFrame;
