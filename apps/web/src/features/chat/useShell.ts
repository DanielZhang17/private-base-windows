import { useEffect } from "react";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { useConnectionStore } from "../../stores/connectionStore.js";

export function useShell() {
  const user = useAuthStore((state) => state.user);
  const unreadCounts = useChatStore((state) => state.unreadCounts);
  const conversations = useChatStore((state) => state.conversations);
  const isOnline = useConnectionStore((state) => state.isOnline);
  useEffect(() => {
    const update = () => useConnectionStore.getState().setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return { user, isOnline, unread: conversations.reduce((sum, conversation) => sum + (unreadCounts.get(conversation.id) ?? 0), 0) };
}
