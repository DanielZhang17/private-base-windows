import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../stores/authStore.js";
import { api } from "./api.js";
import { createNotificationWebSocket } from "./notifications.js";

vi.mock("../stores/authStore.js", () => ({ useAuthStore: { getState: vi.fn() } }));
vi.mock("./api.js", () => ({ api: { get: vi.fn() }, resolveWsBaseUrl: () => "wss://test" }));

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  send = vi.fn();
  constructor(public url: string, public protocols: string[]) { FakeSocket.instances.push(this); }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
}
const callbacks = () => ({ onCallEvent: vi.fn(), onConversationEvent: vi.fn(), onMessageEvent: vi.fn(), onProfileEvent: vi.fn() });
const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1];
let token: string | null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.instances = [];
  vi.resetAllMocks();
  token = "old-token";
  vi.mocked(useAuthStore.getState).mockImplementation(() => ({ accessToken: token }) as ReturnType<typeof useAuthStore.getState>);
  vi.mocked(api.get).mockResolvedValue({});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("notification reconnects", () => {
  it("backs off, refreshes after three failed opens, and connects with the fresh token", async () => {
    const socket = createNotificationWebSocket(callbacks());
    expect(latest().protocols).toEqual(["token.old-token"]);
    latest().close();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);
    token = "new-token";
    await vi.advanceTimersByTimeAsync(1);
    expect(latest().protocols).toEqual(["token.new-token"]);
    latest().close();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    latest().close();
    vi.mocked(api.get).mockImplementation(async () => { token = "refreshed-token"; return {}; });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(api.get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.get).toHaveBeenCalledExactlyOnceWith("/api/account/session");
    expect(latest().protocols).toEqual(["token.refreshed-token"]);
    socket.dispose();
  });

  it("caps delays at 30 seconds and resets backoff after an open", async () => {
    const socket = createNotificationWebSocket(callbacks());
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const count = FakeSocket.instances.length;
      latest().close();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeSocket.instances).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.instances).toHaveLength(count + 1);
    }
    latest().open();
    latest().close();
    const count = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(count + 1);
    socket.dispose();
  });

  it("stops reconnecting after disposal or token removal and skips a missing initial token", async () => {
    token = null;
    const empty = createNotificationWebSocket(callbacks());
    expect(empty.ws).toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);
    empty.dispose();
    token = "token";
    const socket = createNotificationWebSocket(callbacks());
    latest().close();
    token = null;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(1);
    socket.dispose();
    token = "token";
    const disposed = createNotificationWebSocket(callbacks());
    latest().close();
    disposed.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("cannot reconnect when disposed during the REST refresh", async () => {
    const socket = createNotificationWebSocket(callbacks());
    latest().close();
    await vi.advanceTimersByTimeAsync(1_000);
    latest().close();
    await vi.advanceTimersByTimeAsync(2_000);
    latest().close();
    let finish!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(api.get).toHaveBeenCalledTimes(1);
    socket.dispose();
    finish({});
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(3);
  });
});

it.each([false, true])("stops reconnecting on 4403 (opened=%s)", async (opened) => {
  const options = { ...callbacks(), onClose: vi.fn() };
  const socket = createNotificationWebSocket(options);
  if (opened) latest().open();
  latest().close(4403);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(FakeSocket.instances).toHaveLength(1);
  expect(options.onClose).toHaveBeenCalledOnce();
  expect(api.get).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  socket.dispose();
});
