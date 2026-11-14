import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ChatListPage from "./ChatListPage.js";
import { api } from "../services/api.js";
import { fetchConversationList } from "../lib/conversation-cache.js";
import { setLocalePreference } from "../i18n/index.js";
vi.mock("../stores/authStore.js", async () => { const { create } = await import("zustand"); return { useAuthStore: create(() => ({ user: { id: "alice" } })) }; });
vi.mock("../services/api.js", () => ({ api: { post: vi.fn() } }));
vi.mock("../lib/conversation-cache.js", () => ({ CONVERSATIONS_QUERY_KEY: ["conversations"], fetchConversationList: vi.fn(), refreshConversationList: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const conversations = [
  { id: "existing", type: "group", name: "Existing chat", members: [{ userId: "alice", acceptedAt: 1 }] },
  { id: "request", type: "group", name: "Invitation", members: [{ userId: "alice", acceptedAt: null }] },
];
const button = (label: string) => Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === label)!;
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  client.setQueryData(["conversations"], conversations);
  vi.mocked(fetchConversationList).mockResolvedValue(conversations as never);
  container = document.createElement("div"); root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><ChatListPage /></MemoryRouter></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it("keeps the Chats route title localized when switching to French", async () => {
  expect(document.title).toBe("Chats · Private Base");
  await act(async () => { await setLocalePreference("fr"); });
  expect(document.title).toBe("Discussions · Private Base");
});
it("F7: keeps cached chats and request actions available and lets the user dismiss action errors", async () => {
  vi.mocked(api.post).mockRejectedValue(new Error("Accept failed"));
  await act(async () => button("Accept").click());
  expect(container.textContent).toContain("Accept failed");
  expect(container.textContent).toContain("Existing chat");
  expect(button("Accept")).toBeDefined();
  await act(async () => button("Dismiss").click());
  expect(container.textContent).not.toContain("Accept failed");
  expect(container.textContent).toContain("Existing chat");
});
it("F7: clears action errors on retry and on successful background refetch", async () => {
  vi.mocked(api.post).mockRejectedValue(new Error("Decline failed"));
  await act(async () => button("Decline").click());
  expect(container.textContent).toContain("Decline failed");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await act(async () => { await client.refetchQueries({ queryKey: ["conversations"] }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  expect(container.textContent).not.toContain("Decline failed");
  await act(async () => button("Decline").click());
  expect(container.textContent).toContain("Decline failed");
  vi.mocked(api.post).mockResolvedValue({} as never);
  await act(async () => button("Decline").click());
  expect(container.textContent).not.toContain("Decline failed");
  expect(container.textContent).toContain("Existing chat");
});
