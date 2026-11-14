import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConversation } from "./useConversation.js";
import { api } from "../../services/api.js";
import { loadOlderPersistedConversationMessages } from "../../lib/message-sync.js";
import { createChatWebSocket } from "../../services/ws.js";
import { supportsE2EECalling } from "../../services/webrtc.js";
import { E2EECallUnsupportedError } from "../../platform/calls.js";
import { useChatStore } from "../../stores/chatStore.js";

vi.mock("./useSendMessage.js", () => ({ useSendMessage: () => ({ outgoing: [], handleSend: vi.fn(), handleSendFile: vi.fn() }) }));
vi.mock("../../stores/authStore.js", async () => { const { create } = await import("zustand"); return { useAuthStore: create(() => ({ user: { id: "alice" } })) }; });
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn() } }));
vi.mock("../../services/ws.js", () => ({ createChatWebSocket: vi.fn() }));
vi.mock("../../services/webrtc.js", () => ({ supportsE2EECalling: vi.fn(() => true) }));
vi.mock("../../lib/message-sync.js", () => ({ loadPersistedConversationMessages: async () => ({ hasOlder: false }), syncConversationMessages: vi.fn(), ingestMessageFrame: vi.fn(), loadOlderPersistedConversationMessages: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ upsertConversationInCache: vi.fn(), refreshConversationList: vi.fn() }));
vi.mock("../../db/index.js", () => ({ saveMessage: vi.fn() }));
let root: Root;
let state: ReturnType<typeof useConversation>;
let socket: WebSocket;
function Probe() { state = useConversation(); return null; }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/chat/chat"]}><Routes><Route path="/chat/:conversationId" element={<Probe />} /></Routes></MemoryRouter></QueryClientProvider>));
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
