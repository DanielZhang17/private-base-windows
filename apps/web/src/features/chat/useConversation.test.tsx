import { act } from "react";
import type { SendDirectBatchResponse } from "@e2ee-chat/shared";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConversation } from "./useConversation.js";
import { api } from "../../services/api.js";
import { loadOlderPersistedConversationMessages } from "../../lib/message-sync.js";
import { createChatWebSocket } from "../../services/ws.js";
import { supportsE2EECalling } from "../../services/webrtc.js";
import { E2EECallUnsupportedError } from "../../platform/calls.js";
import { useAuthStore } from "../../stores/authStore.js";
import { sendDirectPayloadFanout } from "../../lib/direct-messages.js";
import { deletePendingCall, savePendingCall } from "../../db/index.js";
import { useCallStore } from "../../stores/callStore.js";
import { useChatStore } from "../../stores/chatStore.js";

vi.mock("./useSendMessage.js", () => ({ useSendMessage: () => ({ outgoing: [], handleSend: vi.fn(), handleSendFile: vi.fn() }) }));
vi.mock("../../stores/authStore.js", async () => { const { create } = await import("zustand"); return { useAuthStore: create(() => ({ user: { id: "alice" }, device: { id: "device" }, sessionId: "session", accessToken: "token" })) }; });
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn() } }));
vi.mock("../../services/ws.js", () => ({ createChatWebSocket: vi.fn() }));
vi.mock("../../services/webrtc.js", () => ({ supportsE2EECalling: vi.fn(() => true) }));
vi.mock("../../lib/message-sync.js", () => ({ loadPersistedConversationMessages: async () => ({ hasOlder: false }), syncConversationMessages: vi.fn(), ingestMessageFrame: vi.fn(), loadOlderPersistedConversationMessages: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ upsertConversationInCache: vi.fn(), refreshConversationList: vi.fn() }));
vi.mock("../../db/index.js", () => ({ guardMessageForPublish: vi.fn(async (message) => message), saveMessage: vi.fn(), getPendingCall: vi.fn(async () => ({})), savePendingCall: vi.fn(async () => {}), deletePendingCall: vi.fn(async () => {}) }));
vi.mock("../../lib/direct-messages.js", () => ({ sendDirectPayloadFanout: vi.fn(async () => {}) }));
let root: Root;
let state: ReturnType<typeof useConversation>;
let socket: WebSocket;
let pathname: string;
function LocationProbe() { pathname = useLocation().pathname; return null; }
function Probe() { state = useConversation(); return null; }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useCallStore.getState().clearAllCalls();
  useAuthStore.setState({ user: { id: "alice" }, device: { id: "device" }, sessionId: "session", accessToken: "token" } as never);
  vi.mocked(api.post).mockReset().mockResolvedValue({} as never);
  vi.mocked(sendDirectPayloadFanout).mockReset().mockResolvedValue({} as SendDirectBatchResponse);
  useChatStore.setState({ outgoingRemovalNotices: new Set() });
  vi.mocked(supportsE2EECalling).mockReturnValue(true);
  socket = { readyState: 1, send: vi.fn(), close: vi.fn(() => { Object.assign(socket, { readyState: 3 }); }) } as unknown as WebSocket;
  vi.mocked(createChatWebSocket).mockReturnValue(socket);
  vi.mocked(api.get).mockResolvedValue({ id: "chat", type: "group", members: [] } as never);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/chat/chat"]}><LocationProbe /><Routes><Route path="/chat/:conversationId" element={<Probe />} /><Route path="/call/:callId" element={null} /></Routes></MemoryRouter></QueryClientProvider>));
}
it("keeps removal notices scoped to their conversation and supports dismissal", async () => {
  useChatStore.getState().addOutgoingRemovalNotice("other-chat");
  await render();
  expect(state.outgoingRemoved).toBe(false);
  await act(async () => useChatStore.getState().addOutgoingRemovalNotice("chat"));
  expect(state.outgoingRemoved).toBe(true);
  await act(async () => state.dismissOutgoingRemoval());
  expect(state.outgoingRemoved).toBe(false);
  expect(useChatStore.getState().outgoingRemovalNotices).toEqual(new Set(["other-chat"]));
});
it("exposes unsupported calling without starting a call or capturing media", async () => {
  vi.mocked(supportsE2EECalling).mockReturnValue(false);
  vi.mocked(api.get).mockResolvedValue({ id: "chat", type: "direct", members: [] } as never);
  const getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  await render();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await state.handleStartCall("video"); });
  expect(state.callUnsupported).toBe(true);
  expect(state.callError).toBe(new E2EECallUnsupportedError().message);
  expect(api.post).not.toHaveBeenCalled();
  expect(getUserMedia).not.toHaveBeenCalled();
});
it("closes the chat socket and cancels the typing timeout when leaving", async () => {
  await render();
  vi.useFakeTimers();
  await act(async () => state.handleTyping());
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root.unmount());
  expect(socket.close).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  const sends = vi.mocked(socket.send).mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(socket.send).toHaveBeenCalledTimes(sends);
  root = createRoot(document.createElement("div"));
});
it("exposes invitation, rename and acceptance failures to the page", async () => {
  await render();
  vi.mocked(api.patch).mockRejectedValue(new Error("Permission denied"));
  await act(async () => { await state.handleUpdateInvitePolicy("admins_only"); });
  expect(state.notice).toBe("Failed to update invite policy\nPermission denied");
  expect(state.updatingInvitePolicy).toBe(false);
  await act(async () => state.setNewGroupName("New group"));
  await act(async () => { await state.handleRenameGroup(); });
  expect(state.notice).toBe("Failed to rename group\nPermission denied");
  expect(state.renamingGroup).toBe(false);
  vi.mocked(api.post).mockRejectedValue(new Error("Request failed"));
  await act(async () => { await state.handleAcceptRequest(); });
  expect(state.notice).toBe("Failed to accept request\nRequest failed");
});
it("waits for hook confirmation before removing a member and surfaces failures", async () => {
  await render();
  let action!: Promise<void>;
  await act(async () => { action = state.handleRemoveMember("bob"); });
  expect(api.delete).not.toHaveBeenCalled();
  expect(state.pendingConfirmation?.destructive).toBe(true);
  vi.mocked(api.delete).mockRejectedValue(new Error("Cannot remove member"));
  await act(async () => { state.pendingConfirmation!.onConfirm(); await action; });
  expect(api.delete).toHaveBeenCalledWith("/api/conversations/chat/members/bob");
  expect(state.pendingConfirmation).toBeNull();
  expect(state.notice).toBe("Failed to remove member\nCannot remove member");
});

it("does not schedule scroll work for an older-message load that finishes after unmount", async () => {
  await render();
  let resolve!: (value: never) => void;
  vi.mocked(loadOlderPersistedConversationMessages).mockReturnValue(new Promise((r) => { resolve = r; }));
  const frame = vi.spyOn(window, "requestAnimationFrame");
  let pending!: Promise<void>;
  await act(async () => { pending = state.handleLoadOlderCachedMessages(); });
  await act(async () => root.unmount());
  await act(async () => { resolve({ hasOlder: false } as never); await pending; });
  expect(frame).not.toHaveBeenCalled();
  frame.mockRestore();
  root = createRoot(document.createElement("div"));
});


it("round 4: delayed cleanup of A does not cancel a pending redial B", async () => {
  const { ensureSodium } = await import("@e2ee-chat/crypto");
  await ensureSodium();
  useCallStore.getState().setOutgoingCall({ callId: "A", conversationId: "chat", callType: "audio", initiatorId: "alice" });
  useCallStore.getState().updateCallStatus("A", "ended");
  vi.mocked(api.get).mockResolvedValue({ id: "chat", type: "direct", members: [] } as never);
  let resolve!: (value: never) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await render();
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  let pending!: Promise<void>;
  await act(async () => { pending = state.handleStartCall("audio"); });
  expect(state.startingCallType).toBe("audio");
  await act(async () => useCallStore.getState().clearCall("A"));
  await act(async () => {
    resolve({ call: { id: "B", conversationId: "chat", type: "audio", initiatorId: "alice", status: "ringing" }, created: true } as never);
    await pending;
  });
  expect(useCallStore.getState().activeCallId).toBe("B");
  expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "B", reason: "started" });
  expect(pathname).toBe("/call/B");
});


it("round 4: a local lock cancels the pending Start token before its response arrives", async () => {
  vi.mocked(api.get).mockResolvedValue({ id: "chat", type: "direct", members: [] } as never);
  let resolve!: (value: never) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await render();
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  let pending!: Promise<void>;
  await act(async () => { pending = state.handleStartCall("audio"); });
  expect(useCallStore.getState().pendingCallStart).not.toBeNull();
  const { clearRegisteredLocalCallState } = await import("../../platform/session-cleanup.js");
  await act(async () => clearRegisteredLocalCallState());
  await act(async () => {
    resolve({ call: { id: "B", conversationId: "chat", type: "audio", initiatorId: "alice", status: "ringing" }, created: true } as never);
    await pending;
  });
  expect(useCallStore.getState().pendingCallStart).toBeNull();
  expect(useCallStore.getState().localCallOwnership).toBeNull();
  expect(pathname).toBe("/chat/chat");
});


it.each(["resolve", "reject"])("round 5: lock during pending fanout cleans the created call immediately, before fanout %s", async (outcome) => {
  vi.mocked(api.get).mockResolvedValue({ id: "chat", type: "direct", members: [] } as never);
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/calls/initiate"
    ? { call: { id: "B", conversationId: "chat", type: "audio", initiatorId: "alice", status: "ringing" }, created: true } : {}) as never);
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  vi.mocked(sendDirectPayloadFanout).mockReturnValueOnce(new Promise<SendDirectBatchResponse>((yes, no) => { resolve = () => yes({} as SendDirectBatchResponse); reject = no; }));
  await render();
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  let pending!: Promise<void>;
  await act(async () => { pending = state.handleStartCall("audio"); });
  expect(savePendingCall).toHaveBeenCalledWith(expect.objectContaining({ id: "B" }));
  expect(sendDirectPayloadFanout).toHaveBeenCalledOnce();
  const { clearRegisteredLocalCallState } = await import("../../platform/session-cleanup.js");
  await act(async () => clearRegisteredLocalCallState());
  expect(deletePendingCall).toHaveBeenCalledWith("B");
  expect(api.post).toHaveBeenCalledWith("/api/calls/B/end");
  await act(async () => { if (outcome === "resolve") resolve(); else reject(new Error("Fanout cancelled")); await pending; });
  expect(useCallStore.getState().localCallOwnership).toBeNull();
  expect(pathname).toBe("/chat/chat");
  expect(vi.mocked(api.post).mock.calls.filter(([path]) => path.endsWith("/end"))).toHaveLength(1);
});

it("round 5: cancellation before any server call exists makes no end request", async () => {
  vi.mocked(api.get).mockResolvedValue({ id: "chat", type: "direct", members: [] } as never);
  let reject!: (error: Error) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((_yes, no) => { reject = no; }));
  await render();
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  let pending!: Promise<void>;
  await act(async () => { pending = state.handleStartCall("audio"); });
  const { clearRegisteredLocalCallState } = await import("../../platform/session-cleanup.js");
  await act(async () => clearRegisteredLocalCallState());
  await act(async () => { reject(new Error("Request cancelled before creation")); await pending; });
  expect(api.post).toHaveBeenCalledOnce();
  expect(api.post).toHaveBeenCalledWith("/api/calls/initiate", expect.anything());
  expect(deletePendingCall).not.toHaveBeenCalled();
  expect(savePendingCall).not.toHaveBeenCalled();
  expect(sendDirectPayloadFanout).not.toHaveBeenCalled();
});

it.each(["newer action", "sign-out"])("round 5: cancellation by %s cleans only the created call's key", async (reason) => {
  vi.mocked(api.get).mockResolvedValue({ id: "chat", type: "direct", members: [] } as never);
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/calls/initiate"
    ? { call: { id: "B", conversationId: "chat", type: "audio", initiatorId: "alice", status: "ringing" }, created: true } : {}) as never);
  let resolve!: () => void;
  vi.mocked(sendDirectPayloadFanout).mockReturnValueOnce(new Promise<SendDirectBatchResponse>((done) => { resolve = () => done({} as SendDirectBatchResponse); }));
  await render();
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  let pending!: Promise<void>;
  await act(async () => { pending = state.handleStartCall("audio"); });
  await act(async () => {
    if (reason === "sign-out") useAuthStore.setState({ user: null, sessionId: null, accessToken: null } as never);
    else {
      useCallStore.getState().clearCall("B");
      useCallStore.getState().setOutgoingCall({ callId: "C", conversationId: "chat", callType: "audio", initiatorId: "alice" });
    }
  });
  expect(deletePendingCall).toHaveBeenCalledWith("B");
  await act(async () => { resolve(); await pending; });
  const endCalls = vi.mocked(api.post).mock.calls.filter(([path]) => path.endsWith("/end"));
  if (reason === "sign-out") expect(endCalls).toHaveLength(0);
  else {
    expect(endCalls).toEqual([["/api/calls/B/end"]]);
    expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "C", reason: "started" });
    expect(deletePendingCall).not.toHaveBeenCalledWith("C");
  }
  expect(pathname).toBe("/chat/chat");
});

it("round 5: a key write finishing after cancellation cannot recreate the pending key", async () => {
  vi.mocked(api.get).mockResolvedValue({ id: "chat", type: "direct", members: [] } as never);
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/calls/initiate"
    ? { call: { id: "B", conversationId: "chat", type: "audio", initiatorId: "alice", status: "ringing" }, created: true } : {}) as never);
  let finishWrite!: () => void;
  vi.mocked(savePendingCall).mockReturnValueOnce(new Promise<void>((done) => { finishWrite = done; }));
  await render();
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  let pending!: Promise<void>;
  await act(async () => { pending = state.handleStartCall("audio"); });
  const { clearRegisteredLocalCallState } = await import("../../platform/session-cleanup.js");
  await act(async () => clearRegisteredLocalCallState());
  expect(deletePendingCall).toHaveBeenCalledWith("B");
  await act(async () => { finishWrite(); await pending; });
  expect(deletePendingCall).toHaveBeenCalledTimes(2);
  expect(sendDirectPayloadFanout).not.toHaveBeenCalled();
  expect(vi.mocked(api.post).mock.calls.filter(([path]) => path.endsWith("/end"))).toEqual([["/api/calls/B/end"]]);
});
