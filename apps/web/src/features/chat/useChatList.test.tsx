import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatList } from "./useChatList.js";
import { useShell } from "./useShell.js";
import { useChatStore } from "../../stores/chatStore.js";
import { refreshConversationList } from "../../lib/conversation-cache.js";
import { api } from "../../services/api.js";
vi.mock("../../stores/authStore.js", async () => { const { create } = await import("zustand"); return { useAuthStore: create(() => ({ user: { id: "alice" } })) }; });
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../../lib/conversation-cache.js", () => ({ CONVERSATIONS_QUERY_KEY: ["conversations"], fetchConversationList: async () => [], refreshConversationList: vi.fn() }));
let root: Root;
let state: ReturnType<typeof useChatList>;
function Probe() { state = useChatList(); return null; }
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); root = createRoot(document.createElement("div")); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><Probe /></MemoryRouter></QueryClientProvider>));
}
it("prevents two conversation creates from concurrent form submissions", async () => {
  vi.mocked(api.get).mockResolvedValue([{ id: "bob", username: "bob" }] as never);
  vi.mocked(api.post).mockResolvedValue({ id: "created" } as never);
  await render();
  await act(async () => state.setNewChatUsername("bob"));
  await act(async () => { await Promise.all([state.startNewChat(), state.startNewChat()]); });
  expect(api.get).toHaveBeenCalledWith("/api/users/search?q=bob&exact=1");
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(state.creatingChat).toBe(false);
});
it("reports accept and decline failures instead of rejecting event handlers", async () => {
  await render();
  vi.mocked(api.post).mockRejectedValue(new Error("Request failed"));
  await act(async () => { await state.respondToRequest("chat", "accept"); });
  expect(state.listError).toBe("Failed to respond to request\nRequest failed");
  await act(async () => { await state.respondToRequest("chat", "decline"); });
  expect(state.listError).toBe("Failed to respond to request\nRequest failed");
});

it("R2-unread: excludes a declined unread request while keeping remaining unread counts live", async () => {
  const previous = useChatStore.getState();
  const existing = { id: "existing" } as never;
  const request = { id: "request" } as never;
  let shell!: ReturnType<typeof useShell>;
  function ShellProbe() { state = useChatList(); shell = useShell(); return null; }
  useChatStore.setState({ conversations: [existing, request], unreadCounts: new Map([["existing", 2], ["request", 1]]) });
  vi.mocked(api.post).mockResolvedValue({} as never);
  vi.mocked(refreshConversationList).mockImplementation(async () => {
    useChatStore.getState().setConversations([existing]);
    return [existing];
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><ShellProbe /></MemoryRouter></QueryClientProvider>));
    expect(shell.unread).toBe(3);
    await act(async () => state.respondToRequest("request", "decline"));
    expect(api.post).toHaveBeenCalledWith("/api/conversations/request/decline");
    expect(useChatStore.getState().conversations).toEqual([existing]);
    expect(shell.unread).toBe(2);
    await act(async () => useChatStore.getState().incrementUnread("existing"));
    expect(shell.unread).toBe(3);
    await act(async () => useChatStore.getState().setConversations([]));
    expect(shell.unread).toBe(0);
  } finally {
    await act(async () => useChatStore.setState({ conversations: previous.conversations, unreadCounts: previous.unreadCounts }));
  }
});

it("shows the neutral privacy failure when group creation is rejected", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("One or more users are unavailable"));
  await render();
  await act(async () => state.setGroupMembers([{ id: "bob", username: "bob", displayName: "Bob", avatarUrl: null }]));
  await act(async () => { await state.startNewGroup(); });
  expect(state.newChatError).toBe("This person can't be added");
  expect(state.groupMembers).toHaveLength(1);
});

it.each(["bobbie", "Bob"])("does not start a chat with %s when bob is hidden or missing", async username => {
  vi.mocked(api.get).mockResolvedValue([{ id: "other", username }] as never);
  await render();
  await act(async () => state.setNewChatUsername("bob"));
  await act(async () => { await state.startNewChat(); });
  expect(state.newChatError).toBe("User not found");
  expect(api.post).not.toHaveBeenCalled();
});
