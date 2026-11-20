export type ConversationType = "direct" | "group";
export type MemberRole = "admin" | "member";
export type InvitePolicy = "any_member" | "admins_only";
export type GroupMemberUpdate = { role: MemberRole } | { timeoutSeconds: 600 | 3600 | null };

export interface Conversation {
  id: string;
  type: ConversationType;
  name: string | null;
  avatarUrl: string | null;
  invitePolicy: InvitePolicy;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Group sender-key generation, incremented by member removal. */
  groupEpoch?: number;
  /** Server Unix milliseconds sampled with group metadata. */
  serverTime?: number;
}

export interface ConversationMember {
  conversationId: string;
  userId: string;
  /** Opaque identifier for the current name-based admission. */
  joinAdmissionId?: string;
  role: MemberRole;
  joinedAt: number;
  acceptedAt: number | null;
  /** Unix milliseconds. Older servers may omit this field. */
  timedOutUntil?: number | null;
}

export interface ConversationWithMembers extends Conversation {
  groupAdmissionVersion?: number;
  members: (ConversationMember & { user: { username: string; displayName: string; avatarUrl: string | null } })[];
  joinByName?: boolean;
  pendingJoinRequestCount?: number;
}

export interface GroupJoinRequest {
  id: string;
  username: string;
  displayName: string;
}
