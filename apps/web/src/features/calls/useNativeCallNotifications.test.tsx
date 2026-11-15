import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Device, User } from "@e2ee-chat/shared";
import { capabilities } from "../../platform/capabilities.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { clearUnlockedSessionState } from "../../platform/session-cleanup.js";
import { useNativeCallNotifications } from "./useNativeCallNotifications.js";
import { useCallInvitationOwner } from "./useCallInvitationOwner.js";
import { IncomingCallContext } from "./IncomingCallContext.js";
import { useIncomingCall } from "./useIncomingCall.js";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), get: vi.fn(), post: vi.fn(), invite: vi.fn(), navigate: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../services/api.js", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("../../db/index.js", () => ({ getPendingCall: mocks.invite }));
vi.mock("../../platform/navigation.js", () => ({ navigate: mocks.navigate }));
vi.mock("../../stores/authStore.js", async () => { const { create } = await import("zustand"); return { useAuthStore: create(() => ({ user: null, device: null, accessToken: null, sessionId: null })) }; });
let root: Root;
let incoming: ReturnType<typeof useIncomingCall>;
const visibility = { hidden: false };
function Probe() { incoming = useIncomingCall(); return null; }
function Owner({ enabled = true }: { enabled?: boolean }) {
  const owner = useCallInvitationOwner(enabled);
  useNativeCallNotifications(enabled, owner.respond);
  return <IncomingCallContext.Provider value={owner}><Probe /></IncomingCallContext.Provider>;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const render = async (enabled = true) => { await act(async () => root.render(<MemoryRouter><Owner enabled={enabled} /></MemoryRouter>)); await flush(); };
const wake = async (actions: unknown[]) => {
  mocks.invoke.mockImplementationOnce(async () => actions);
  await act(async () => { window.dispatchEvent(new Event("privatebase-notification-action")); });
  await flush();
};
const visible = async (hidden: boolean) => { visibility.hidden = hidden; await act(async () => { document.dispatchEvent(new Event("visibilitychange")); }); await flush(); };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility.hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => visibility.hidden);
  vi.spyOn(capabilities, "nativeCallNotifications", "get").mockReturnValue(true);
  vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  useAuthStore.setState({ user: { id: "bob" } as User, device: { id: "device" } as Device, sessionId: "session", accessToken: "token" });
  useCallStore.getState().clearAllCalls();
  useCallStore.getState().setIncomingCall({ callId: "call-1", conversationId: "chat-1", initiatorId: "alice", callerUserId: "alice", callerName: "Alice", callType: "video", keyReady: true });
  mocks.invoke.mockImplementation(async (name: string) => name === "take_notification_actions" ? [] : true);
  mocks.get.mockResolvedValue({ id: "call-1", status: "ringing", createdAt: Date.now(), conversationId: "chat-1", initiatorId: "alice", type: "video" });
  mocks.post.mockResolvedValue({});
  mocks.invite.mockResolvedValue({ id: "call-1", direction: "incoming", conversationId: "chat-1", initiatorId: "alice", callType: "video", expiresAt: Date.now() + 60_000 });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => { await act(async () => root.unmount()); useCallStore.getState().clearAllCalls(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("keeps visible calls in-app and posts once when backgrounded, then cancels the exact ID on remote acceptance", async () => {
  await render();
  expect(incoming.visible).toBe(true);
  expect(mocks.invoke).not.toHaveBeenCalledWith("show_incoming_call", expect.anything());
  await visible(true);
  expect(incoming.visible).toBe(false);
  expect(mocks.invoke).toHaveBeenCalledWith("show_incoming_call", { callId: "call-1", callerName: "Alice", video: true });
  await act(async () => useCallStore.getState().markKeyReady("call-1"));
  expect(mocks.invoke.mock.calls.filter(([name]) => name === "show_incoming_call")).toHaveLength(1);
  await act(async () => useCallStore.getState().updateCallStatus("call-1", "active")); await flush();
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_incoming_call", { callId: "call-1" });
  expect(useCallStore.getState().localCallOwnership).toBeNull();
});
it.each(["ended", "declined", "missed"] as const)("cancels a native notification on %s", async (status) => {
  visibility.hidden = true; await render();
  await act(async () => useCallStore.getState().updateCallStatus("call-1", status)); await flush();
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_incoming_call", { callId: "call-1" });
});
it.each([false, new Error("Bridge unavailable")])("retries a failed native notification once", async (failure) => {
  visibility.hidden = true;
  let attempts = 0;
  mocks.invoke.mockImplementation(async (name: string) => {
    if (name !== "show_incoming_call") return [];
    if (++attempts > 1) return true;
    if (failure instanceof Error) throw failure;
    return failure;
  });
  await render();
  expect(attempts).toBe(1);
  await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 2000 });
  await act(async () => useCallStore.getState().markKeyReady("call-1"));
  expect(attempts).toBe(2);
});
it("cancels replaced calls and a late show after lock", async () => {
  visibility.hidden = true;
  const show = deferred<boolean>();
  mocks.invoke.mockImplementation(async (name: string) => name === "show_incoming_call" ? show.promise : []);
  await render();
  await act(async () => useCallStore.getState().setIncomingCall({ callId: "call-2", conversationId: "chat-2", initiatorId: "alice", callerUserId: "alice", callType: "audio" }));
  await flush();
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_incoming_call", { callId: "call-1" });
  await act(async () => clearUnlockedSessionState());
  mocks.invoke.mockClear();
  show.resolve(true); await flush();
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_incoming_call", { callId: "call-1" });
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_incoming_call", { callId: "call-2" });
});
it("accepts only a queued current call through the shared local-consent owner", async () => {
  await render();
  expect(mocks.post).not.toHaveBeenCalled(); expect(useCallStore.getState().localCallOwnership).toBeNull();
  await wake([{ kind: "accept", id: "call-1" }, { kind: "accept", id: "call-1" }]);
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/calls/call-1/accept");
  expect(mocks.navigate).toHaveBeenCalledWith("/call/call-1");
  expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "call-1", reason: "accepted" });
  await wake([{ kind: "accept", id: "call-1" }]);
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
it("defers Accept and navigation while hidden and preserves their FIFO order when visible", async () => {
  visibility.hidden = true; await render();
  await wake([{ kind: "accept", id: "call-1" }, { kind: "open-conversation", id: "chat-1" }]);
  expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
  await visible(false);
  expect(mocks.navigate.mock.calls.map(([path]) => path)).toEqual(["/call/call-1", "/chat/chat-1"]);
  expect(useCallStore.getState().localCallOwnership?.reason).toBe("accepted");
});
it("honors a later hidden Decline over a deferred Accept, without requiring a secure invite", async () => {
  visibility.hidden = true;
  useCallStore.getState().markKeyReady("call-1", false);
  vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(false);
  await render();
  await wake([{ kind: "accept", id: "call-1" }]);
  await wake([{ kind: "decline", id: "call-1" }]);
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/calls/call-1/decline");
  expect(mocks.invite).not.toHaveBeenCalled();
  await visible(false);
  expect(useCallStore.getState().localCallOwnership).toBeNull(); expect(mocks.post).toHaveBeenCalledTimes(1);
});
it("stages a whole FIFO batch so Accept followed by Decline never starts acceptance", async () => {
  await render();
  await wake([{ kind: "accept", id: "call-1" }, { kind: "decline", id: "call-1" }]);
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/calls/call-1/decline");
  expect(mocks.invite).not.toHaveBeenCalled(); expect(useCallStore.getState().localCallOwnership).toBeNull();
});
it("waits for the secure invite and ignores actions for another call", async () => {
  useCallStore.getState().markKeyReady("call-1", false); await render();
  await wake([{ kind: "accept", id: "stale" }, { kind: "accept", id: "call-1" }]);
  expect(mocks.post).not.toHaveBeenCalled();
  await act(async () => useCallStore.getState().markKeyReady("call-1")); await flush();
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/calls/call-1/accept");
});
it.each(["remote acceptance", "expiry", "unsupported", "missing invite", "ended"])("ignores stale Accept after %s", async (reason) => {
  if (reason === "remote acceptance") mocks.get.mockResolvedValue({ id: "call-1", status: "active" });
  if (reason === "expiry") mocks.invite.mockResolvedValue({ expiresAt: Date.now() - 1 });
  if (reason === "unsupported") vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(false);
  if (reason === "missing invite") mocks.invite.mockResolvedValue(null);
  if (reason === "ended") useCallStore.getState().updateCallStatus("call-1", "ended");
  await render(); await wake([{ kind: "accept", id: "call-1" }]);
  expect(mocks.post).not.toHaveBeenCalled(); expect(useCallStore.getState().localCallOwnership).toBeNull();
});
it.each(["lock", "session change", "call end", "hidden", "later decline"])("revalidates an Accept after awaited server state on %s", async (reason) => {
  const info = deferred<unknown>(); mocks.get.mockReturnValue(info.promise);
  await render(); await wake([{ kind: "accept", id: "call-1" }]);
  if (reason === "lock") await act(async () => clearUnlockedSessionState());
  if (reason === "session change") await act(async () => useAuthStore.setState({ sessionId: "new-session" }));
  if (reason === "call end") await act(async () => useCallStore.getState().updateCallStatus("call-1", "ended"));
  if (reason === "hidden") await visible(true);
  if (reason === "later decline") await wake([{ kind: "decline", id: "call-1" }]);
  info.resolve({ id: "call-1", status: "ringing", createdAt: Date.now(), conversationId: "chat-1", initiatorId: "alice", type: "video" }); await flush();
  expect(mocks.post).not.toHaveBeenCalledWith("/api/calls/call-1/accept");
  expect(useCallStore.getState().localCallOwnership).toBeNull();
});
it("serializes simultaneous drains and discards a stale batch on teardown", async () => {
  await render(); const batch = deferred<unknown[]>();
  mocks.invoke.mockClear(); mocks.invoke.mockImplementationOnce(() => batch.promise);
  await act(async () => { window.dispatchEvent(new Event("privatebase-notification-action")); window.dispatchEvent(new Event("focus")); });
  await flush();
  expect(mocks.invoke.mock.calls.filter(([name]) => name === "take_notification_actions")).toHaveLength(1);
  batch.resolve([]); await flush();
  expect(mocks.invoke.mock.calls.filter(([name]) => name === "take_notification_actions")).toHaveLength(2);
  const stale = deferred<unknown[]>(); mocks.invoke.mockImplementationOnce(() => stale.promise);
  await act(async () => window.dispatchEvent(new Event("privatebase-notification-action"))); await flush();
  await act(async () => clearUnlockedSessionState());
  stale.resolve([{ kind: "accept", id: "call-1" }, { kind: "open-conversation", id: "chat-1" }]); await flush();
  expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
});
it("drains startup actions and navigates only validated conversation IDs", async () => {
  mocks.invoke.mockImplementationOnce(async () => [{ kind: "open-conversation", id: "chat_1" }, { kind: "open-conversation", id: "https://evil.invalid" }]);
  await render(); expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/chat/chat_1");
  expect(mocks.invoke.mock.calls.every(([name]) => ["take_notification_actions", "show_incoming_call", "cancel_incoming_call"].includes(name))).toBe(true);
});
it("leaves older shells and non-native modal behavior unchanged", async () => {
  vi.spyOn(capabilities, "nativeCallNotifications", "get").mockReturnValue(false);
  visibility.hidden = true; await render();
  await wake([{ kind: "accept", id: "call-1" }]);
  expect(incoming.visible).toBe(true); expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
});
it("rechecks consent after the shared Accept request and never grants ownership after lock", async () => {
  const response = deferred<unknown>(); mocks.post.mockReturnValue(response.promise);
  await render(); await wake([{ kind: "accept", id: "call-1" }]);
  expect(mocks.post).toHaveBeenCalledWith("/api/calls/call-1/accept");
  await act(async () => clearUnlockedSessionState());
  response.resolve({}); await flush();
  expect(useCallStore.getState().localCallOwnership).toBeNull();
});
it("resumes a deferred Accept if visibility is lost during preflight", async () => {
  const info = deferred<unknown>(); mocks.get.mockReturnValueOnce(info.promise);
  await render(); await wake([{ kind: "accept", id: "call-1" }]);
  await visible(true);
  info.resolve({ id: "call-1", status: "ringing", createdAt: Date.now(), conversationId: "chat-1", initiatorId: "alice", type: "video" }); await flush();
  expect(mocks.post).not.toHaveBeenCalled();
  await visible(false);
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/calls/call-1/accept");
});
it.each(["direction", "conversationId", "initiatorId", "callType"])("rejects a secure invite with mismatched %s", async (field) => {
  mocks.invite.mockResolvedValue({ id: "call-1", direction: "incoming", conversationId: "chat-1", initiatorId: "alice", callType: "video", expiresAt: Date.now() + 60_000, [field]: "wrong" });
  await render(); await wake([{ kind: "accept", id: "call-1" }]);
  expect(mocks.post).not.toHaveBeenCalled();
});

it("blocks later navigation behind a visible Accept whose secure key is not ready", async () => {
  useCallStore.getState().markKeyReady("call-1", false);
  await render();
  await wake([{ kind: "accept", id: "call-1" }, { kind: "open-conversation", id: "chat-2" }]);
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
  await act(async () => useCallStore.getState().markKeyReady("call-1")); await flush();
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/calls/call-1/accept");
  expect(mocks.navigate.mock.calls.map(([path]) => path)).toEqual(["/call/call-1", "/chat/chat-2"]);
});
it("a later Decline supersedes a key-blocked Accept in its queue position before navigation", async () => {
  useCallStore.getState().markKeyReady("call-1", false);
  await render();
  await wake([{ kind: "accept", id: "call-1" }, { kind: "open-conversation", id: "chat-2" }]);
  expect(mocks.navigate).not.toHaveBeenCalled();
  await wake([{ kind: "decline", id: "call-1" }]);
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/calls/call-1/decline");
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/chat/chat-2");
  expect(mocks.post.mock.invocationCallOrder[0]).toBeLessThan(mocks.navigate.mock.invocationCallOrder[0]);
});
it("routes hidden calls and drains a legacy session with a null sessionId", async () => {
  useAuthStore.setState({ sessionId: null, authEpoch: 1 });
  visibility.hidden = true;
  await render();
  expect(incoming.visible).toBe(false);
  expect(mocks.invoke).toHaveBeenCalledWith("show_incoming_call", { callId: "call-1", callerName: "Alice", video: true });
  // Like the API client, device identity keeps this legacy login current across token/epoch updates.
  await act(async () => useAuthStore.setState({ accessToken: "refreshed", authEpoch: 2 }));
  await wake([{ kind: "decline", id: "call-1" }]);
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/calls/call-1/decline");
});
it("preserves local consent when the accepted event wins the race with a backgrounded Accept POST", async () => {
  const response = deferred<unknown>(); mocks.post.mockReturnValue(response.promise);
  await render(); await wake([{ kind: "accept", id: "call-1" }]);
  expect(incoming.pendingLocalAcceptance).toMatchObject({ callId: "call-1", epoch: useCallStore.getState().localCallEpoch });
  await visible(true);
  await act(async () => useCallStore.getState().updateCallStatus("call-1", "active"));
  response.resolve({}); await flush();
  expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "call-1", reason: "accepted" });
  expect(incoming.pendingLocalAcceptance?.callId).toBe("call-1");
  await visible(false);
  expect(useCallStore.getState().localCallOwnership?.reason).toBe("accepted");
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
it("uses the API authEpoch fallback for a legacy session without a device ID", async () => {
  useAuthStore.setState({ sessionId: null, device: null, authEpoch: 3 });
  visibility.hidden = true;
  await render();
  expect(mocks.invoke).toHaveBeenCalledWith("show_incoming_call", { callId: "call-1", callerName: "Alice", video: true });
  await wake([{ kind: "decline", id: "call-1" }]);
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/calls/call-1/decline");
});
