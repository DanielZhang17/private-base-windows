import { fireEvent, getByRole, queryByRole, waitFor } from "@testing-library/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "../ui/index.js";
import { useAppUpdates } from "../features/updates/UpdateProvider.js";
import ChatListPage from "./ChatListPage.js";
import { useUnlockOfferHeld } from "../features/auth/unlockOfferGate.js";
import { api } from "../services/api.js";
import { fetchConversationList } from "../lib/conversation-cache.js";
import { setLocalePreference } from "../i18n/index.js";
import { useChatStore } from "../stores/chatStore.js";
import { getAppDB } from "../db/index.js";
import { importHistoryTransferItem } from "../db/history-transfer.js";
import { useAuthStore } from "../stores/authStore.js";
import { capabilities } from "../platform/capabilities.js";
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
it("uses the latest message visible to the signed-in account for the preview", async () => {
  const row = { conversationId: "existing", senderId: "peer", type: "text", status: "delivered", expiryKind: "retention",
    expiresAt: null, timestamp: 1 } as const;
  await act(async () => {
    useChatStore.getState().setMessages("existing", [
      { ...row, id: "own", ownerId: "alice", content: "Visible history" },
      { ...row, id: "foreign", ownerId: "bob", importedAt: 2, timestamp: 2, content: "Other account history" },
    ]);
  });
  expect(container.textContent).toContain("Visible history");
  expect(container.textContent).not.toContain("Other account history");
  await act(async () => { useChatStore.getState().setClearingHistory("existing", new Set(["own"])); });
  expect(container.textContent).not.toContain("Visible history");
  await act(async () => {
    const chat = useChatStore.getState();
    chat.addMessage("existing", { ...row, id: "own", ownerId: "alice", content: "", deletedAt: 3 });
    chat.setClearingHistory("existing");
  });
  expect(container.textContent).toContain("This message was deleted");
  await act(async () => { useChatStore.getState().removeConversationMessages("existing"); });
});
it("restores the latest imported direct-chat preview when the list mounts after reload", async () => {
  const now = Date.now();
  const conversation = { id: "copied", type: "direct", name: "Copied chat", avatarUrl: null,
    invitePolicy: "any_member", createdBy: "alice", createdAt: now, updatedAt: now,
    members: [{ conversationId: "copied", userId: "alice", role: "admin", acceptedAt: now, joinedAt: now,
      user: { username: "alice", displayName: "Alice", avatarUrl: null } }],
  } as const;
  const db = await getAppDB();
  try {
    await act(async () => { root.render(null); useChatStore.getState().removeConversationMessages("copied"); });
    await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation: { ...conversation, members: [...conversation.members] } } });
    await importHistoryTransferItem("alice", { entry: { kind: "message", message: { id: "copied-message", conversationId: "copied",
      senderId: "peer", type: "text", content: "Recovered preview", timestamp: now,
      expiresAt: now + 60_000, status: "delivered" } } });
    client.setQueryData(["conversations"], [conversation]);
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><ChatListPage /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await waitFor(() => expect(useChatStore.getState().messages.get("copied")).toHaveLength(1)); });
    expect(container.textContent).toContain("Recovered preview");

    const reads = vi.spyOn(db, "transaction");
    try {
      await act(async () => {
        client.setQueryData(["conversations"], [{ ...conversation, updatedAt: now + 1 }]);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(reads).not.toHaveBeenCalled();

      const added = { ...conversation, id: "newly-eligible", members: [{ ...conversation.members[0], conversationId: "newly-eligible" }] };
      await importHistoryTransferItem("alice", { entry: { kind: "conversation", conversation: added } });
      await importHistoryTransferItem("alice", { entry: { kind: "message", message: { id: "newly-eligible-message", conversationId: added.id,
        senderId: "peer", type: "text", content: "Newly eligible preview", timestamp: now, expiresAt: now + 60_000, status: "delivered" } } });
      reads.mockClear();
      await act(async () => {
        client.setQueryData(["conversations"], [conversation, added]);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await act(async () => { await waitFor(() => expect(useChatStore.getState().messages.get(added.id)).toHaveLength(1)); });
      expect(reads.mock.calls.filter(([stores]) => Array.isArray(stores) && stores.includes("displayMessages"))).toHaveLength(1);
    } finally { reads.mockRestore(); }
  } finally {
    await db.clear("accountConversations");
    await db.clear("displayMessages");
    await db.clear("accountState");
    await act(async () => {
      useChatStore.getState().removeConversationMessages("copied");
      useChatStore.getState().removeConversationMessages("newly-eligible");
    });
  }
});

it("shows the account-empty state when a linked device has no conversations", async () => {
  try {
    await act(async () => {
      useAuthStore.setState({ device: { linkMethod: "passkey" } as ReturnType<typeof useAuthStore.getState>["device"] });
      client.setQueryData(["conversations"], []);
      root.render(<QueryClientProvider client={client}><MemoryRouter key="empty"><ChatListPage /></MemoryRouter></QueryClientProvider>);
    });
    expect(getByRole(container, "heading", { name: "No conversations yet" })).toBeTruthy();
    expect(getByRole(container, "button", { name: "Start a conversation" })).toBeTruthy();
    expect(container.textContent).not.toContain("Earlier messages stay on your other devices.");
  } finally {
    await act(async () => useAuthStore.setState({ device: null }));
  }
});

it.each([false, true])("guides a linked device with older conversations to receive history when enabled (%s)", async enabled => {
  const previous = capabilities.historyTransfer;
  capabilities.historyTransfer = enabled;
  const now = Date.now();
  const Location = () => { const { pathname, search } = useLocation(); return <output>{pathname}{search}</output>; };
  try {
    await act(async () => {
      useAuthStore.setState({ device: { linkMethod: "passkey", activatedAt: now } as ReturnType<typeof useAuthStore.getState>["device"] });
      client.setQueryData(["conversations"], [
        { ...conversations[0], createdAt: now - 1000, members: [{ userId: "alice", joinedAt: now - 1000, acceptedAt: now - 1000 }] },
      ]);
      root.render(<QueryClientProvider client={client}><MemoryRouter><Location /><ChatListPage /></MemoryRouter></QueryClientProvider>);
    });
    expect(container.textContent).toContain("Earlier messages stay on your other devices.");
    const action = queryByRole<HTMLButtonElement>(container, "button", { name: "Transfer history" });
    if (enabled) {
      await act(async () => action!.click());
      expect(container.querySelector("output")?.textContent).toBe("/devices/transfer?mode=receive");
    } else expect(action).toBeNull();
  } finally {
    capabilities.historyTransfer = previous;
    await act(async () => useAuthStore.setState({ device: null }));
  }
});
it("lets the user close the other-devices history notice, remembered per linked device", async () => {
  const now = Date.now();
  const previous = capabilities.historyTransfer;
  capabilities.historyTransfer = true;
  const linked = (id: string) => ({ id, linkMethod: "passkey", activatedAt: now }) as ReturnType<typeof useAuthStore.getState>["device"];
  let held: boolean | undefined;
  function Probe() { held = useUnlockOfferHeld(); return null; }
  const page = () => <QueryClientProvider client={client}><MemoryRouter><ChatListPage /><Probe /></MemoryRouter></QueryClientProvider>;
  const notice = "Earlier messages stay on your other devices.";
  try {
    await act(async () => {
      useAuthStore.setState({ device: linked("phone-1") });
      client.setQueryData(["conversations"], [
        { ...conversations[0], createdAt: now - 1000, members: [{ userId: "alice", joinedAt: now - 1000, acceptedAt: now - 1000 }] },
      ]);
      root.render(page());
    });
    expect(container.textContent).toContain(notice);
    expect(held).toBe(true); // the unlock offer waits while the new device is still setting up
    // The transfer action has its own row, apart from the close button.
    const transfer = getByRole(container, "button", { name: "Transfer history" });
    const close = getByRole(container, "button", { name: "Dismiss" });
    expect(transfer.parentElement).not.toBe(close.parentElement);
    await act(async () => close.click());
    expect(container.textContent).not.toContain(notice);
    expect(localStorage.getItem("pb.historyGuidanceDismissed:phone-1")).toBe("1");
    expect(held).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(page()));
    expect(container.textContent).toContain("Existing chat");
    expect(container.textContent).not.toContain(notice);
    // A relinked device (new device ID) gets its own guidance again.
    await act(async () => useAuthStore.setState({ device: linked("phone-2") }));
    expect(container.textContent).toContain(notice);
  } finally {
    capabilities.historyTransfer = previous;
    localStorage.removeItem("pb.historyGuidanceDismissed:phone-1");
    await act(async () => useAuthStore.setState({ device: null }));
  }
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

it("requests an exact group name and shows neutral confirmation without opening a chat", async () => {
  await act(async () => { await setLocalePreference("en"); });
  vi.mocked(api.post).mockResolvedValue({ submitted: true } as never);
  await act(async () => getByRole<HTMLButtonElement>(container, "button", { name: "New Chat" }).click());
  await act(async () => getByRole<HTMLButtonElement>(document.body, "button", { name: "Request to join a group" }).click());
  const dialog = getByRole(document.body, "dialog", { name: "Request to join a group" });
  const submit = getByRole<HTMLButtonElement>(dialog, "button", { name: "Send request" });
  expect(submit.disabled).toBe(true);
  await act(async () => { fireEvent.change(getByRole(dialog, "textbox", { name: /group name/i }), { target: { value: "  Study Group  " } }); });
  await act(async () => submit.click());
  expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/conversations/join-by-name", { name: "Study Group" });
  expect(dialog.textContent).toContain("If the group accepts requests and you’re eligible, an admin will review your request.");
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
