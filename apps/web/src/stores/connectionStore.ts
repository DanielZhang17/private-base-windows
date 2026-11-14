import { create } from "zustand";

interface ConnectionState {
  wsConnections: Map<string, WebSocket>;
  isOnline: boolean;
  setConnection: (id: string, ws: WebSocket) => void;
  removeConnection: (id: string) => void;
  setOnline: (online: boolean) => void;
}

export const useConnectionStore = create<ConnectionState>()((set, get) => ({
  wsConnections: new Map(),
  isOnline: navigator.onLine,
  setConnection: (id, ws) =>
    set((state) => {
      const conns = new Map(state.wsConnections);
      conns.set(id, ws);
      return { wsConnections: conns };
    }),
  removeConnection: (id) =>
    set((state) => {
      const conns = new Map(state.wsConnections);
      conns.delete(id);
      return { wsConnections: conns };
    }),
  setOnline: (online) => set({ isOnline: online }),
}));
