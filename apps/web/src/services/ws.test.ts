import { afterEach, expect, it, vi } from "vitest";
import { createChatWebSocket } from "./ws.js";
vi.mock("../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ accessToken: "token" }) } }));
vi.mock("./api.js", () => ({ resolveWsBaseUrl: () => "wss://test" }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("reports a 4403 closure once without reopening or scheduling reconnects", async () => {
  vi.useFakeTimers();
  const constructor = vi.fn();
  class Socket {
    onclose?: (event: { code: number }) => void;
    constructor(url: string, protocols: string[]) { constructor(url, protocols); }
    close = vi.fn();
  }
  vi.stubGlobal("WebSocket", Socket);
  const onClose = vi.fn();
  const ws = createChatWebSocket("chat", vi.fn(), onClose);
  ws.onclose?.({ code: 4403 } as CloseEvent);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(onClose).toHaveBeenCalledOnce();
  expect(constructor).toHaveBeenCalledExactlyOnceWith("wss://test/ws/chat/chat?edits=1&logicalDeletionIds=1", ["token.token"]);
  expect(vi.getTimerCount()).toBe(0);
});
