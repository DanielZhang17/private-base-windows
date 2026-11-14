export type ConversationType = "direct" | "group";
export type MemberRole = "admin" | "member";
export interface Conversation {
    id: string;
    type: ConversationType;
    name: string | null;
    avatarUrl: string | null;
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
    members: (ConversationMember & {
        user: {
            username: string;
            displayName: string;
            avatarUrl: string | null;
        };
    })[];
}
//# sourceMappingURL=conversations.d.ts.map