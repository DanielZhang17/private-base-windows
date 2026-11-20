import { useEffect, useState } from "react";
/** View-facing selectors for the group call UI, so components keep stores and shared packages behind features (W3a). */
import { groupCallCapacity, type CallType, type ConversationWithMembers } from "@e2ee-chat/shared";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";

export { groupCallCapacity };
export type { CallType, ConversationWithMembers };

export function useGroupConversation(conversationId: string | undefined) {
  return useChatStore((state) => conversationId ? state.conversations.find((conversation) => conversation.id === conversationId) : undefined);
}

export function useSignedInUser() {
  return useAuthStore((state) => state.user);
}

/** Non-reactive lookup for effects and event handlers. */
export function groupConversationName(conversationId: string) {
  return useChatStore.getState().conversations.find((conversation) => conversation.id === conversationId)?.name;
}

/** Call timer, like the 1:1 call: "04:09", or "1:02:03" past an hour. Locale digits are not needed (tabular clock). */
export function formatCallClock(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Reactive media query; tolerant of environments whose matchMedia lacks change listeners. */
export function useMatchMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia?.(query)?.matches ?? false);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list || typeof list.addEventListener !== "function") return;
    const change = () => setMatch(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, [query]);
  return match;
}
