import { act } from "react";
import { getByRole, queryByRole, waitFor } from "@testing-library/dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../ui/index.js";
import ChatPage from "./ChatPage.js";
import { useConversation } from "../features/chat/useConversation.js";
import { useAuthStore } from "../stores/authStore.js";
import { capabilities } from "../platform/capabilities.js";
import { api } from "../services/api.js";
import { getMessageById, saveMessage, saveOutgoing } from "../db/index.js";
import * as outgoingQueue from "../features/chat/outgoingQueue.js";
import { click, press } from "../ui/test-utils.js";
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

const selectionRows = [
  { id: "peer", conversationId: "chat", senderId: "mara", type: "text", content: "An earlier message", timestamp: 1000, status: "delivered" },
  { id: "own", conversationId: "chat", senderId: "alice", type: "text", content: "A later message", timestamp: 2000, status: "sent" },
];
function selectionFlow(rows = selectionRows) {
  return { conversationId: "chat", conversationMessages: rows.map((message) => ({ ...message, expiresAt: Date.now() + 600_000 })),
    conversation: { id: "chat", type: "direct", members: [
      { userId: "alice", acceptedAt: 1, user: { displayName: "Alice" } }, { userId: "mara", acceptedAt: 1, user: { displayName: "Mara" } },
    ] } };
}
async function selectFromMenu(content: string) {
  const article = [...container.querySelectorAll("article")].find((row) => row.textContent?.includes(content))!;
  const menu = getByRole<HTMLButtonElement>(article, "button", { name: "Message actions" });
  menu.focus();
  await click(menu);
  await click(getByRole(document.body, "menuitem", { name: "Select" }));
}

it("enters selection from the menu, announces the count and disabled reason, and honors Escape", async () => {
  await renderFlow(selectionFlow());
  await selectFromMenu("A later message");
  const own = getByRole(container, "checkbox", { name: /A later message/, checked: true });
  expect(document.activeElement).toBe(own);
  expect(getByRole(container, "status").textContent).toBe("Selected (1)");
  const everyone = getByRole<HTMLButtonElement>(container, "button", { name: "Delete for everyone" });
  expect(everyone.hasAttribute("aria-disabled")).toBe(false);
  // The checkbox is a native button and receives the browser's activation click on Space.
  const peer = getByRole(container, "checkbox", { name: /An earlier message/, checked: false });
  peer.focus();
  await press(" ");
  await click(peer);
  expect(getByRole(container, "status").textContent).toBe("Selected (2)");
  expect(everyone.getAttribute("aria-disabled")).toBe("true");
  const scopes = getByRole(container, "group", { name: "Selected message actions" });
  expect(scopes.tabIndex).toBe(0);
  expect(document.getElementById(scopes.getAttribute("aria-describedby")!)?.textContent).toBe("Deselect received messages to delete for everyone.");
  const scroll = vi.fn();
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scroll, configurable: true });
  try {
    await press("Escape");
    expect(queryByRole(container, "checkbox")).toBeNull();
    expect(document.activeElement).toBe(getByRole(container.querySelector('[data-message-id="own"]')!, "button", { name: "Message actions" }));
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

it.each(["hold", "native contextmenu"])("opens the phone sheet on %s and requires a fresh tap on Select", async (trigger) => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    await renderFlow(selectionFlow());
    const bubble = container.querySelector(".bubble-own")!;
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(down, { pointerType: { value: "touch" }, isPrimary: { value: true }, pointerId: { value: 5 } });
    await act(async () => {
      if (trigger === "hold") { bubble.dispatchEvent(down); vi.advanceTimersByTime(500); }
      else {
        const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        Object.defineProperty(context, "pointerType", { value: "touch" });
        bubble.dispatchEvent(context);
      }
    });
    const sheet = getByRole(document.body, "dialog", { name: "Message actions" });
    expect(getByRole(sheet, "menuitem", { name: "Copy text" })).toBeTruthy();
    expect(getByRole(sheet, "menuitem", { name: "Delete for everyone" })).toBeTruthy();
    expect(queryByRole(container, "checkbox")).toBeNull();
    const select = getByRole(sheet, "menuitem", { name: "Select" });
    await act(async () => sheet.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true })));
    await click(select);
    expect(queryByRole(document.body, "menu")).toBeTruthy();
    await act(async () => select.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await click(select);
    expect(queryByRole(document.body, "menu")).toBeNull();
    expect(getByRole(container, "checkbox", { name: /A later message/, checked: true })).toBeTruthy();
    expect(getByRole(container, "status").textContent).toBe("Selected (1)");
    const peer = getByRole(container, "checkbox", { name: /An earlier message/, checked: false });
    await act(async () => peer.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await click(peer.closest("article")!);
    expect(getByRole(container, "status").textContent).toBe("Selected (2)");
    for (const row of container.querySelectorAll("article")) {
      expect(row.className).toContain("grid-cols-[44px_minmax(0,1fr)]");
      expect(row.firstElementChild?.getAttribute("role")).toBe("checkbox");
    }
    const bar = getByRole(container, "group", { name: "Selected message actions" });
    expect(bar.dataset.callAvoid).toBe("bottom");
    expect(bar.classList.contains("pb-safe")).toBe(true);
    expect(getByRole(bar, "button", { name: "Copy" })).toBeTruthy();
    const remove = getByRole(bar, "button", { name: "Delete…" });
    expect(container.querySelector("header")!.contains(remove)).toBe(false);
    await click(remove);
    const dialog = getByRole(document.body, "alertdialog", { name: "Delete 2 messages from this device?" });
    expect(dialog.textContent).toContain("Other participants will still see them.");
    const group = getByRole(dialog, "radiogroup", { name: "Who should this delete for?" });
    expect(getByRole(group, "radio", { name: "This device only", checked: true })).toBeTruthy();
    expect(getByRole<HTMLInputElement>(group, "radio", { name: "Everyone in this chat" }).disabled).toBe(true);
    expect(getByRole(dialog, "button", { name: "Delete messages" }).classList.contains("bg-danger")).toBe(true);
    expect(group.querySelector("button")).toBeNull();
    expect(document.getElementById(group.getAttribute("aria-describedby")!)?.textContent).toContain("Deselect received messages");
    expect(document.activeElement).toBe(getByRole(dialog, "button", { name: "Cancel" }));
    await press("Escape");
    expect(document.activeElement).toBe(remove);
    await click(peer);
    await click(remove);
    await click(getByRole(document.body, "radio", { name: "Everyone in this chat" }));
    expect(getByRole(document.body, "radio", { name: "Everyone in this chat", checked: true })).toBeTruthy();
    expect(getByRole(document.body, "alertdialog", { name: "Delete 1 message for everyone?" }).textContent).toContain("This cannot be undone.");
    await click(getByRole(document.body, "button", { name: "Cancel" }));
    await click(getByRole(container, "button", { name: "Cancel selection" }));
    expect(queryByRole(container, "checkbox")).toBeNull();
  } finally { vi.useRealTimers(); }
});

it("keeps focus on a connected control outside the chat when pruning ends selection", async () => {
  const search = document.createElement("input");
  document.body.append(search);
  try {
    await renderFlow(selectionFlow());
    await selectFromMenu("A later message");
    search.focus();
    await renderFlow(selectionFlow(selectionRows.slice(0, 1)));
    expect(queryByRole(container, "checkbox")).toBeNull();
    expect(document.activeElement).toBe(search);
  } finally { search.remove(); }
});

it("explains unsent and mixed local deletes and reports the skipped count inside the dialog", async () => {
  const prior = useAuthStore.getState();
  try {
    useAuthStore.setState({ user: { id: "alice" } as never, device: { id: "device" } as never, sessionId: "ui-partial" });
    const outgoing = { ...selectionRows[1], id: "partial-sending", status: "sending" as const, timestamp: Date.now(), expiresAt: Date.now() + 60_000 };
    const incoming = { ...selectionRows[0], id: "partial-peer", timestamp: outgoing.timestamp - 1000, expiresAt: outgoing.expiresAt };
    await saveMessage(outgoing, undefined, "alice");
    await saveMessage(incoming, undefined, "alice");
    await saveOutgoing({ id: outgoing.id, userId: "alice", deviceId: "device", conversationId: "chat", conversationType: "group", queuedAt: 1,
      ttlSeconds: null, status: "sending", attempts: 1, retryable: true, nextAttemptAt: null, error: null, sendDispatched: true,
      steps: [{ path: "/api/messages/send", sendDispatched: true, body: { id: outgoing.id, conversationId: "chat", type: "text", ciphertext: "opaque", iv: "iv", header: "{}" } }] });
    await renderFlow(selectionFlow([incoming, outgoing]));
    await selectFromMenu("A later message");
    await click(getByRole(container, "button", { name: "Delete for me" }));
    const queued = getByRole(document.body, "alertdialog", { name: "Delete 1 message from this device?" });
    expect(queued.textContent).toContain("Unsent messages in the selection will be discarded.");
    expect(queued.textContent).not.toContain("Other participants");
    await click(getByRole(queued, "button", { name: "Cancel" }));
    await click(getByRole(container, "checkbox", { name: /An earlier message/ }));
    await click(getByRole(container, "button", { name: "Delete for me" }));
    const confirm = getByRole(document.body, "alertdialog", { name: "Delete 2 messages from this device?" });
    expect(confirm.textContent).toContain("Other participants will still see messages that were already sent.");
    await click(getByRole(confirm, "button", { name: "Delete messages" }));
    const result = await waitFor(() => getByRole(document.body, "alertdialog", { name: "Delete result" }));
    expect(result.textContent).toContain("Skipped 1 message because it was already sending or had been sent. It may still be delivered.");
    expect(queryByRole(result, "button", { name: "Delete messages" })).toBeNull();
    const continueButton = getByRole(result, "button", { name: "Continue" });
    expect(document.activeElement).toBe(continueButton);
    expect(await getMessageById(incoming.id, "alice")).toBeUndefined();
    expect(await getMessageById(outgoing.id, "alice")).toMatchObject({ content: outgoing.content });
    await click(continueButton);
    expect(queryByRole(document.body, "alertdialog")).toBeNull();
    expect(getByRole(container, "checkbox", { name: /A later message/, checked: true })).toBeTruthy();
    expect(getByRole(container, "status").textContent).toBe("Selected (1)");
  } finally { await act(async () => useAuthStore.setState(prior)); }
});

it("opens Select on desktop right-click and restores focus to the nearest remaining row", async () => {
  await renderFlow(selectionFlow());
  const bubble = container.querySelector(".bubble-own")!;
  await act(async () => bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await click(getByRole(document.body, "menuitem", { name: "Select" }));
  expect(getByRole(container, "checkbox", { name: /A later message/, checked: true })).toBeTruthy();
  await renderFlow(selectionFlow(selectionRows.slice(0, 1)));
  expect(document.activeElement).toBe(getByRole(container, "button", { name: "Message actions" }));
});

it.each(["confirmation", "result"] as const)("restores focus after the delete %s closes with no selected rows left", async (phase) => {
  const prior = useAuthStore.getState();
  let finish!: (result: Awaited<ReturnType<typeof outgoingQueue.discardAndHideMessages>>) => void;
  const discard = vi.spyOn(outgoingQueue, "discardAndHideMessages").mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  try {
    useAuthStore.setState({ user: { id: "alice" } as never, device: { id: "device" } as never, sessionId: "ui-focus" });
    await renderFlow(selectionFlow());
    await selectFromMenu("A later message");
    const opener = getByRole(container, "button", { name: "Delete for me" });
    opener.focus();
    await click(opener);
    const confirm = getByRole(document.body, "alertdialog");
    await click(getByRole(confirm, "button", { name: "Delete messages" }));
    expect(discard).toHaveBeenCalledOnce();
    if (phase === "result") {
      await act(async () => finish({ discarded: false, alreadySending: ["own"] }));
      expect(getByRole(document.body, "alertdialog", { name: "Delete result" })).toBeTruthy();
    }
    await renderFlow(selectionFlow(selectionRows.slice(0, 1)));
    expect(queryByRole(container, "checkbox")).toBeNull();
    expect(opener.isConnected).toBe(false);
    expect(getByRole(document.body, "alertdialog")).toBe(confirm);
    const actions = getByRole(container, "button", { name: "Message actions" });
    expect(document.activeElement).not.toBe(actions);
    if (phase === "confirmation") await act(async () => finish({ discarded: true, alreadySending: [] }));
    else await click(getByRole(confirm, "button", { name: "Continue" }));
    expect(queryByRole(document.body, "alertdialog")).toBeNull();
    expect(document.activeElement).toBe(actions);
  } finally {
    discard.mockRestore();
    await act(async () => useAuthStore.setState(prior));
  }
});

it("copies from the header and requires confirmation before deleting for everyone", async () => {
  const prior = useAuthStore.getState();
  const writeText = vi.fn().mockResolvedValue(undefined);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const post = vi.spyOn(api, "post").mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ deletions: [] });
  try {
    useAuthStore.setState({ user: { id: "alice" } as never, device: { id: "device" } as never, sessionId: "ui-session" });
    await renderFlow(selectionFlow());
    await selectFromMenu("A later message");
    await click(getByRole(container, "checkbox", { name: /An earlier message/ }));
    await click(getByRole(container, "button", { name: "Copy selected" }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toMatch(/^Mara · [^\n]+\nAn earlier message\n\nAlice · [^\n]+\nA later message$/);
    expect(queryByRole(container, "checkbox")).toBeNull();
    const copied = container.querySelector("[data-selection-copy-toast]")!;
    expect(copied.textContent).toBe("2 messages copied");
    expect(container.querySelector('[aria-live="polite"].sr-only')?.textContent).toBe("2 messages copied");
    const composer = container.querySelector('[data-testid="message-composer"]')!;
    expect(composer.closest("[hidden]")).toBeNull();
    expect(copied.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await selectFromMenu("A later message");
    const remove = getByRole(container, "button", { name: "Delete for everyone" });
    remove.focus();
    await click(remove);
    expect(post).not.toHaveBeenCalled();
    await press("Escape");
    expect(document.activeElement).toBe(remove);
    await click(remove);
    const confirm = getByRole(document.body, "alertdialog", { name: "Delete 1 message for everyone?" });
    await click(getByRole(confirm, "button", { name: "Delete messages" }));
    expect(getByRole(confirm, "alert").textContent).toBe("Could not delete the message. Try again.");
    await click(getByRole(confirm, "button", { name: "Delete messages" }));
    await waitFor(() => expect(post).toHaveBeenNthCalledWith(2, "/api/messages/delete-batch", { conversationId: "chat", ids: ["own"], fileIds: {} }));
  } finally {
    await act(async () => useAuthStore.setState(prior));
    post.mockRestore();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
