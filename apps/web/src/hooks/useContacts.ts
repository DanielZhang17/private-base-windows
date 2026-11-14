import { useMemo } from "react";
import { useAuthStore } from "../stores/authStore.js";
import { getConversationListFromCache } from "../lib/conversation-cache.js";

export interface Contact {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export function useContacts(): Contact[] {
  const userId = useAuthStore((state) => state.user?.id);
  const conversations = getConversationListFromCache();

  return useMemo(() => {
    if (!userId) return [];

    const contactMap = new Map<string, Contact>();

    for (const conv of conversations) {
      if (conv.type !== "direct") continue;
      for (const member of conv.members) {
        if (member.userId === userId) continue;
        if (contactMap.has(member.userId)) continue;
        contactMap.set(member.userId, {
          id: member.userId,
          username: member.user.username,
          displayName: member.user.displayName,
          avatarUrl: member.user.avatarUrl,
        });
      }
    }

    return [...contactMap.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }, [userId, conversations]);
}
