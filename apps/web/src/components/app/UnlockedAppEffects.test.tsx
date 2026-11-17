import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CallEventPayload, Device, User } from "@e2ee-chat/shared";
import UnlockedAppEffects from "./UnlockedAppEffects.js";
import { useAuthStore } from "../../stores/authStore.js";
import { createNotificationWebSocket } from "../../services/notifications.js";
import { handleMessageDeletion, resetMessageSyncState, runUnlockSync, syncMessages } from "../../lib/message-sync.js";
import { requestNotificationPermission } from "../../lib/browser-notifications.js";
import { api } from "../../services/api.js";
import { commitAbandonedMessageHides, getAppDB, deletePendingCall, getPendingCall } from "../../db/index.js";
import { useCallStore } from "../../stores/callStore.js";
import { clearRegisteredLocalCallState } from "../../platform/session-cleanup.js";

vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: null, device: null, accessToken: null })) };
});
vi.mock("../../services/notifications.js", () => ({ createNotificationWebSocket: vi.fn() }));
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn() } }));
vi.mock("../../db/index.js", () => ({ commitAbandonedMessageHides: vi.fn(), getAppDB: vi.fn(async () => ({})), cleanupExpiredFileCache: vi.fn(), cleanupExpiredPendingCalls: vi.fn(), deletePendingCall: vi.fn(), getPendingCall: vi.fn() }));
vi.mock("../../lib/message-sync.js", () => ({ startLocalHiddenMessageSync: vi.fn(() => vi.fn()), handleMessageDeletion: vi.fn(), pruneExpiredPlaintext: vi.fn(), resetMessageSyncState: vi.fn(), syncMessages: vi.fn(), runUnlockSync: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ refreshConversationList: vi.fn() }));
vi.mock("../../lib/browser-notifications.js", () => ({ requestNotificationPermission: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
const dispose = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAppDB).mockResolvedValue({} as Awaited<ReturnType<typeof getAppDB>>);
  vi.mocked(syncMessages).mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.mocked(handleMessageDeletion).mockResolvedValue(undefined);
  vi.mocked(requestNotificationPermission).mockResolvedValue(true);
  vi.mocked(deletePendingCall).mockResolvedValue(undefined);
  useCallStore.getState().clearAllCalls();
  useAuthStore.setState({ user: { id: "bob" } as User, device: { id: "device-1" } as Device, accessToken: "old" });
  vi.mocked(createNotificationWebSocket).mockReturnValue({ ws: null, dispose });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  useCallStore.getState().clearAllCalls();
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const incoming: CallEventPayload = { event: "incoming", callId: "call-1", conversationId: "chat-1", callType: "audio", status: "ringing", fromUserId: "alice", initiatorId: "alice" };
const conversation = { id: "chat-1", members: [{ userId: "alice", user: { displayName: "Alice" } }] };
const emit = (payload: CallEventPayload) => vi.mocked(createNotificationWebSocket).mock.calls.at(-1)![0].onCallEvent(payload);
it.each(["ringing", "active", "starting"])("retains existing busy-call checks when %s", async (state) => {
  await act(async () => root.render(<UnlockedAppEffects />));
  if (state === "starting") useCallStore.getState().beginCallStart();
  else useCallStore.setState({ activeCallId: "other", callStatus: state as "ringing" | "active" });
  await act(async () => emit(incoming));
  expect(api.get).not.toHaveBeenCalled();
});
it.each(["lock", "session change", "end", "busy"])("drops late caller metadata after %s", async (reason) => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api.get).mockReturnValue(new Promise((r) => { resolve = r; }));
  await act(async () => root.render(<UnlockedAppEffects />));
  await act(async () => emit(incoming));
  if (reason === "lock") clearRegisteredLocalCallState();
  if (reason === "session change") await act(async () => useAuthStore.setState({ device: { id: "new-device" } as Device }));
  if (reason === "end") await act(async () => emit({ ...incoming, event: "ended", status: "ended" }));
  if (reason === "busy") useCallStore.setState({ activeCallId: "other", callStatus: "active" });
  await act(async () => resolve(conversation));
  expect(useCallStore.getState().activeCallId).toBe(reason === "busy" ? "other" : null);
});
it("resolves the app-known caller name and marks only the current secure invite ready", async () => {
  vi.mocked(api.get).mockResolvedValue(conversation);
  vi.mocked(getPendingCall).mockResolvedValue({ expiresAt: Date.now() + 60_000 } as Awaited<ReturnType<typeof getPendingCall>>);
  await act(async () => root.render(<UnlockedAppEffects />));
  await act(async () => emit(incoming));
  expect(useCallStore.getState()).toMatchObject({ activeCallId: "call-1", callerName: "Alice", keyReady: true });
});

it("keeps sync, sockets and timers alive across token and profile updates", async () => {
  await act(async () => root.render(<UnlockedAppEffects />));
  expect(createNotificationWebSocket).toHaveBeenCalledTimes(1);
  expect(runUnlockSync).toHaveBeenCalledTimes(1);
  const timerCount = vi.getTimerCount();
  await act(async () => {
    useAuthStore.setState({ accessToken: "refreshed", user: { id: "bob", displayName: "Updated" } as User });
  });
  expect(dispose).not.toHaveBeenCalled();
  expect(resetMessageSyncState).not.toHaveBeenCalled();
  expect(createNotificationWebSocket).toHaveBeenCalledTimes(1);
  expect(runUnlockSync).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(timerCount);
});

it("tears down only for a device/user change, logout or unmount", async () => {
  await act(async () => root.render(<UnlockedAppEffects />));
  await act(async () => { useAuthStore.setState({ device: { id: "device-2" } as Device }); });
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(resetMessageSyncState).toHaveBeenCalledTimes(1);
  expect(createNotificationWebSocket).toHaveBeenCalledTimes(2);
  await act(async () => { useAuthStore.setState({ user: { id: "alice" } as User }); });
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(createNotificationWebSocket).toHaveBeenCalledTimes(3);
  await act(async () => { useAuthStore.setState({ user: null, accessToken: null }); });
  expect(dispose).toHaveBeenCalledTimes(3);
  expect(resetMessageSyncState).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { useAuthStore.setState({ user: { id: "bob" } as User, accessToken: "new" }); });
  expect(createNotificationWebSocket).toHaveBeenCalledTimes(4);
  await act(async () => root.unmount());
  expect(dispose).toHaveBeenCalledTimes(4);
  expect(resetMessageSyncState).toHaveBeenCalledTimes(4);
});

it("ignores duplicate incoming events without resetting an existing secure invite", async () => {
  useCallStore.getState().setIncomingCall({ callId: "call-1", conversationId: "chat-1", initiatorId: "alice", callerUserId: "alice", callType: "audio", keyReady: true });
  await act(async () => root.render(<UnlockedAppEffects />));
  await act(async () => emit(incoming));
  expect(api.get).not.toHaveBeenCalled();
  expect(useCallStore.getState().keyReady).toBe(true);
});

it("applies presence deletion events immediately on this device", async () => {
  await act(async () => root.render(<UnlockedAppEffects />));
  const payload = { conversationId: "chat-1", deletion: { ids: ["message"], deletedAt: 100, deletedByUserId: "alice" } };
  await act(async () => vi.mocked(createNotificationWebSocket).mock.calls.at(-1)![0].onMessageEvent(payload));
  expect(handleMessageDeletion).toHaveBeenCalledWith(payload);
});

it("sweeps pending hides on unlock, every 30 seconds, lock, and sign-out teardown", async () => {
  await act(async () => root.render(<UnlockedAppEffects />));
  expect(commitAbandonedMessageHides).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(29_999));
  expect(commitAbandonedMessageHides).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(commitAbandonedMessageHides).toHaveBeenCalledTimes(2);
  await act(async () => clearRegisteredLocalCallState());
  expect(commitAbandonedMessageHides).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(commitAbandonedMessageHides).toHaveBeenCalledTimes(3);
  await act(async () => { useAuthStore.setState({ user: null, accessToken: null }); });
  expect(commitAbandonedMessageHides).toHaveBeenCalledTimes(4);
});
