import type { ConversationWithMembers } from "@e2ee-chat/shared";
import { api, ApiError } from "../services/api.js";
import { useAuthStore } from "../stores/authStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { queryClient } from "./query-client.js";
import { observeGroupClock } from "../features/chat/group-timeout.js";

export const CONVERSATIONS_QUERY_KEY = ["conversations"] as const;
export const CONVERSATION_QUERY_KEY = ["conversation"] as const;

function sortConversations(conversations: ConversationWithMembers[]): ConversationWithMembers[] {
  return [...conversations].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.id.localeCompare(right.id);
  });
}

function writeConversations(conversations: ConversationWithMembers[]): ConversationWithMembers[] {
  const sorted = sortConversations(conversations);
  queryClient.setQueryData(CONVERSATIONS_QUERY_KEY, sorted);
  for (const conversation of sorted) {
    queryClient.setQueryData([...CONVERSATION_QUERY_KEY, conversation.id], conversation);
  }
  useChatStore.getState().setConversations(sorted);
  return sorted;
}

function currentSession(): string | null {
  const { accessToken, sessionId, user } = useAuthStore.getState();
  return accessToken ? `${sessionId ?? ""}:${user?.id ?? ""}` : null;
}

/**
 * Fetch for the current session. A response that arrives after the session ended or changed
 * belongs to the previous account and must never be written into the caches.
 */
async function fetchForSession<T>(path: string): Promise<T> {
  const session = currentSession();
  const result = await api.get<T>(path);
  if (currentSession() !== session) throw new ApiError("Session changed", 401);
  return result;
}

export async function fetchConversationList(): Promise<ConversationWithMembers[]> {
  return writeConversations((await fetchForSession<ConversationWithMembers[]>("/api/conversations")).map(observeGroupClock));
}

export async function refreshConversationList(): Promise<ConversationWithMembers[]> {
  await queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY });
  return queryClient.fetchQuery({
    queryKey: CONVERSATIONS_QUERY_KEY,
    queryFn: fetchConversationList,
    staleTime: 0,
  });
}

export function getConversationListFromCache(): ConversationWithMembers[] {
  return queryClient.getQueryData<ConversationWithMembers[]>(CONVERSATIONS_QUERY_KEY) ?? [];
}

export function getCachedConversation(conversationId: string): ConversationWithMembers | undefined {
  return getConversationListFromCache().find((conversation) => conversation.id === conversationId);
}

export function upsertConversationInCache(conversation: ConversationWithMembers): ConversationWithMembers[] {
  const current = getConversationListFromCache().filter((entry) => entry.id !== conversation.id);
  return writeConversations([...current, conversation]);
}

export function touchConversationInCache(conversationId: string, updatedAt: number): ConversationWithMembers[] {
  const current = getConversationListFromCache();
  const index = current.findIndex((conversation) => conversation.id === conversationId);
  if (index === -1) {
    return current;
  }

  const updated = [...current];
  updated[index] = { ...updated[index], updatedAt };
  return writeConversations(updated);
}

export async function ensureConversationInCache(conversationId: string): Promise<ConversationWithMembers> {
  const cached = getCachedConversation(conversationId);
  if (cached) return cached;

  const conversation = observeGroupClock(await fetchForSession<ConversationWithMembers>(`/api/conversations/${conversationId}`));
  upsertConversationInCache(conversation);
  return conversation;
}
