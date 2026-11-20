import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GroupJoinRequest } from "@e2ee-chat/shared";
import { api } from "../../services/api.js";
import { refreshConversationList } from "../../lib/conversation-cache.js";
import { useAuthStore } from "../../stores/authStore.js";
import { translateError } from "../shared/errors.js";

export const groupJoinRequestsKey = (id: string) => ["groupJoinRequests", id] as const;

export function useGroupJoinRequests(conversationId: string) {
  const userId = useAuthStore((state) => state.user?.id);
  const client = useQueryClient();
  const path = `/api/conversations/${conversationId}`;
  const queueKey = groupJoinRequestsKey(conversationId);
  const queue = useQuery({
    queryKey: [...queueKey, userId],
    queryFn: () => api.get<GroupJoinRequest[]>(`${path}/join-requests`),
    enabled: !!userId,
  });
  const action = useMutation({
    mutationFn: (change: { joinByName: boolean } | { id: string; decision: "approve" | "decline" }) =>
      "joinByName" in change
        ? api.patch(path, change)
        : api.post(`${path}/join-requests/${encodeURIComponent(change.id)}/${change.decision}`),
    onSettled: async () => {
      if (useAuthStore.getState().user?.id !== userId) return;
      const refresh = [
        client.invalidateQueries({ queryKey: queueKey }),
        client.invalidateQueries({ queryKey: ["conversation", conversationId] }),
        refreshConversationList(),
      ];
      await Promise.allSettled(refresh);
    },
  });
  return {
    queue: queue.data,
    loading: queue.isLoading,
    busy: action.isPending,
    loadError: queue.error ? translateError(queue.error, "groupJoinQueueFailed") : undefined,
    actionError: action.error ? translateError(action.error, "groupJoinUpdateFailed") : undefined,
    update: action.mutate,
    refresh: queue.refetch,
  };
}
