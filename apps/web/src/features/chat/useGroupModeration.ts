import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationWithMembers, GroupMemberUpdate } from "@e2ee-chat/shared";
import { api } from "../../services/api.js";
import { CONVERSATIONS_QUERY_KEY, CONVERSATION_QUERY_KEY } from "../../lib/conversation-cache.js";
import { toErrorMessage } from "../shared/errors.js";
import { groupTimeoutRemaining } from "./group-timeout.js";

export type GroupMember = ConversationWithMembers["members"][number];

export function useGroupModeration(conversation: ConversationWithMembers | undefined, userId: string | undefined) {
  const client = useQueryClient();
  const group = conversation?.type === "group" ? conversation : undefined;
  const [, setClock] = useState(0);
  const latestTimeout = group?.members.reduce((latest, member) => Math.max(latest, member.timedOutUntil ?? 0), 0) ?? 0;
  useEffect(() => {
    if (!groupTimeoutRemaining(group, latestTimeout)) return;
    const timer = window.setInterval(() => {
      setClock(performance.now());
      if (!groupTimeoutRemaining(group, latestTimeout)) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [group, latestTimeout]);

  const mine = group?.members.find((member) => member.userId === userId);
  const remainingSeconds = Math.ceil(groupTimeoutRemaining(group, mine?.timedOutUntil) / 1000);
  const acceptedAdmins = group?.members.filter((member) => member.role === "admin" && member.acceptedAt != null).length ?? 0;
  const mutation = useMutation({
    mutationFn: ({ id, memberId, update }: { id: string; memberId: string; update: GroupMemberUpdate }) =>
      api.patch(`/api/conversations/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}`, update),
    onSettled: (_data, _error, { id }) => Promise.all([
      client.invalidateQueries({ queryKey: [...CONVERSATION_QUERY_KEY, id] }),
      client.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY }),
    ]),
  });
  const current = mutation.variables?.id === group?.id;
  return {
    remainingSeconds,
    acceptedAdmins,
    isTimedOut: (until: number | null | undefined) => groupTimeoutRemaining(group, until) > 0,
    updating: current && mutation.isPending,
    error: current && mutation.error ? toErrorMessage(mutation.error, "groupMemberUpdateFailed") : null,
    updateMember: (memberId: string, update: GroupMemberUpdate) => {
      if (group && mine?.acceptedAt != null && mine.role === "admin" && !mutation.isPending) {
        mutation.mutate({ id: group.id, memberId, update });
      }
    },
  };
}
