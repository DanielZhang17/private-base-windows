import type { CallEventPayload } from "./types/calls.js";
export declare enum WSFrameType {
    Message = "message",
    MessageEvent = "message_event",
    Typing = "typing",
    Presence = "presence",
    DeliveryReceipt = "delivery_receipt",
    Signal = "signal",
    Call = "call",
    Conversation = "conversation",
    Profile = "profile",
    Ack = "ack",
    Error = "error"
}
export interface WSMessageFrame {
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
export interface MessageEventPayload {
    conversationId: string;
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
export type WSFrame = WSMessageFrame | WSMessageEventFrame | WSTypingFrame | WSPresenceFrame | WSDeliveryReceiptFrame | WSSignalFrame | WSCallFrame | WSConversationFrame | WSProfileFrame | WSAckFrame | WSErrorFrame;
//# sourceMappingURL=protocol.d.ts.map