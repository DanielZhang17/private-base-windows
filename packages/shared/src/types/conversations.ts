export type ConversationType = "direct" | "group";
export type MemberRole = "admin" | "member";
export type InvitePolicy = "any_member" | "admins_only";

export interface Conversation {
  id: string;
  type: ConversationType;
  name: string | null;
  avatarUrl: string | null;
  invitePolicy: InvitePolicy;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMember {
  conversationId: string;
  userId: string;
  role: MemberRole;
  joinedAt: number;
  acceptedAt: number | null;
}

export interface ConversationWithMembers extends Conversation {
  members: (ConversationMember & { user: { username: string; displayName: string; avatarUrl: string | null } })[];
}
