import { getByRole } from "@testing-library/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "../ui/index.js";
import { useAppUpdates } from "../features/updates/UpdateProvider.js";
import ChatListPage from "./ChatListPage.js";
import { api } from "../services/api.js";
import { fetchConversationList } from "../lib/conversation-cache.js";
import { setLocalePreference } from "../i18n/index.js";
vi.mock("../features/updates/UpdateProvider.js", () => ({ useAppUpdates: vi.fn(() => null) }));
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
  vi.clearAllMocks(); vi.mocked(useAppUpdates).mockReturnValue(null); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

it("places the update banner in the list column directly beneath the phone header and after the desktop scroll area", async () => {
  vi.mocked(useAppUpdates).mockReturnValue({
    kind: "desktop", ready: true, dismissed: false, deferred: false, installing: false,
    state: { status: "ready", update: { available: true, version: "0.1.1" } }, later: vi.fn(), install: vi.fn(),
  } as unknown as ReturnType<typeof useAppUpdates>);
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><AppShell list={<ChatListPage />} /></MemoryRouter></QueryClientProvider>));
  const banner = getByRole(container, "status", { name: "App update" });
  const column = getByRole(container, "complementary", { name: "Conversations" });
  expect(column.contains(banner)).toBe(true);
  const heading = getByRole(container, "heading", { name: "Chats", level: 1 });
  const wrapper = banner.parentElement!;
  expect(heading.closest("header")?.nextElementSibling).toBe(wrapper);
  expect(wrapper.className).toContain("sm:order-last");
  expect(wrapper.className).not.toMatch(/fixed|absolute/);
  expect(wrapper.parentElement?.querySelector(".overflow-y-auto")?.className).toContain("flex-1");
});

async function showConversationWithUpdate() {
  vi.mocked(useAppUpdates).mockReturnValue({
    kind: "desktop", ready: true, dismissed: false, deferred: false, installing: false,
    state: { status: "ready", update: { available: true, version: "0.1.1" } }, later: vi.fn(), install: vi.fn(),
  } as unknown as ReturnType<typeof useAppUpdates>);
  await act(async () => root.render(<QueryClientProvider client={client}>
    <MemoryRouter key="conversation" initialEntries={["/chat/existing"]}>
      <AppShell list={<ChatListPage />} detail={<p>Open conversation</p>} />
    </MemoryRouter>
  </QueryClientProvider>));
  return {
    column: container.querySelector("aside")!, main: container.querySelector("main")!,
    banner: getByRole(container, "status", { name: "App update" }),
  };
}
it("shows the update banner in the desktop sidebar while /chat/:id is open", async () => {
  const { column, main, banner } = await showConversationWithUpdate();
  // jsdom does not lay out media queries: check the shell's actual responsive rules.
  expect(column.className.split(/\s+/)).toContain("sm:flex");
  expect(column.contains(banner)).toBe(true);
  expect(main.contains(banner)).toBe(false);
  expect(banner.parentElement?.className).toContain("sm:order-last");
});
it("hides the update banner with the phone sidebar while /chat/:id is open", async () => {
  const { column, main, banner } = await showConversationWithUpdate();
  expect(column.className.split(/\s+/)).toContain("hidden");
  expect(column.contains(banner)).toBe(true);
  expect(main.className.split(/\s+/)).toContain("flex");
  expect(main.contains(banner)).toBe(false);
});

it("shows size without a metered hint for a desktop available update", async () => {
  vi.stubGlobal("navigator", { connection: { metered: true } });
  vi.mocked(useAppUpdates).mockReturnValue({
    kind: "desktop", ready: false, dismissed: false, deferred: false, installing: false,
    state: { status: "available", update: { available: true, version: "0.1.1", sizeBytes: 15900000 } },
    later: vi.fn(), download: vi.fn(),
  } as unknown as ReturnType<typeof useAppUpdates>);
  await act(async () => root.render(<QueryClientProvider client={client}>
    <MemoryRouter><AppShell list={<ChatListPage />} /></MemoryRouter>
  </QueryClientProvider>));
  const banner = getByRole(container, "status", { name: "App update" });
  expect(banner.querySelectorAll("p")[1].textContent).toBe("15.9 MB");
  expect(banner.textContent).not.toContain("metered");
});
