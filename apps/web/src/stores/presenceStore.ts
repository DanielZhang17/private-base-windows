import { create } from "zustand";

interface PresenceState {
  onlineUsers: Set<string>;
  setUserOnline: (userId: string) => void;
  setUserOffline: (userId: string) => void;
  isUserOnline: (userId: string) => boolean;
}

export const usePresenceStore = create<PresenceState>()((set, get) => ({
  onlineUsers: new Set(),
  setUserOnline: (userId) =>
    set((state) => {
      const onlineUsers = new Set(state.onlineUsers);
      onlineUsers.add(userId);
      return { onlineUsers };
    }),
  setUserOffline: (userId) =>
    set((state) => {
      const onlineUsers = new Set(state.onlineUsers);
      onlineUsers.delete(userId);
      return { onlineUsers };
    }),
  isUserOnline: (userId) => get().onlineUsers.has(userId),
}));
