export type CallType = "audio" | "video";
export type CallStatus = "ringing" | "active" | "declined" | "missed" | "ended";

export interface Call {
  id: string;
  conversationId: string;
  initiatorId: string;
  type: CallType;
  status: CallStatus;
  createdAt: number;
  answeredAt: number | null;
  endedAt: number | null;
}

export interface CallEventPayload {
  event: "incoming" | "accepted" | "declined" | "ended" | "missed";
  callId: string;
  conversationId: string;
  callType: CallType;
  status: CallStatus;
  fromUserId: string;
  initiatorId: string;
}

export type SystemCallPayload =
  | {
      kind: "call_offer";
      callId: string;
      conversationId: string;
      callType: CallType;
      callKey: string;
      createdAt: number;
      expiresAt: number;
      initiatorId: string;
    };
