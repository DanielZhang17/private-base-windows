import { act, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import { getAllByRole, getByRole, queryByRole, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DecryptedMessage } from "@e2ee-chat/shared";
import MessageBubble from "./MessageBubble.js";
import { ToastProvider } from "../../ui/index.js";
import { click, press, setupDom } from "../../ui/test-utils.js";
import { getAppDB, messageHideKey, getMessageById, saveMessage as writeOwnedMessage } from "../../db/index.js";
import { useChatStore } from "../../stores/chatStore.js";
import { useAuthStore } from "../../stores/authStore.js";
import { api } from "../../services/api.js";
import { discardOutgoing } from "../../features/chat/outgoingQueue.js";
import type { FilePreviewActions } from "./FilePreview.js";
import type { Ref } from "react";
import { mockSpriteIO, spriteBase, spriteResponse } from "../../features/stickers/pack-assets.test-utils.js";
import { StickerProvider, useStickerPicker } from "../../features/stickers/useStickerPicker.js";
import { capabilities } from "../../platform/capabilities.js";
import * as format from "../../i18n/format.js";

const saveMessage = (row: Parameters<typeof writeOwnedMessage>[0], current?: () => boolean, ownerId = row.ownerId ?? "alice") =>
  writeOwnedMessage(row, current, ownerId);

vi.mock("./InlineEmojiText.js", () => ({ default: ({ content }: { content: string }) => <span>{content}</span> }));
const openFile = vi.fn();
const saveFile = vi.fn();
let showFilePortal = false;
let reportSaveUnsupported: ((unsupported: boolean) => void) | undefined;
vi.mock("./FilePreview.js", () => ({ default: ({ actionsRef, onSaveUnsupportedChange }: { actionsRef: Ref<FilePreviewActions>; onSaveUnsupportedChange?: (unsupported: boolean) => void }) => {
  reportSaveUnsupported = onSaveUnsupportedChange;
  useImperativeHandle(actionsRef, () => ({ open: openFile, save: saveFile }));
  return <><button onClick={openFile}>Attachment</button>
    {showFilePortal && createPortal(<button type="button">File viewer control</button>, document.body)}
  </>;
} }));
vi.mock("../../services/api.js", () => ({ api: { delete: vi.fn() } }));
vi.mock("../../features/chat/outgoingQueue.js", () => ({ discardOutgoing: vi.fn() }));
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "alice" }, device: { id: "device" }, sessionId: "session" })) };
});
const dom = setupDom();
let spriteIO: ReturnType<typeof mockSpriteIO>;
beforeEach(() => { spriteIO = mockSpriteIO({ catalog: true }); });
const message: DecryptedMessage = { id: "message", conversationId: "conv", senderId: "alice", type: "text", content: "Private text", timestamp: 100, expiresAt: Date.now() + 60_000, expiryKind: "retention", status: "sent" };
const fileContent = JSON.stringify({ fileId: "file", fileName: "notes.txt", mimeType: "text/plain", fileKey: "secret", iv: "secret-iv" });
async function render(overrides: Partial<DecryptedMessage> = {}, own = true) {
  await dom.render(<ToastProvider><MessageBubble message={{ ...message, ...overrides }} isOwn={own} onRetry={vi.fn()} onDiscard={overrides.status === "sending" || overrides.status === "failed" ? vi.fn() : undefined} /></ToastProvider>);
}

it.each([true, false])("marks optimistic edits as pending until committed, including grouped bubbles (showMeta=%s)", async (showMeta) => {
  const update = (pendingEdit: DecryptedMessage["pendingEdit"], content: string) =>
    dom.render(<ToastProvider><MessageBubble message={{ ...message, status: "delivered", editedAt: 10, pendingEdit, content }} isOwn showMeta={showMeta} /></ToastProvider>);
  await update({ id: "edit", content: "Next revision" }, "Prior revision");
  const article = () => getByRole(dom.container(), "article");
  expect(article().textContent).toContain("Next revision");
  expect(article().textContent).toContain("Edit pending");
  expect(article().textContent).not.toContain("Edited");
  expect(article().textContent).not.toContain("Delivered");
  expect(article().getAttribute("aria-label")).toContain("Edit pending");

  await update(null, "Next revision");
  expect(article().textContent).toContain("Edited");
  expect(article().textContent).not.toContain("Edit pending");
  expect(article().textContent?.includes("Delivered")).toBe(showMeta);
});
function pointer(type: string, x = 10, y = 10) {
  return act(async () => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerType: { value: "touch" }, isPrimary: { value: true } });
    dom.container().querySelector(".message-action-surface")!.dispatchEvent(event);
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "alice" }, device: { id: "device" }, sessionId: crypto.randomUUID() } as never);
  const db = await getAppDB();
  await Promise.all(Array.from(db.objectStoreNames, (name) => db.clear(name)));
  useChatStore.setState({ messages: new Map() });
});
afterEach(() => vi.restoreAllMocks());
it("suppresses native right-click, positions the desktop menu, and supports arrow navigation and Escape", async () => {
  await render();
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 140 });
  await act(async () => dom.container().querySelector(".bubble")!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  const menu = getByRole(document.body, "menu");
  expect(menu.parentElement?.style.left).toBe("116px");
  expect(document.activeElement).toBe(menu);
  await press("ArrowDown"); expect(document.activeElement?.getAttribute("aria-label")).toBe("Copy text");
  await press("ArrowDown"); expect(document.activeElement?.getAttribute("aria-label")).toBe("Delete for me");
  await press("End"); expect(document.activeElement?.getAttribute("aria-label")).toBe("Delete for everyone");
  await press("Home"); expect(document.activeElement?.textContent).toBe("Copy text");
  await press("Escape"); expect(queryByRole(document.body, "menu")).toBeNull();
});
it("offers the same menu from the keyboard-accessible more button and restores focus", async () => {
  await render();
  const button = getByRole(document.body, "button", { name: "Message actions" });
  button.focus();
  expect(button.getAttribute("aria-haspopup")).toBe("menu");
  await click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  await press("Escape"); expect(document.activeElement).toBe(button);
});
it("opens at 500ms with a light haptic and consumes the subsequent file click", async () => {
  vi.useFakeTimers();
  const vibrate = vi.fn(); Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
  await render({ type: "file", content: fileContent });
  await pointer("pointerdown");
  await act(async () => vi.advanceTimersByTime(499));
  expect(queryByRole(document.body, "menu")).toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(queryByRole(document.body, "menu")).not.toBeNull();
  expect(vibrate).toHaveBeenCalledWith(10);
  await pointer("pointerup");
  await click(getByRole(dom.container(), "button", { name: "Attachment" }));
  expect(openFile).not.toHaveBeenCalled();
});
it.each(["movement", "scroll", "release", "cancel"])("cancels long press on %s", async (cancel) => {
  vi.useFakeTimers(); await render(); await pointer("pointerdown");
  await act(async () => vi.advanceTimersByTime(200));
  if (cancel === "movement") await pointer("pointermove", 19, 10);
  if (cancel === "scroll") await act(async () => window.dispatchEvent(new Event("scroll")));
  if (cancel === "release") await pointer("pointerup");
  if (cancel === "cancel") await pointer("pointercancel");
  await act(async () => vi.advanceTimersByTime(500));
  expect(queryByRole(document.body, "menu")).toBeNull();
});
it("uses the existing bottom Sheet on phones", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await render(); await click(getByRole(document.body, "button", { name: "Message actions" }));
  expect(getByRole(document.body, "dialog").contains(getByRole(document.body, "menu"))).toBe(true);
  await press("Escape"); expect(queryByRole(document.body, "dialog")).toBeNull();
});
it.each([
  { overrides: {}, own: true, present: ["Copy text", "Delete for me", "Delete for everyone"], absent: ["Open", "Retry"] },
  { overrides: {}, own: false, present: ["Copy text", "Delete for me"], absent: ["Delete for everyone"] },
  { overrides: { type: "file", content: fileContent }, own: true, present: ["Open", "Save file", "Copy file name"], absent: ["Copy text"] },
  { overrides: { status: "failed" }, own: true, present: ["Retry", "Discard", "Delete for me"], absent: ["Delete for everyone"] },
  { overrides: { status: "sending" }, own: true, present: ["Delete for me"], absent: ["Delete for everyone"] },
  { overrides: { deletedAt: 200, content: "" }, own: true, present: ["Delete for me"], absent: ["Copy text", "Delete for everyone"] },
])("shows applicable items for $overrides", async ({ overrides, own, present, absent }) => {
  await render(overrides as Partial<DecryptedMessage>, own);
  await click(getByRole(document.body, "button", { name: overrides.status === "failed" ? "Failed message actions" : "Message actions" }));
  for (const name of present) expect(queryByRole(document.body, "menuitem", { name })).not.toBeNull();
  for (const name of absent) expect(queryByRole(document.body, "menuitem", { name })).toBeNull();
});
it("confirms remote deletion, wipes local content and renders the tombstone", async () => {
  await saveMessage(message); useChatStore.getState().addMessage("conv", message);
  await render();
  vi.mocked(api.delete).mockResolvedValue({ deletedAt: 200, deletedIds: [message.id] });
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Delete for everyone" }));
  expect(api.delete).not.toHaveBeenCalled();
  const confirm = getByRole(document.body, "alertdialog");
  await click(getByRole(confirm, "button", { name: "Delete for everyone" }));
  expect(api.delete).toHaveBeenCalledWith("/api/messages/message");
  await act(async () => { await waitFor(async () => expect(await getMessageById(message.id)).toMatchObject({ content: "", deletedAt: 200 })); });
  await render({ content: "", deletedAt: 200 });
  expect(dom.container().textContent).toContain("You deleted this message");
});
it("keeps a failed remote deletion visible in the confirmation", async () => {
  await render(); vi.mocked(api.delete).mockRejectedValue(new Error("Offline"));
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Delete for everyone" }));
  await click(getByRole(getByRole(document.body, "alertdialog"), "button", { name: "Delete for everyone" }));
  expect(getByRole(document.body, "alertdialog").textContent).toContain("Could not delete the message");
});
it.each(["sending", "failed"] as const)("treats local deletion of %s as Discard", async (status) => {
  await saveMessage({ ...message, status });
  await render({ status });
  await click(getByRole(document.body, "button", { name: status === "failed" ? "Failed message actions" : "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Delete for me" }));
  const dialog = getByRole(document.body, "alertdialog");
  expect(discardOutgoing).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(getByRole(dialog, "button", { name: "Cancel" }));
  vi.mocked(discardOutgoing).mockImplementationOnce(async (id, conversationId) => {
    const { deleteMessagesForLocalUserOnly } = await import("../../lib/message-sync.js");
    await deleteMessagesForLocalUserOnly(conversationId, [id], () => true);
    return undefined;
  });
  await click(getByRole(dialog, "button", { name: "Delete for me" }));
  expect(discardOutgoing).toHaveBeenCalledWith(message.id, "conv");
  await act(async () => { await waitFor(async () => expect(await getMessageById(message.id)).toBeUndefined()); });
  expect(api.delete).not.toHaveBeenCalled();
});

it("reports an already-sending message without hiding its bubble", async () => {
  await saveMessage({ ...message, status: "sending" });
  await render({ status: "sending" });
  vi.mocked(discardOutgoing).mockResolvedValueOnce("already-sending");
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Delete for me" }));
  const dialog = getByRole(document.body, "alertdialog");
  await click(getByRole(dialog, "button", { name: "Delete for me" }));
  await act(async () => { await waitFor(() => expect(dialog.textContent).toContain("may still be delivered")); });
  expect(await getMessageById(message.id)).toMatchObject({ content: message.content });
});

it("uses distinct accessible names for attachments from the same sender and minute", async () => {
  await dom.render(<ToastProvider>{["notes.txt", "report.txt"].map((fileName) => (
    <MessageBubble key={fileName} message={{ ...message, id: fileName, type: "file", content: JSON.stringify({ ...JSON.parse(fileContent), fileName }) }}
      isOwn selection={{ selected: false, busy: false }} onSelect={() => {}} />
  ))}</ToastProvider>);
  expect(getByRole(document.body, "checkbox", { name: /notes\.txt/ })).toBeTruthy();
  expect(getByRole(document.body, "checkbox", { name: /report\.txt/ })).toBeTruthy();
});

it.each(["scrim", "menu item", "bubble"])("keeps the phone Sheet open through a retargeted touch release and compatibility click on the %s", async (targetName) => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await render({ type: "file", content: fileContent });
  const bubble = dom.container().querySelector(".message-action-surface")!;
  await pointer("pointerdown");
  await act(async () => { bubble.dispatchEvent(new Event("touchstart", { bubbles: true })); vi.advanceTimersByTime(500); });
  const menu = getByRole(document.body, "menu");
  // A long hold outlasts any timeout measured from opening. Protection starts at release.
  await act(async () => vi.advanceTimersByTime(1500));
  const scrim = document.querySelector("[data-overlay-scrim]")!;
  const target = targetName === "scrim" ? scrim : targetName === "menu item" ? getByRole(menu, "menuitem", { name: "Open" }) : bubble;
  const release = new Event("touchend", { bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    target.dispatchEvent(release);
    vi.advanceTimersByTime(300);
    for (const type of ["mousedown", "mouseup", "click", "contextmenu"]) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail: 1 }));
  });
  expect(release.defaultPrevented).toBe(true);
  expect(getByRole(document.body, "menu")).toBe(menu);
  expect(openFile).not.toHaveBeenCalled();

  // A fresh physical tap must work immediately, even inside the compatibility window.
  const open = getByRole(menu, "menuitem", { name: "Open" });
  await act(async () => {
    open.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    open.dispatchEvent(new Event("touchstart", { bubbles: true }));
    open.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    open.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true }));
    open.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
  expect(openFile).toHaveBeenCalledOnce();
  expect(queryByRole(document.body, "menu")).toBeNull();
});
it("ignores a duplicate native contextmenu during the opening touch and still permits Escape", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await render();
  await pointer("pointerdown");
  await act(async () => vi.advanceTimersByTime(500));
  const menu = getByRole(document.body, "menu");
  const native = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 90, clientY: 90 });
  await act(async () => document.querySelector("[data-overlay-scrim]")!.dispatchEvent(native));
  expect(native.defaultPrevented).toBe(true);
  expect(getByRole(document.body, "menu")).toBe(menu);
  await press("Escape");
  expect(queryByRole(document.body, "menu")).toBeNull();
});
it("allows a fresh scrim tap to dismiss the Sheet after the opening release", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await render(); await pointer("pointerdown");
  await act(async () => vi.advanceTimersByTime(500));
  const scrim = document.querySelector("[data-overlay-scrim]")!;
  await act(async () => {
    scrim.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true }));
    scrim.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    scrim.dispatchEvent(new Event("touchstart", { bubbles: true }));
    scrim.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(queryByRole(document.body, "menu")).toBeNull();
});
it("consumes the file click even when release follows the timer before React commits the menu", async () => {
  vi.useFakeTimers();
  await render({ type: "file", content: fileContent });
  await pointer("pointerdown");
  await act(async () => {
    vi.advanceTimersByTime(500);
    // State is still batched: there is no menu/document release listener yet.
    dom.container().querySelector<HTMLButtonElement>(".bubble button")!.click();
  });
  expect(openFile).not.toHaveBeenCalled();
  expect(queryByRole(document.body, "menu")).not.toBeNull();
});

it("deletes sent messages without a dialog and offers a five-second Undo", async () => {
  await saveMessage(message); useChatStore.getState().addMessage("conv", message);
  await render();
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Delete for me" }));
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
  await act(async () => { await waitFor(async () => expect(await (await getAppDB()).get("accountState", messageHideKey(message.id, "alice"))).toHaveProperty("undoToken")); });
  expect(document.body.textContent).toContain("Message deleted for you");
  expect(useChatStore.getState().messages.get("conv")).toEqual([]);
  expect(await getMessageById(message.id)).toBeDefined();
  await click(getByRole(document.body, "button", { name: "Undo" }));
  await act(async () => { await waitFor(() => expect(useChatStore.getState().messages.get("conv")?.[0].content).toBe(message.content)); });
});
it("confirms everyone deletion with the filename, irreversibility copy, and Cancel focused first", async () => {
  await render({ type: "file", content: fileContent });
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Delete for everyone" }));
  const dialog = getByRole(document.body, "alertdialog", { name: "Delete notes.txt for everyone?" });
  expect(dialog.textContent).toContain('It will be replaced with "This message was deleted" for everyone in this conversation. People may already have seen or saved it. This cannot be undone.');
  expect(document.activeElement).toBe(getByRole(dialog, "button", { name: "Cancel" }));
});
it.each(["installer.EXE", "notes.pdf.exe", "image.svg", "page.html"])("omits Open for blocked %s", async (fileName) => {
  await render({ type: "file", content: JSON.stringify({ ...JSON.parse(fileContent), fileName }) });
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  expect(queryByRole(document.body, "menuitem", { name: "Open" })).toBeNull();
  expect(getByRole(document.body, "menuitem", { name: "Save file" })).toBeDefined();
});
it("allows native context menus on links and on selected bubble text", async () => {
  await render();
  const bubble = dom.container().querySelector(".bubble")!;
  const link = document.createElement("a"); link.href = "https://example.com"; link.textContent = "link"; bubble.append(link);
  const context = () => new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  const linkEvent = context();
  await act(async () => { link.dispatchEvent(linkEvent); });
  expect(linkEvent.defaultPrevented).toBe(false);
  const selection = window.getSelection()!; selection.removeAllRanges(); const range = document.createRange(); range.selectNodeContents(bubble); selection.addRange(range);
  const selected = context();
  await act(async () => { bubble.dispatchEvent(selected); });
  expect(selected.defaultPrevented).toBe(false);
  expect(queryByRole(document.body, "menu")).toBeNull();
  selection.removeAllRanges();
});
it("rings the selected bubble and closes the menu when its message list scrolls", async () => {
  await render();
  const list = dom.container(); list.setAttribute("role", "log");
  await click(getByRole(list, "button", { name: "Message actions" }));
  expect(list.querySelector(".bubble")?.classList.contains("message-menu-target")).toBe(true);
  await act(async () => { list.dispatchEvent(new Event("scroll")); });
  expect(queryByRole(document.body, "menu")).toBeNull();
  expect(list.querySelector(".bubble")?.classList.contains("message-menu-target")).toBe(false);
});
it("hides metadata within a run and styles incoming tombstones without content actions", async () => {
  await dom.render(<ToastProvider><MessageBubble message={{ ...message, deletedAt: 200, content: "" }} isOwn={false} showMeta={false} /></ToastProvider>);
  expect(dom.container().querySelector("[data-message-meta]")).toBeNull();
  expect(dom.container().querySelector(".bubble-deleted")?.textContent).toBe("This message was deleted");
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  expect(getByRole(document.body, "menu").querySelectorAll('[role="menuitem"]')).toHaveLength(1);
});
it("shows the phone file preview with sender, size and extension", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await render({ type: "file", content: JSON.stringify({ ...JSON.parse(fileContent), size: 28 }) });
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  const sheet = getByRole(document.body, "dialog", { name: "Message actions" });
  expect(sheet.textContent).toContain("You");
  expect(sheet.textContent).toContain("notes.txt");
  expect(sheet.textContent).toContain("28 B · TXT");
});

it.each([true, false])("keeps each timed message countdown visible when showMeta=%s", async (showMeta) => {
  vi.useFakeTimers();
  const expiresAt = Date.now() + 60_000;
  await dom.render(<ToastProvider><MessageBubble message={{ ...message, expiryKind: "timed", expiresAt }} isOwn showMeta={showMeta} /></ToastProvider>);
  const countdown = dom.container().querySelector('[aria-label^="Expires in"]');
  expect(countdown).not.toBeNull();
  expect(countdown?.textContent).toContain("1m");
  expect(!!dom.container().querySelector("[data-message-meta]")).toBe(showMeta);
  await act(async () => vi.advanceTimersByTime(1000));
  expect(countdown?.textContent).toContain("59s");
});

it("omits Save from the file menu when capability-based saving is unavailable", async () => {
  vi.spyOn(capabilities, "saveFile", "get").mockReturnValue(false);
  await render({ type: "file", content: fileContent });
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  expect(queryByRole(document.body, "menuitem", { name: "Save file" })).toBeNull();
  expect(queryByRole(document.body, "menuitem", { name: "Share file" })).toBeNull();
  expect(getByRole(document.body, "menuitem", { name: "Open" })).toBeDefined();
});
it("routes Save in the received-file menu to the attachment save action", async () => {
  vi.spyOn(capabilities, "fileSave", "get").mockReturnValue("downloads");
  await render({ type: "file", content: fileContent, senderId: "bob" }, false);
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Save file" }));
  expect(saveFile).toHaveBeenCalledOnce();
});
it("removes Save when the attachment reports a runtime unsupported-save result", async () => {
  await render({ type: "file", content: fileContent });
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  expect(getByRole(document.body, "menuitem", { name: "Save file" })).toBeDefined();
  await act(async () => reportSaveUnsupported?.(true));
  expect(queryByRole(document.body, "menuitem", { name: "Save file" })).toBeNull();
});

it.each(["outbox-read", "save", "hide"])("rejects an account switch during the delete-for-me %s await without saving/hiding old content or creating Undo", async (phase) => {
  const database = await import("../../db/index.js");
  await saveMessage(message);
  let resume!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  if (phase === "outbox-read") {
    const original = database.getOutgoing;
    vi.spyOn(database, "getOutgoing").mockImplementationOnce(async (...args) => { started(); await gate; return original(...args); });
  } else if (phase === "save") {
    const original = database.saveMessage;
    vi.spyOn(database, "saveMessage").mockImplementationOnce(async (...args) => { started(); await gate; return original(...args); });
  } else {
    const original = database.beginMessageHide;
    vi.spyOn(database, "beginMessageHide").mockImplementationOnce(async (...args) => { started(); await gate; return original(...args); });
  }
  const actionModule = await import("../../features/chat/useMessageActions.js");
  const originalHook = actionModule.useMessageActions;
  let pendingDelete!: ReturnType<ReturnType<typeof originalHook>["requestDeleteForMe"]>;
  vi.spyOn(actionModule, "useMessageActions").mockImplementation((...args) => {
    const actions = originalHook(...args);
    return { ...actions, requestDeleteForMe: () => { pendingDelete = actions.requestDeleteForMe(); return pendingDelete; } };
  });
  await render();
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Delete for me" }));
  await ready;
  await act(async () => {
    useAuthStore.setState({ user: { id: "bob" }, device: { id: "bob-device" }, sessionId: "new-login" } as never);
    const db = await getAppDB();
    for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
    const newAccountMessage = { ...message, ownerId: "bob", senderId: "bob", content: "new account private" };
    await database.saveMessage(newAccountMessage);
    useChatStore.setState({ messages: new Map([["conv", [newAccountMessage]]]) });
    resume();
    await pendingDelete;
  });
  expect(await getMessageById(message.id)).toMatchObject({ senderId: "bob", content: "new account private" });
  expect(await (await getAppDB()).get("accountState", messageHideKey(message.id, "alice"))).toBeUndefined();
  expect(queryByRole(document.body, "button", { name: "Undo" })).toBeNull();
  expect(useChatStore.getState().messages.get("conv")?.[0]).toMatchObject({ senderId: "bob", content: "new account private" });
});
it("does not dispatch Delete for everyone after the initiating session changes during its outbox read", async () => {
  const database = await import("../../db/index.js");
  let resume!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  vi.spyOn(database, "getOutgoing").mockImplementationOnce(async () => { started(); await gate; return undefined; });
  await render(); await click(getByRole(document.body, "button", { name: "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Delete for everyone" }));
  await click(getByRole(getByRole(document.body, "alertdialog"), "button", { name: "Delete for everyone" }));
  await ready;
  await act(async () => { useAuthStore.setState({ sessionId: "another-login" } as never); resume(); await gate; });
  expect(api.delete).not.toHaveBeenCalled();
});
it.each(["sign-out", "account", "device", "session"])("clears pending Undo toasts on %s and never restores through a stale Undo", async (change) => {
  const { hideMessageWithUndo } = await import("../../lib/message-sync.js");
  await saveMessage(message);
  await render(); await click(getByRole(document.body, "button", { name: "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Delete for me" }));
  await act(async () => { await waitFor(async () => expect(await (await getAppDB()).get("accountState", messageHideKey(message.id, "alice"))).toHaveProperty("undoToken")); });
  expect(getByRole(document.body, "button", { name: "Undo" })).toBeDefined();
  // Keep a second Undo closure to exercise the DB restore guard directly.
  await saveMessage({ ...message, id: "second" });
  const undo = await hideMessageWithUndo("conv", "second");
  await act(async () => {
    if (change === "sign-out") useAuthStore.setState({ user: null, sessionId: null } as never);
    if (change === "account") useAuthStore.setState({ user: { id: "bob" } } as never);
    if (change === "device") useAuthStore.setState({ device: { id: "different-device" } } as never);
    if (change === "session") useAuthStore.setState({ sessionId: "new-session" } as never);
  });
  expect(queryByRole(document.body, "button", { name: "Undo" })).toBeNull();
  expect(await undo!()).toBe(false);
  expect(await (await getAppDB()).get("accountState", messageHideKey("second", "alice"))).toBeDefined();
});
it("rejects an identity change while Undo's DB restore is awaiting", async () => {
  const database = await import("../../db/index.js");
  const { hideMessageWithUndo } = await import("../../lib/message-sync.js");
  await saveMessage(message);
  const undo = await hideMessageWithUndo("conv", message.id);
  let resume!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const original = database.finishMessageHide;
  vi.spyOn(database, "finishMessageHide").mockImplementationOnce(async (...args) => { started(); await gate; return original(...args); });
  const restoring = undo!(); await ready;
  useAuthStore.setState({ sessionId: "changed-during-undo" } as never);
  resume();
  expect(await restoring).toBe(false);
  expect(await (await getAppDB()).get("accountState", messageHideKey(message.id, "alice"))).toBeDefined();
  expect(useChatStore.getState().messages.get("conv") ?? []).toEqual([]);
});

it("rejects a stale queued-message confirmation during its outbox read", async () => {
  const database = await import("../../db/index.js");
  await saveMessage({ ...message, status: "failed" });
  await render({ status: "failed" });
  await click(getByRole(document.body, "button", { name: "Failed message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Delete for me" }));
  await act(async () => { await waitFor(() => expect(queryByRole(document.body, "alertdialog")).not.toBeNull()); });
  let resume!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  vi.spyOn(database, "getOutgoing").mockImplementationOnce(async () => { started(); await gate; return undefined; });
  await click(getByRole(getByRole(document.body, "alertdialog"), "button", { name: "Delete for me" }));
  await ready;
  await act(async () => { useAuthStore.setState({ sessionId: "changed-during-discard" } as never); resume(); await gate; });
  expect(discardOutgoing).not.toHaveBeenCalled();
  expect((await getMessageById(message.id))?.content).toBe(message.content);
  expect(await (await getAppDB()).get("accountState", messageHideKey(message.id, "alice"))).toBeUndefined();
});

const stickerBody = "[[sticker:genshin:genshin_hoyolab_21]]";

it("restores both mounted sticker messages after retrying their shared catalog", async () => {
  const unavailable = vi.fn(() => { throw new Error("Catalog chunk unavailable"); });
  vi.doMock("../../features/stickers/catalog.runtime.json", unavailable);
  try {
    await dom.render(<ToastProvider>
      <MessageBubble message={{ ...message, content: stickerBody }} isOwn={false} />
      <MessageBubble message={{ ...message, id: "second", content: "[[sticker:genshin:genshin_hoyolab_22]]" }} isOwn={false} />
    </ToastProvider>);
    const name = "Sticker did not load. Select to try again.";
    const retries = await waitFor(() => {
      const buttons = getAllByRole(dom.container(), "button", { name });
      expect(buttons).toHaveLength(2);
      return buttons;
    });
    expect(unavailable).toHaveBeenCalledOnce();
    expect(spriteIO.network).not.toHaveBeenCalled();
    vi.doUnmock("../../features/stickers/catalog.runtime.json");
    await click(retries[0]);
    await waitFor(() => expect(dom.container().querySelectorAll(".sticker-message .sticker-art[style]")).toHaveLength(2));
    expect(queryByRole(dom.container(), "button", { name })).toBeNull();
    expect(spriteIO.network).toHaveBeenCalledOnce();
  } finally { vi.doUnmock("../../features/stickers/catalog.runtime.json"); }
});

it("does not rerender text, file, or sticker bubbles when the picker page and tab change", async () => {
  function PickerControls() {
    const picker = useStickerPicker()!;
    return <>
      <button onClick={() => void picker.change((state) => ({ ...state, page: "genshin-2", tab: "stickers" }))}>Browse next pack</button>
      <button onClick={() => void picker.change((state) => ({ ...state, tab: "custom" }))}>Switch picker tab</button>
      <output>{picker.state.page} {picker.state.tab}</output>
    </>;
  }
  const formatTime = vi.spyOn(format, "formatTime");
  await dom.render(<ToastProvider><StickerProvider>
    <MessageBubble message={message} isOwn={false} />
    <MessageBubble message={{ ...message, id: "file", timestamp: 200, type: "file", content: fileContent }} isOwn={false} />
    <MessageBubble message={{ ...message, id: "sticker", timestamp: 300, content: stickerBody }} isOwn={false} />
    <PickerControls />
  </StickerProvider></ToastProvider>);
  await waitFor(() => expect(dom.container().querySelector(".sticker-message .sticker-art[style]")).toBeTruthy());
  for (const timestamp of [message.timestamp, 200, 300]) expect(formatTime).toHaveBeenCalledWith(timestamp);
  formatTime.mockClear();
  await click(getByRole(dom.container(), "button", { name: "Browse next pack" }));
  await waitFor(() => expect(dom.container().querySelector("output")?.textContent).toBe("genshin-2 stickers"));
  await click(getByRole(dom.container(), "button", { name: "Switch picker tab" }));
  await waitFor(() => expect(dom.container().querySelector("output")?.textContent).toBe("genshin-2 custom"));
  expect(formatTime).not.toHaveBeenCalled();

  const sticker = dom.container().querySelector(".sticker-message")!.closest("article")!;
  const more = getByRole(sticker, "button", { name: "Message actions" });
  await click(more);
  await click(getByRole(document.body, "menuitem", { name: "Add to favourites" }));
  await waitFor(() => expect(getByRole(document.body, "region", { name: "Notifications" }).textContent).toContain("Added to favourites"));
  await click(more);
  expect(getByRole(document.body, "menuitem", { name: "Remove from favourites" })).toBeTruthy();
});

it("shows a known sticker outside the bubble with a full-size pack sprite and delivery pill", async () => {
  const content = "[[sticker:genshin:genshin_hoyolab_26]]";
  await dom.render(<ToastProvider><MessageBubble message={{ ...message, content, status: "read" }} isOwn onEdit={vi.fn()} /></ToastProvider>);
  const image = await waitFor(() => {
    const art = dom.container().querySelector<HTMLElement>(".sticker-message .sticker-art[style]");
    expect(art).not.toBeNull();
    return art!;
  });
  expect(image.style.backgroundImage).toContain("blob:sticker-full");
  expect(image.style.backgroundPosition).toBe("33.333333333333336% 33.333333333333336%");
  expect(spriteIO.network).toHaveBeenCalledExactlyOnceWith(`${spriteBase}/packs/full/genshin-1.webp`, expect.objectContaining({
    mode: "cors", credentials: "omit", referrerPolicy: "no-referrer",
  }));
  const alt = "Sticker 6 of 16, Paimon's Paintings 1";
  expect(image.getAttribute("aria-label")).toBe(alt);
  expect(dom.container().querySelector(".bubble")).toBeNull();
  expect(dom.container().querySelector(".sticker-meta")?.textContent).toContain("Read");
  expect(dom.container().querySelector("article")?.getAttribute("aria-label")).toContain(alt);
  await click(getByRole(document.body, "button", { name: /open sticker pack/i }));
  const pack = getByRole(document.body, "dialog", { name: "Paimon's Paintings 1" });
  expect(queryByRole(pack, "button", { name: "Send sticker" })).toBeNull();
  await press("Escape");
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  expect(getByRole(document.body, "menuitem", { name: "View sticker pack" })).toBeDefined();
  expect(queryByRole(document.body, "menuitem", { name: "Edit message" })).toBeNull();
  expect(queryByRole(document.body, "menuitem", { name: "Copy text" })).toBeNull();
});

it("keeps artwork reload and failed delivery retry separate and counts down mid-run", async () => {
  const retry = vi.fn();
  spriteIO.network.mockResolvedValueOnce(new Response(null, { status: 503 }));
  const expiresAt = Date.now() + 50_000;
  await dom.render(<ToastProvider><MessageBubble message={{ ...message, content: stickerBody, status: "failed", expiryKind: "timed", expiresAt }}
    isOwn showMeta={false} onRetry={retry} /></ToastProvider>);
  const reload = await waitFor(() => getByRole(document.body, "button", { name: "Sticker did not load. Select to try again." }));
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(spriteIO.network.mock.calls.map(([url]) => url)).toEqual([`${spriteBase}/packs/full/genshin-1.webp`]);
  expect(reload.querySelector(".sticker-art[style]")).toBeNull();
  expect(dom.container().querySelector("[aria-label^='Expires in']")).toBeTruthy();
  expect(dom.container().querySelector(".sticker-send-failed")?.textContent).toContain("Not sent·Retry");
  await click(reload);
  expect(retry).not.toHaveBeenCalled();
  expect(spriteIO.network.mock.calls.map(([url]) => url)).toEqual(Array(2).fill(`${spriteBase}/packs/full/genshin-1.webp`));
  await click(getByRole(document.body, "button", { name: /^Retry$/ }));
  expect(retry).toHaveBeenCalledTimes(1);
});

it("renders a timed countdown mid-run for a successfully sent sticker", async () => {
  await dom.render(<ToastProvider><MessageBubble isOwn showMeta={false}
    message={{ ...message, content: stickerBody, expiryKind: "timed", expiresAt: Date.now() + 20_000 }} /></ToastProvider>);
  expect(dom.container().querySelector(".sticker-meta [aria-label^='Expires in']")).toBeTruthy();
  expect(dom.container().querySelector(".sticker-meta time")).toBeNull();
});

it("renders unknown sticker IDs as legacy text", async () => {
  const unknown = "[[sticker:genshin:genshin_hoyolab_999999]]";
  await render({ content: unknown });
  expect(dom.container().querySelector(".bubble")?.textContent).toBe(unknown);
  expect(dom.container().querySelector(".sticker-message")).toBeNull();
});

it.each(["undecodable bytes", "a different pack"])("shows the retry placeholder for %s without a thumbnail or per-sticker request", async (failure) => {
  if (failure === "a different pack") spriteIO.network.mockResolvedValueOnce(spriteResponse(`${spriteBase}/packs/full/genshin-2.webp`));
  else spriteIO.decode.mockRejectedValueOnce(new Error("Invalid sprite"));
  await render({ content: stickerBody });
  const placeholder = await waitFor(() => getByRole(document.body, "button", { name: "Sticker did not load. Select to try again." }));
  expect(placeholder.querySelector(".sticker-art[style], img[src]")).toBeNull();
  expect(spriteIO.network.mock.calls.map(([url]) => url)).toEqual([`${spriteBase}/packs/full/genshin-1.webp`]);
  await click(placeholder);
  await waitFor(() => expect(dom.container().querySelector(".sticker-message .sticker-art[style]")).toBeTruthy());
});

it("ignores context-menu keyboard events from a file viewer portal", async () => {
  showFilePortal = true;
  try {
    await render({ type: "file", content: fileContent });
    getByRole(document.body, "button", { name: "File viewer control" }).focus();
    await press("F10", { shiftKey: true });
    expect(queryByRole(document.body, "menu")).toBeNull();
    getByRole(dom.container(), "button", { name: "Attachment" }).focus();
    await press("F10", { shiftKey: true });
    expect(getByRole(document.body, "menu")).toBeTruthy();
  } finally { showFilePortal = false; }
});
