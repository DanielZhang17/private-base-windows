import { useAuthStore } from "../stores/authStore.js";
import type { WSFrame } from "@e2ee-chat/shared";
import { resolveWsBaseUrl } from "./api.js";

export function createChatWebSocket(
  conversationId: string,
  onMessage: (frame: WSFrame) => void,
  onClose?: () => void
): WebSocket {
  const { accessToken } = useAuthStore.getState();
  if (!accessToken) {
    throw new Error("Missing access token for chat websocket");
  }
  const ws = new WebSocket(
    `${resolveWsBaseUrl()}/ws/chat/${conversationId}?edits=1`,
    [`token.${accessToken}`]
  );

  ws.onmessage = (event) => {
    try {
      const frame: WSFrame = JSON.parse(event.data);
      onMessage(frame);
    } catch {
      // ignore malformed
    }
  };

  ws.onclose = () => onClose?.();
  ws.onerror = () => ws.close();

  return ws;
}
