import type { ConversationWithMembers } from "@e2ee-chat/shared";

type ObservedConversation = ConversationWithMembers & { groupClockObservedAt?: number };

export function observeGroupClock(conversation: ConversationWithMembers): ObservedConversation {
  return conversation.type === "group" && conversation.serverTime != null
    ? { ...conversation, groupClockObservedAt: performance.now() }
    : conversation;
}

export function groupTimeoutRemaining(conversation: ObservedConversation | undefined, until: number | null | undefined): number {
  if (conversation?.type !== "group" || until == null || conversation.serverTime == null || conversation.groupClockObservedAt == null) return 0;
  return Math.max(0, until - conversation.serverTime - (performance.now() - conversation.groupClockObservedAt));
}
