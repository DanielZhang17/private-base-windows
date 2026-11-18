import { act } from "react";
import { getByRole, queryByRole } from "@testing-library/dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../ui/index.js";
import ChatPage from "./ChatPage.js";
import { useConversation } from "../features/chat/useConversation.js";
import { useAuthStore } from "../stores/authStore.js";
import { capabilities } from "../platform/capabilities.js";
vi.mock("../features/chat/useConversation.js", () => ({ useConversation: vi.fn() }));
vi.mock("../components/chat/MessageInput.js", () => ({ default: ({ editing, editConflict }: { editing?: { id: string; content: string }; editConflict?: boolean }) =>
  <div data-testid="message-composer" data-editing={editing?.id} data-content={editing?.content} data-conflict={editConflict} /> }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it.each(["error", "loading"])("R3-F1: keeps cached history readable while conversation metadata is %s", async (state) => {
  vi.mocked(useConversation).mockReturnValue({
    conversationMessages: [{ id: "cached", content: "Cached message history", senderId: "alice", timestamp: 100 }],
    user: { id: "alice" }, conversationName: "Chat", outgoing: [],
    pendingConfirmation: null, notice: null,
    conversationError: state === "error" ? "Offline: metadata unavailable" : undefined,
    conversationLoading: state === "loading",
  } as never);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><ToastProvider><ChatPage /></ToastProvider></QueryClientProvider>));
  expect(container.textContent).toContain("Cached message history");
  expect(container.textContent).not.toContain("No messages yet");
  if (state === "error") expect(container.querySelector('[role="alert"]')?.textContent).toBe("Offline: metadata unavailable");
  else expect(container.querySelector('[role="status"][aria-label="Loading conversation"]')).not.toBeNull();
});

const renderFlow = async (state: Record<string, unknown>) => {
  vi.mocked(useConversation).mockReturnValue({ conversationMessages: [], outgoing: [], conversationName: "Mara", user: { id: "alice" }, ...state } as never);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><ToastProvider><ChatPage /></ToastProvider></QueryClientProvider>));
};
it.each([false, true])("shows local history guidance in an older empty conversation, with transfer gated (%s)", async historyTransfer => {
  const previous = capabilities.historyTransfer;
  capabilities.historyTransfer = historyTransfer;
  const navigate = vi.fn();
  try {
    await renderFlow({ showHistoryGuidance: true, navigate });
    const log = getByRole(container, "log", { name: "Messages" });
    expect(getByRole(log, "heading", { name: "No messages on this device yet" })).toBeTruthy();
    expect(log.textContent).toContain("Earlier messages stay on your other devices.");
    if (historyTransfer) {
      await act(async () => getByRole<HTMLButtonElement>(log, "button", { name: "Transfer history" }).click());
      expect(navigate).toHaveBeenCalledWith("/devices/transfer?mode=receive");
    } else expect(queryByRole(log, "button", { name: "Transfer history" })).toBeNull();
  } finally { capabilities.historyTransfer = previous; }
});

it("keeps the ordinary empty message view for a new conversation", async () => {
  await renderFlow({ showHistoryGuidance: false });
  expect(getByRole(container, "log").textContent).toContain("No messages yet. Say hello!");
  expect(container.textContent).not.toContain("Earlier messages stay on your other devices.");
});
it("attaches Retry and Discard for rejected edits to their respective bubbles", async () => {
  const discard = vi.fn();
  const retry = vi.fn();
  const edits = [{ id: "first", content: "First pending revision" }, { id: "second", content: "Second pending revision" }];
  await renderFlow({
    conversationMessages: edits.map((edit, i) => ({ ...edit, senderId: "alice", type: "text", timestamp: 100 + i, status: "sent" })),
    // Deliberately reverse the queue order relative to the bubbles.
    outgoing: edits.slice().reverse().map(({ id }) => ({ id: `edit-${id}`, editTargetId: id, status: "failed", retryable: false, sendDispatched: true })),
    retry, discard,
  });
  for (const { content } of edits) {
    const bubble = [...container.querySelectorAll("article")].find((article) => article.textContent?.includes(content));
    const actions = [...(bubble?.parentElement?.querySelector('[role="alert"]')?.querySelectorAll("button") ?? [])];
    expect(actions.map((button) => button.textContent)).toEqual(["Discard", "Retry"]);
    await act(async () => { actions[0].click(); actions[1].click(); });
  }
  expect(discard.mock.calls).toEqual([["edit-first"], ["edit-second"]]);
  expect(retry.mock.calls).toEqual([["edit-first"], ["edit-second"]]);
});
it.each([[1, "key", true], [null, "key", false], [1, undefined, false]])("checks membership (%s) and edit key (%s) before offering Edit", async (acceptedAt, editKey, editable) => {
  const owned = { id: "mine", conversationId: "chat", senderId: "alice", type: "text", content: "old text", timestamp: 1000,
    editKey, editSenderDeviceId: "alice-device", editKeyAccepted: !!editKey,
    expiresAt: Date.now() + 60000, expiryKind: "retention", status: "sent" };
  await renderFlow({
    deviceId: "alice-device",
    conversationId: "chat", conversation: { id: "chat", type: "direct", members: [{ userId: "alice", acceptedAt, user: { displayName: "Alice", username: "alice" } }] },
    conversationMessages: [owned, { ...owned, id: "peer", senderId: "bob", editedAt: 1001 }],
  });
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Message actions"]')];
  await act(async () => buttons[1].click());
  expect(document.body.querySelector('[aria-label="Edit message"]')).toBeNull();
  expect(container.textContent).toContain("Edited");
  const close = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  await act(async () => document.body.querySelector('[role="menu"]')!.dispatchEvent(close));
  await act(async () => buttons[0].click());
  const item = document.body.querySelector<HTMLButtonElement>('[aria-label="Edit message"]');
  if (!editable) {
    expect(item).toBeNull();
  } else {
    expect(item).not.toBeNull();
    await act(async () => item!.click());
    expect(container.querySelector('[data-testid="message-composer"]')?.getAttribute("data-editing")).toBe("mine");
  }
});
it("keeps the opened revision in the composer when sync updates its bubble", async () => {
  const owned = { id: "mine", conversationId: "chat", senderId: "alice", type: "text", content: "opened revision", timestamp: 1000,
    editSequence: 1, editSenderDeviceId: "alice-device", editKeyAccepted: true, status: "sent", expiresAt: Date.now() + 60000 };
  const state = {
    deviceId: "alice-device", conversationId: "chat",
    conversation: { id: "chat", type: "direct", members: [{ userId: "alice", acceptedAt: 1, user: { displayName: "Alice", username: "alice" } }] },
  };
  await renderFlow({ ...state, conversationMessages: [owned] });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Message actions"]')!.click());
  await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Edit message"]')!.click());
  await renderFlow({ ...state, conversationMessages: [{ ...owned, content: "latest revision", editSequence: 2 }] });
  const composer = container.querySelector('[data-testid="message-composer"]')!;
  expect(composer.getAttribute("data-editing")).toBe("mine");
  expect(composer.getAttribute("data-content")).toBe("opened revision");
  expect(composer.getAttribute("data-conflict")).toBe("true");
  expect(container.querySelector('[role="log"]')?.textContent).toContain("latest revision");
});

it("preserves the chat viewport and its scroll listener when the unlocked identity is repaired", async () => {
  const original = useAuthStore.getState();
  const messageListRef = { current: null as HTMLDivElement | null };
  const scroll = vi.fn();
  try {
    await act(async () => useAuthStore.setState({ user: null, device: { id: "device" }, sessionId: "session" } as never));
    await renderFlow({ messageListRef });
    const log = messageListRef.current!;
    log.scrollTop = 260;
    log.addEventListener("scroll", scroll);
    await act(async () => useAuthStore.setState({ user: { id: "alice" } } as never));
    expect(messageListRef.current).toBe(log);
    expect(log.scrollTop).toBe(260);
    messageListRef.current?.dispatchEvent(new Event("scroll"));
    expect(scroll).toHaveBeenCalledOnce();
  } finally { await act(async () => useAuthStore.setState(original)); }
});

it("keeps failed messages in the log with one-tap retry and queue discard", async () => {
  const retry = vi.fn(); const discard = vi.fn();
  await renderFlow({
    outgoing: [{ id: "failed", status: "failed", error: "Offline" }], retry, discard,
    conversationMessages: [{ id: "failed", senderId: "alice", type: "text", content: "Bringing the tide tables too", timestamp: 1000, status: "failed" }],
  });
  const log = container.querySelector('[role="log"]')!;
  expect(log.textContent).toContain("Bringing the tide tables too");
  expect(log.querySelector(".bubble-failed")).not.toBeNull();
  expect(log.querySelector("time")).toBeNull();
  await act(async () => log.querySelector<HTMLButtonElement>("button.bubble-failed")!.click());
  expect(retry).toHaveBeenCalledWith("failed");
  await act(async () => log.querySelector<HTMLButtonElement>('[aria-label="Failed message actions"]')!.click());
  const discardButton = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Discard")!;
  await act(async () => discardButton.click());
  expect(discard).toHaveBeenCalledWith("failed");
});
it("shows a rejected file as failed with its upload reason and Discard", async () => {
  const discard = vi.fn();
  await renderFlow({
    outgoing: [{ id: "failed-file", status: "failed", retryable: false, error: "This file couldn't be uploaded" }], discard,
    conversationMessages: [{ id: "failed-file", senderId: "alice", type: "file", content: JSON.stringify({ fileName: "installer.dmg" }), timestamp: 1000, status: "failed" }],
  });
  const log = container.querySelector('[role="log"]')!;
  expect(log.querySelector(".bubble-failed")?.textContent).toBe("installer.dmg");
  expect(log.textContent).toContain("Not sent");
  expect(log.textContent).not.toContain("Sending");
  expect(log.textContent).not.toContain("Encrypting");
  await act(async () => log.querySelector<HTMLButtonElement>('[aria-label="Failed message actions"]')!.click());
  const dialog = document.body.querySelector('[role="menu"]')!;
  expect(dialog.textContent).toContain("This file couldn't be uploaded");
  const discardButton = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Discard")!;
  await act(async () => discardButton.click());
  expect(discard).toHaveBeenCalledWith("failed-file");
});
it("shows a dismissible retirement notice without blocking the conversation composer", async () => {
  const dismissOutgoingRemoval = vi.fn();
  await renderFlow({ outgoingRemoved: true, dismissOutgoingRemoval });
  const notice = container.querySelector('[role="status"]')!;
  expect(notice.textContent).toContain("A message couldn't be sent and was removed.");
  expect(container.querySelector('[data-testid="message-composer"]')).not.toBeNull();
  await act(async () => notice.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click());
  expect(dismissOutgoingRemoval).toHaveBeenCalledOnce();
  await renderFlow({ outgoingRemoved: false });
  expect(container.textContent).not.toContain("A message couldn't be sent and was removed.");
});
it.each([
  { type: "text", content: "Bringing the tide tables too", name: "Bringing the tide tables too" },
  { type: "file", content: JSON.stringify({ fileName: "harbour-route.pdf", fileKey: "private-file-key", iv: "private-file-iv" }), name: "harbour-route.pdf" },
])("R2-accessibility: keeps failed $type content in the retry button's accessible name", async ({ type, content, name }) => {
  const retry = vi.fn();
  await renderFlow({
    outgoing: [{ id: "failed", status: "failed" }], retry,
    conversationMessages: [{ id: "failed", senderId: "alice", type, content, timestamp: 1000, status: "failed" }],
  });
  const bubble = container.querySelector<HTMLButtonElement>("button.bubble-failed")!;
  // aria-label supplies this control's accessible name, overriding its children.
  const accessibleName = bubble.getAttribute("aria-label");
  expect(accessibleName).toContain(name);
  expect(accessibleName).toMatch(/retry/i);
  expect(accessibleName).not.toContain("private-file-key");
  expect(accessibleName).not.toContain("private-file-iv");
  await act(async () => bubble.click());
  expect(retry).toHaveBeenCalledWith("failed");
});
it("hides the composer until a conversation request is accepted", async () => {
  const accept = vi.fn();
  await renderFlow({ isPendingRequest: true, handleAcceptRequest: accept });
  expect(container.querySelector('[data-testid="message-composer"]')).toBeNull();
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Accept")!;
  await act(async () => button.click()); expect(accept).toHaveBeenCalledOnce();
});
it("shows the clear unsupported-calls state", async () => {
  await renderFlow({ callUnsupported: true });
  expect(container.textContent).toContain("Encrypted calls aren't supported on this device");
});
it("shows the default unverified contact state in details and links to Verify", async () => {
  const navigate = vi.fn();
  await renderFlow({ directPeer: { userId: "mara", user: { displayName: "Mara" } }, navigate });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Conversation details"]')!.click());
  const dialog = document.body.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Not verified");
  const verify = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Verify")!;
  await act(async () => verify.click()); expect(navigate).toHaveBeenCalledWith("/verify/mara");
});
it("requires acknowledgement before permanently deleting a group", async () => {
  await renderFlow({ conversation: { id: "group", type: "group", name: "Field team", members: [] }, conversationName: "Field team", isGroupAdmin: true, showDeleteConfirm: true, setShowDeleteConfirm: vi.fn() });
  const dialog = document.body.querySelector('[role="alertdialog"]')!;
  const confirm = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Delete group")!;
  expect(confirm.disabled).toBe(true);
  await act(async () => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(confirm.disabled).toBe(false);
});
