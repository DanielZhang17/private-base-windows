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
    constructor() { constructor(); }
    close = vi.fn();
  }
  vi.stubGlobal("WebSocket", Socket);
  const onClose = vi.fn();
  const ws = createChatWebSocket("chat", vi.fn(), onClose);
  ws.onclose?.({ code: 4403 } as CloseEvent);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(onClose).toHaveBeenCalledOnce();
  expect(constructor).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
