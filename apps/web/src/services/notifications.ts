import {
  HEARTBEAT_INTERVAL,
  WSFrameType,
  type CallEventPayload,
  type ConversationEventPayload,
  type MessageEventPayload,
  type ProfileEventPayload,
  type WSFrame,
} from "@e2ee-chat/shared";
import { useAuthStore } from "../stores/authStore.js";
import { api, resolveWsBaseUrl } from "./api.js";

interface NotificationSocketOptions {
  onCallEvent: (payload: CallEventPayload) => void;
  onConversationEvent: (payload: ConversationEventPayload) => void;
  onMessageEvent: (payload: MessageEventPayload) => void;
  onProfileEvent: (payload: ProfileEventPayload) => void;
  onPresenceEvent?: (userId: string, status: "online" | "offline") => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export function createNotificationWebSocket(options: NotificationSocketOptions): {
  ws: WebSocket | null;
  dispose: () => void;
} {
  let ws: WebSocket | null = null;
  let disposed = false;
  let reconnectTimer: number | null = null;
  let heartbeat: number | null = null;
  let reconnectAttempt = 0;
  let closesWithoutOpen = 0;

  const connect = () => {
    if (disposed) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;

    const socket = new WebSocket(
      `${resolveWsBaseUrl()}/ws/presence`,
      [`token.${token}`],
    );
    ws = socket;
    let opened = false;

    heartbeat = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, Math.max(5_000, HEARTBEAT_INTERVAL / 2));

    socket.onopen = () => {
      if (disposed) return;
      opened = true;
      reconnectAttempt = 0;
      closesWithoutOpen = 0;
      options.onOpen?.();
    };

    socket.onmessage = (event) => {
      if (disposed) return;
      try {
        const frame: WSFrame | { type: "ping" } = JSON.parse(event.data);
        if (frame.type === "ping") {
          socket.send(JSON.stringify({ type: "heartbeat" }));
          return;
        }
        if (frame.type === WSFrameType.Call) {
          options.onCallEvent(frame.payload);
          return;
        }
        if (frame.type === WSFrameType.Conversation) {
          options.onConversationEvent(frame.payload);
          return;
        }
        if (frame.type === WSFrameType.MessageEvent) {
          options.onMessageEvent(frame.payload);
          return;
        }
        if (frame.type === WSFrameType.Profile) {
          options.onProfileEvent(frame.payload);
          return;
        }
        if (frame.type === WSFrameType.Presence) {
          options.onPresenceEvent?.(frame.userId, frame.status);
        }
      } catch {
        // Ignore malformed frames.
      }
    };

    socket.onclose = (event) => {
      if (heartbeat !== null) window.clearInterval(heartbeat);
      if (disposed) return;
      if (!opened) closesWithoutOpen++;
      options.onClose?.();
      if (event.code === 4403) {
        disposed = true;
        return;
      }
      const delay = Math.min(1_000 * 2 ** reconnectAttempt, 30_000);
      reconnectAttempt = Math.min(reconnectAttempt + 1, 5);
      reconnectTimer = window.setTimeout(async () => {
        reconnectTimer = null;
        if (disposed || !useAuthStore.getState().accessToken) return;
        if (closesWithoutOpen >= 3) {
          closesWithoutOpen = 0;
          // The API client refreshes an expired token on 401 before retrying.
          await api.get("/api/account/session").catch(() => undefined);
        }
        connect();
      }, delay);
    };
    socket.onerror = () => socket.close();
  };

  connect();
  return {
    get ws() { return ws; },
    dispose: () => {
      disposed = true;
      if (heartbeat !== null) window.clearInterval(heartbeat);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    },
  };
}
