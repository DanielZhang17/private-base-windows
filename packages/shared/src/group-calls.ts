import { z } from "zod";
import type { CallType } from "./types/calls.js";

export const GROUP_CALL_CAPABILITY = "group-call-v1";
export const GROUP_SIGNAL_VERSION = 2;
export const GROUP_CALL_ALONE_MS = 180_000;
export const GROUP_CALL_RECONNECT_MS = 45_000;
export const groupCallCapacity = (type: CallType) => type === "video" ? 8 : 12;

export const groupCallIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const groupCallRingSchema = z.array(groupCallIdSchema).max(11).refine((ids) => new Set(ids).size === ids.length);
export const groupCallStartSchema = z.object({
  type: z.enum(["audio", "video"]),
  ringUserIds: groupCallRingSchema,
  sessionId: groupCallIdSchema,
}).strict();

export const groupCallPeerSchema = z.object({
  userId: groupCallIdSchema,
  deviceId: groupCallIdSchema,
  sessionId: groupCallIdSchema,
}).strict();
export type GroupCallPeer = z.infer<typeof groupCallPeerSchema>;

export const groupSignalBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), sdp: z.string().min(1).max(47_000), offerId: groupCallIdSchema }).strict(),
  z.object({ kind: z.literal("answer"), sdp: z.string().min(1).max(47_000), offerId: groupCallIdSchema }).strict(),
  z.object({ kind: z.literal("ice"), candidate: z.string().min(1).max(3500), offerId: groupCallIdSchema }).strict(),
  z.object({ kind: z.literal("restart"), reset: z.literal(true).optional() }).strict(),
  z.object({ kind: z.literal("media"), ciphertext: z.string().regex(/^[A-Za-z0-9_-]{22,512}$/), iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/) }).strict(),
]);
export type GroupSignalBody = z.infer<typeof groupSignalBodySchema>;
export const groupRoutedSignalSchema = z.object({
  type: z.literal("group-signal"),
  version: z.literal(GROUP_SIGNAL_VERSION),
  callId: groupCallIdSchema,
  epoch: z.number().int().positive().safe(),
  from: groupCallPeerSchema,
  to: groupCallPeerSchema,
  body: groupSignalBodySchema,
}).strict();
export type GroupRoutedSignal = z.infer<typeof groupRoutedSignalSchema>;

export type GroupCallEndReason = "empty" | "alone" | "ended_for_everyone" | "group_deleted";
export type GroupCallExitReason = GroupCallEndReason | "left" | "lost_connection" | "removed" | "timed_out" | "moved";
export type GroupRingState = "ringing" | "declined" | "no_answer" | "left";
export interface GroupCallParticipant extends GroupCallPeer {
  joinedAt: number;
  reconnecting?: boolean;
}
export interface GroupCallRoom {
  id: string;
  conversationId: string;
  type: CallType;
  initiatorId: string;
  startedAt: number;
  epoch: number;
  participants: GroupCallParticipant[];
  aloneUntil: number | null;
  endedAt: number | null;
  endedBy?: string;
  endReason?: GroupCallEndReason;
}
export interface GroupCallMember {
  userId: string;
  role: "admin" | "member";
  capable: boolean;
  timedOutUntil: number | null;
  ringState?: GroupRingState;
  ringUntil?: number;
}
export interface GroupCallTimelineEvent {
  callId: string;
  initiatorId: string;
  type: CallType;
  startedAt: number;
  endedAt: number | null;
  missed: boolean;
}
export interface GroupCallStatusResponse {
  enabled: boolean;
  serverTime: number;
  room: GroupCallRoom | null;
  lastEnded?: GroupCallRoom;
  members: GroupCallMember[];
  timeline: GroupCallTimelineEvent[];
}
export interface GroupCallInvitation {
  callId: string;
  conversationId: string;
  initiatorId: string;
  callType: CallType;
  ringUntil: number;
  ringFrom: GroupCallPeer;
}
export interface GroupCallNotice {
  conversationId: string;
  callId: string;
  kind: "ring" | "quiet" | "changed" | "keys";
}

export type GroupSignalServerFrame =
  | { type: "group-roster"; version: 2; room: GroupCallRoom; departed?: { userId: string; reason: GroupCallExitReason }[] }
  | { type: "group-resume-ack"; version: 2; epoch: number; cursor: number }
  | { type: "group-heartbeat-ack"; version: 2; epoch: number }
  | { type: "group-exit"; version: 2; reason: GroupCallExitReason; room: GroupCallRoom }
  | (GroupRoutedSignal & { sequence: number });

export const groupCallErrorCodes = [
  "call_disabled", "call_capability_required", "call_not_member", "call_timed_out",
  "call_needs_members", "call_full", "call_unavailable", "call_forbidden",
  "call_invalid_ring", "call_already_in_progress", "call_network", "call_invitation_pending",
] as const;
export type GroupCallErrorCode = typeof groupCallErrorCodes[number];

export const groupCallMetricSchema = z.object({
  event: z.enum(["start", "join", "leave", "reconnect", "peer_lost", "key_wait"]),
  size: z.enum(["1", "2-4", "5-8", "9-12"]),
  media: z.enum(["audio", "video"]),
  platform: z.enum(["web", "ios", "android", "macos", "windows"]),
}).strict();
export type GroupCallMetric = z.infer<typeof groupCallMetricSchema>;

export const groupCallEnvelopeId = /^gck_[A-Za-z0-9_-]{43}(?::[A-Za-z0-9_-]{1,128})?$/;
export const groupInvitationEnvelopeId = /^gci_[A-Za-z0-9_-]{43}$/;

export const groupCallInvitationProofSchema = z.object({
  kind: z.literal("group_call_invitation"),
  callId: groupCallIdSchema,
  conversationId: groupCallIdSchema,
  initiatorId: groupCallIdSchema,
  callType: z.enum(["audio", "video"]),
  ringUntil: z.number().int().positive().safe(),
  from: groupCallPeerSchema,
  to: z.object({ userId: groupCallIdSchema, deviceId: groupCallIdSchema }).strict(),
}).strict();
export type GroupCallInvitationProof = z.infer<typeof groupCallInvitationProofSchema>;
export type GroupCallInviteTarget = GroupCallInvitationProof["to"] & { ringUntil: number };

export const groupCallKeySchema = z.object({
  kind: z.literal("group_call_key"),
  callId: groupCallIdSchema,
  conversationId: groupCallIdSchema,
  epoch: z.number().int().positive().safe(),
  from: groupCallPeerSchema,
  to: groupCallPeerSchema,
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type GroupCallKey = z.infer<typeof groupCallKeySchema>;

export function sameGroupCallPeer(a: GroupCallPeer, b: GroupCallPeer): boolean {
  return a.userId === b.userId && a.deviceId === b.deviceId && a.sessionId === b.sessionId;
}
