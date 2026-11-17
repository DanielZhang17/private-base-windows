import { create } from "zustand";
import type { ConversationWithMembers, DecryptedMessage } from "@e2ee-chat/shared";

function sortMessages(messages: DecryptedMessage[]): DecryptedMessage[] {
  return [...messages].sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }
    return left.id.localeCompare(right.id);
  });
}

interface ChatState {
  conversations: ConversationWithMembers[];
  activeConversationId: string | null;
  messages: Map<string, DecryptedMessage[]>;
  drafts: Map<string, string>;
  typingUsers: Map<string, Set<string>>;
  outgoingRemovalNotices: Set<string>;
  addOutgoingRemovalNotice: (conversationId: string) => void;
  dismissOutgoingRemovalNotice: (conversationId: string) => void;
  setConversations: (convs: ConversationWithMembers[]) => void;
  setActiveConversation: (id: string | null) => void;
  setTyping: (conversationId: string, userId: string, isTyping: boolean) => void;
  addMessage: (conversationId: string, message: DecryptedMessage) => void;
  prependMessages: (conversationId: string, messages: DecryptedMessage[]) => void;
  setMessages: (conversationId: string, messages: DecryptedMessage[]) => void;
  setDraft: (conversationId: string, text: string) => void;
  updateMessageStatus: (messageId: string, status: DecryptedMessage["status"]) => void;
  removeMessages: (messageIds: string[]) => void;
  removeConversationMessages: (conversationId: string) => void;
  unreadCounts: Map<string, number>;
  incrementUnread: (conversationId: string) => void;
  clearUnread: (conversationId: string) => void;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: new Map(),
  drafts: new Map(),
  typingUsers: new Map(),
  outgoingRemovalNotices: new Set(),
  addOutgoingRemovalNotice: (conversationId) => set((state) => ({
    outgoingRemovalNotices: new Set(state.outgoingRemovalNotices).add(conversationId),
  })),
  dismissOutgoingRemovalNotice: (conversationId) => set((state) => {
    const outgoingRemovalNotices = new Set(state.outgoingRemovalNotices);
    outgoingRemovalNotices.delete(conversationId);
    return { outgoingRemovalNotices };
  }),
  setConversations: (conversations) => set({ conversations }),
  setActiveConversation: (id) => set({ activeConversationId: id }),
  setTyping: (conversationId, userId, isTyping) =>
    set((state) => {
      const typingUsers = new Map(state.typingUsers);
      const current = new Set(typingUsers.get(conversationId) ?? []);
      if (isTyping) {
        current.add(userId);
      } else {
        current.delete(userId);
      }
      if (current.size === 0) {
        typingUsers.delete(conversationId);
      } else {
        typingUsers.set(conversationId, current);
      }
      return { typingUsers };
    }),
  addMessage: (conversationId, message) =>
    set((state) => {
      const msgs = new Map(state.messages);
      const existing = msgs.get(conversationId) || [];
      const idx = existing.findIndex((m) => m.id === message.id);
      if (idx === -1) {
        msgs.set(conversationId, sortMessages([...existing, message]));
      } else {
        const updated = [...existing];
        updated[idx] = { ...updated[idx], ...message };
        msgs.set(conversationId, sortMessages(updated));
      }
      return { messages: msgs };
    }),
  prependMessages: (conversationId, incomingMessages) =>
    set((state) => {
      if (incomingMessages.length === 0 && state.messages.has(conversationId)) {
        return { messages: state.messages };
      }

      const msgs = new Map(state.messages);
      const existing = msgs.get(conversationId) || [];
      const byId = new Map(existing.map((message) => [message.id, message]));

      for (const message of incomingMessages) {
        const existingMessage = byId.get(message.id);
        // Cached history fills gaps; current local/live entries win conflicts.
        byId.set(message.id, existingMessage ? { ...message, ...existingMessage } : message);
      }

      msgs.set(conversationId, sortMessages([...byId.values()]));
      return { messages: msgs };
    }),
  setMessages: (conversationId, messages) =>
    set((state) => {
      const msgs = new Map(state.messages);
      msgs.set(conversationId, sortMessages(messages));
      return { messages: msgs };
    }),
  setDraft: (conversationId, text) =>
    set((state) => {
      const drafts = new Map(state.drafts);
      drafts.set(conversationId, text);
      return { drafts };
    }),
  updateMessageStatus: (messageId, status) =>
    set((state) => {
      const msgs = new Map(state.messages);
      for (const [convId, messages] of msgs) {
        const idx = messages.findIndex((m) => m.id === messageId);
        if (idx !== -1) {
          const updated = [...messages];
          updated[idx] = { ...updated[idx], status };
          msgs.set(convId, updated);
          break;
        }
      }
      return { messages: msgs };
    }),
  removeMessages: (messageIds) =>
    set((state) => {
      const ids = new Set(messageIds);
      const messages = new Map(state.messages);
      for (const [conversationId, conversationMessages] of messages) {
        const filtered = conversationMessages.filter((message) => !ids.has(message.id));
        messages.set(conversationId, filtered);
      }
      return { messages };
    }),
  removeConversationMessages: (conversationId) =>
    set((state) => {
      const messages = new Map(state.messages);
      messages.delete(conversationId);
      return { messages };
    }),
  unreadCounts: new Map(),
  incrementUnread: (conversationId) =>
    set((state) => {
      const counts = new Map(state.unreadCounts);
      counts.set(conversationId, (counts.get(conversationId) ?? 0) + 1);
      return { unreadCounts: counts };
    }),
  clearUnread: (conversationId) =>
    set((state) => {
      const counts = new Map(state.unreadCounts);
      counts.delete(conversationId);
      return { unreadCounts: counts };
    }),
}));
