import { act, useEffect } from "react";
import { getByRole, queryByRole } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { CallEventPayload, Device, User } from "@e2ee-chat/shared";
import App from "../../App.js";
import { getAppDB, readPendingSetupRecord, savePendingCall } from "../../db/index.js";
import { getLocalKeyOwner, initializeKeys, keysLoaded, listLocalUnlockMethods, lockLocalCryptoState, setLocalKeyOwner } from "../../lib/key-manager.js";
import { syncMessages } from "../../lib/message-sync.js";
import { capabilities } from "../../platform/capabilities.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { setupDom } from "../../ui/test-utils.js";

vi.mock("../../db/index.js", async original => {
  const actual = await original<typeof import("../../db/index.js")>();
  return { ...actual, readPendingSetupRecord: vi.fn(actual.readPendingSetupRecord) };
});
vi.mock("../../lib/message-sync.js", async original => ({
  ...await original<typeof import("../../lib/message-sync.js")>(),
  runUnlockSync: vi.fn(async () => undefined),
  syncMessages: vi.fn(async () => undefined),
}));
vi.mock("./useKeyMaintenance.js", () => ({ useKeyMaintenance: vi.fn() }));
vi.mock("./WebPushEffects.js", () => ({ default: () => null }));
vi.mock("../../features/chat/useOutgoingQueue.js", () => ({ useOutgoingQueue: vi.fn(), refreshOutgoingQueue: vi.fn() }));
vi.mock("../../pages/ChatPage.js", () => ({ default: () => <p>Accepted chat</p> }));
vi.mock("../../pages/ChatListPage.js", () => ({ default: () => null }));

const { render, container } = setupDom();
const password = "correct password";
const user = { id: "bob", username: "bob", displayName: "Bob" } as User;
const device = { id: "bob-device", userId: user.id, status: "active", linkMethod: "register" } as Device;
const call: CallEventPayload = { event: "incoming", callId: "video-call", conversationId: "chat-1",
  callType: "video", status: "ringing", fromUserId: "alice", initiatorId: "alice" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  await act(async () => {
    lockLocalCryptoState();
    useCallStore.getState().clearAllCalls();
    const db = await getAppDB();
    await db.clear("deviceKeys");
    await db.clear("receivePendingCalls");
  });
  vi.restoreAllMocks();
});

it("shows a call placed after reload and password unlock, before the presence socket connects", async () => {
  const sockets: PresenceSocket[] = [];
  const paths: string[] = [];
  function LocationProbe() {
    const { pathname } = useLocation();
    useEffect(() => { paths.push(pathname); }, [pathname]);
    return null;
  }
  class PresenceSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readyState = PresenceSocket.CONNECTING;
    onopen?: () => void;
    constructor(readonly url: string, readonly protocols: string[]) { sockets.push(this); }
    open() { this.readyState = PresenceSocket.OPEN; this.onopen?.(); }
    close() { this.readyState = 3; }
  }
  vi.stubGlobal("WebSocket", PresenceSocket);
  vi.stubGlobal("innerWidth", 400);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  let ringing: CallEventPayload | null = null;
  const incomingRead = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const { pathname } = new URL(input, location.origin);
    if (pathname === "/api/calls/incoming") {
      incomingRead(new Headers(init.headers).get("Authorization"));
      return Response.json(ringing);
    }
    if (pathname === "/api/conversations/chat-1") return Response.json({
      id: "chat-1", type: "direct", members: [
        { userId: user.id, acceptedAt: 1, user },
        { userId: "alice", acceptedAt: 1, user: { displayName: "Alice", avatarUrl: null } },
      ],
    });
    return Response.json([]);
  }));
  const offer = deferred<void>();
  vi.mocked(syncMessages).mockImplementation(async (options) => {
    if (!options?.force) return;
    await offer.promise;
    await savePendingCall({ id: call.callId, conversationId: call.conversationId, callType: "video",
      initiatorId: "alice", callKey: "mock-offer-key", createdAt: Date.now(), expiresAt: Date.now() + 30_000, direction: "incoming" });
  });

  await initializeKeys(password);
  await setLocalKeyOwner({ userId: user.id, username: user.username, deviceId: device.id });
  useAuthStore.getState().applyAuthResponse({ user, device, accessToken: "bob-token", refreshToken: "bob-refresh" });
  lockLocalCryptoState();
  await useAuthStore.persist.rehydrate();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/chat/chat-1"]}>
    <LocationProbe /><App />
  </MemoryRouter></QueryClientProvider>);
  await act(async () => {
    await vi.waitFor(() => expect(readPendingSetupRecord).toHaveBeenCalledOnce());
    await getLocalKeyOwner();
  });
  await act(async () => { await listLocalUnlockMethods(); });
  expect(container().querySelector('input[type="password"]')).not.toBeNull();
  expect(paths.at(-1)).toBe("/unlock");
  const epoch = useAuthStore.getState().authEpoch;
  const check = deferred<undefined>();
  vi.mocked(readPendingSetupRecord).mockReturnValueOnce(check.promise);
  await act(async () => {
    const input = container().querySelector<HTMLInputElement>('input[type="password"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, password);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(useAuthStore.getState().authEpoch).toBe(epoch + 1));
  });
  expect(keysLoaded()).toBe(true);
  expect(paths.slice(paths.indexOf("/unlock") + 1)).toContain("/chat/chat-1");
  expect(sockets).toHaveLength(0);
  // Alice's one-shot live event has no socket to reach, but the call is now ringing in D1.
  ringing = call;
  await act(async () => {
    await getLocalKeyOwner();
    check.resolve(undefined);
  });
  expect(sockets).toHaveLength(1);
  expect(new URL(sockets[0].url).pathname).toBe("/ws/presence");
  expect(sockets[0].protocols).toEqual(["token.bob-token"]);
  await act(async () => {
    sockets[0].open();
    await vi.waitFor(() => expect(useCallStore.getState().activeCallId).toBe(call.callId));
  });

  expect(incomingRead).toHaveBeenCalledExactlyOnceWith("Bearer bob-token");
  const dialog = getByRole(container(), "dialog", { name: "Incoming call" });
  expect(dialog.textContent).toContain("Alice");
  expect(dialog.textContent).toContain("Incoming video call");
  expect(queryByRole(dialog, "status")).toBeTruthy();
  await act(async () => {
    offer.resolve();
    await vi.waitFor(() => expect(useCallStore.getState().keyReady).toBe(true));
  });
});
