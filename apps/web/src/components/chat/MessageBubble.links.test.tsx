import { act } from "react";
import { getAllByRole, getByRole, queryByRole, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DecryptedMessage } from "@e2ee-chat/shared";
import MessageBubble from "./MessageBubble.js";
import { ToastProvider } from "../../ui/index.js";
import { click, setupDom } from "../../ui/test-utils.js";
import { openExternal } from "../../platform/external.js";
import { copyText } from "../../platform/clipboard.js";

vi.mock("../../features/chat/useEmojiText.js", async () => {
  const { parseEmojiTextSegments } = await import("../../lib/custom-emojis.js");
  return { useEmojiText: (content: string) => parseEmojiTextSegments(content).map((segment) => ({ ...segment, src: null })) };
});
vi.mock("../../platform/external.js", () => ({ openExternal: vi.fn(async () => undefined) }));
vi.mock("../../platform/clipboard.js", () => ({ copyText: vi.fn(async () => undefined) }));
vi.mock("../../services/api.js", () => ({ api: { delete: vi.fn() } }));
vi.mock("../../features/chat/outgoingQueue.js", () => ({ discardOutgoing: vi.fn() }));
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "alice" }, device: { id: "device" }, sessionId: "session" })) };
});

const dom = setupDom();
const base: DecryptedMessage = { id: "message", conversationId: "conv", senderId: "alice", type: "text", content: "Read https://example.com/a?b=1. Also WWW.Example.org!", timestamp: 100, expiresAt: Date.now() + 60_000, expiryKind: "retention", status: "sent" };

async function render(overrides: Partial<DecryptedMessage> = {}, props: Partial<Parameters<typeof MessageBubble>[0]> = {}) {
  await dom.render(<ToastProvider><MessageBubble message={{ ...base, ...overrides }} isOwn {...props} /></ToastProvider>);
}
const links = () => Array.from(dom.container().querySelectorAll<HTMLAnchorElement>(".bubble a"));
function touch(target: Element, type: string) {
  return act(async () => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    Object.defineProperties(event, { pointerType: { value: "touch" }, isPrimary: { value: true } });
    target.dispatchEvent(event);
  });
}
async function clickEvent(target: Element) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

beforeEach(() => vi.clearAllMocks());
/** The URL each link opens, observed through the mocked platform helper. */
async function openedHrefs() {
  const hrefs: string[] = [];
  for (const link of links()) {
    vi.mocked(openExternal).mockClear();
    await clickEvent(link);
    hrefs.push(vi.mocked(openExternal).mock.calls[0]?.[0] as string);
  }
  vi.mocked(openExternal).mockClear();
  return hrefs;
}
async function auxClick(target: Element, button = 1) {
  const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}
async function copyLinkFromMenu() {
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Copy link" }));
}
afterEach(() => vi.restoreAllMocks());

it.each([true, false])("renders http(s) and www links as typed, focusable links (own=%s)", async (own) => {
  await render({}, { isOwn: own });
  const bubble = dom.container().querySelector(".bubble")!;
  expect(bubble.textContent).toBe(base.content);
  expect(links().map((link) => link.textContent)).toEqual(["https://example.com/a?b=1", "WWW.Example.org"]);
  for (const link of links()) {
    expect(link.getAttribute("role")).toBe("link");
    expect(link.tabIndex).toBe(0);
    expect(link.className).toContain("message-link");
  }
  expect(getAllByRole(bubble as HTMLElement, "link").map((link) => link.textContent)).toEqual(["https://example.com/a?b=1", "WWW.Example.org"]);
  expect(await openedHrefs()).toEqual(["https://example.com/a?b=1", "https://www.example.org/"]);
});

it("keeps external URLs out of the DOM so nothing can preload or preconnect", async () => {
  await render({ content: "see https://tracker.example/a?b=1 and www.other.example and https://bücher.de/x" });
  expect(links()).toHaveLength(3);
  const bubble = dom.container().querySelector(".bubble")!;
  for (const element of [bubble, ...Array.from(bubble.querySelectorAll("*"))]) {
    for (const name of ["href", "src", "srcset", "action", "formaction", "poster", "data", "ping", "background"]) expect(element.hasAttribute(name), `${element.tagName} ${name}`).toBe(false);
    for (const attribute of Array.from(element.attributes)) expect(attribute.value, `${element.tagName} ${attribute.name}`).not.toMatch(/tracker|other\.example|bücher|xn--|https?:/i);
  }
  expect(document.querySelector('link[rel~="preconnect"], link[rel~="prefetch"], link[rel~="dns-prefetch"], link[rel~="preload"]')).toBeNull();
});

it("opens a focused link with Enter but not Space", async () => {
  await render();
  const link = links()[1];
  link.focus();
  expect(document.activeElement).toBe(link);
  const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  await act(async () => { link.dispatchEvent(space); });
  expect(openExternal).not.toHaveBeenCalled();
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => { link.dispatchEvent(enter); });
  expect(enter.defaultPrevented).toBe(true);
  expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://www.example.org/");
  await act(async () => { link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, repeat: true })); });
  expect(openExternal).toHaveBeenCalledOnce();
});

it("never links other schemes", async () => {
  await render({ content: "javascript:alert(1) data:text/html,x file:///etc/passwd mailto:a@b.example tel:123 intent://x" });
  expect(links()).toEqual([]);
});

it("opens through the platform helper and suppresses browser navigation", async () => {
  await render();
  const event = await clickEvent(links()[1]);
  expect(event.defaultPrevented).toBe(true);
  expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://www.example.org/");
});

it("reports a link that cannot be opened", async () => {
  vi.mocked(openExternal).mockRejectedValueOnce(new Error("blocked"));
  await render();
  await clickEvent(links()[0]);
  await waitFor(() => expect(document.body.textContent).toContain("Could not open this link."));
});

it("keeps links inert in selection mode and selects the message instead", async () => {
  const onSelect = vi.fn();
  await render({}, { onSelect, selection: { selected: false, busy: false } });
  const event = await clickEvent(links()[0]);
  expect(event.defaultPrevented).toBe(true);
  expect(openExternal).not.toHaveBeenCalled();
  expect(onSelect).toHaveBeenCalledOnce();
});

it("opens the message menu on a long-press over a link, not the link, and copies that link", async () => {
  vi.useFakeTimers();
  await render();
  const link = links()[1];
  await touch(link, "pointerdown");
  await act(async () => vi.advanceTimersByTime(500));
  const menu = getByRole(document.body, "menu");
  await touch(link, "pointerup");
  await act(async () => { link.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true })); });
  await clickEvent(link);
  expect(openExternal).not.toHaveBeenCalled();
  expect(getByRole(document.body, "menu")).toBe(menu);
  // Past the compatibility-click guard that follows the opening release.
  await act(async () => vi.advanceTimersByTime(1000));
  await click(getByRole(menu, "menuitem", { name: "Copy link" }));
  vi.useRealTimers();
  expect(copyText).toHaveBeenCalledExactlyOnceWith("WWW.Example.org");
  await waitFor(() => expect(document.body.textContent).toContain("Link copied"));
});

it("opens the message menu instead of the native menu when right-clicking a message link", async () => {
  await render();
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
  await act(async () => { links()[1].dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  await click(getByRole(document.body, "menuitem", { name: "Copy link" }));
  expect(copyText).toHaveBeenCalledWith("WWW.Example.org");
});

it("copies the first link from the more button, even after pressing a later link", async () => {
  await render();
  await act(async () => { links()[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await waitFor(() => expect(queryByRole(document.body, "menu")).toBeNull());
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  const items = getAllByRole(document.body, "menuitem").map((item) => item.getAttribute("aria-label") ?? item.textContent);
  expect(items.slice(0, 2)).toEqual(["Copy text", "Copy link"]);
  await click(getByRole(document.body, "menuitem", { name: "Copy link" }));
  expect(copyText).toHaveBeenCalledExactlyOnceWith("https://example.com/a?b=1");
});

it("offers no Copy link for text without links", async () => {
  await render({ content: "No links, just example.com and mail@example.com" });
  expect(links()).toEqual([]);
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  expect(queryByRole(document.body, "menuitem", { name: "Copy text" })).not.toBeNull();
  expect(queryByRole(document.body, "menuitem", { name: "Copy link" })).toBeNull();
});

it("links the pending edit text shown in the bubble", async () => {
  await render({ content: "old https://old.example", editedAt: 10, pendingEdit: { id: "edit", content: "new https://new.example/x" } });
  expect(links().map((link) => link.textContent)).toEqual(["https://new.example/x"]);
  expect(await openedHrefs()).toEqual(["https://new.example/x"]);
});

it("links committed edits", async () => {
  await render({ content: "fixed www.example.com/page", editedAt: 10, status: "delivered" });
  expect(await openedHrefs()).toEqual(["https://www.example.com/page"]);
  expect(dom.container().textContent).toContain("Edited");
});

it("keeps failed outgoing text plain inside its retry button", async () => {
  await dom.render(<ToastProvider><MessageBubble message={{ ...base, status: "failed" }} isOwn onRetry={vi.fn()} onDiscard={vi.fn()} /></ToastProvider>);
  expect(dom.container().querySelector("a")).toBeNull();
  expect(dom.container().textContent).toContain("https://example.com/a?b=1");
});

it("does not link custom emoji tokens or text inside them", async () => {
  await render({ content: "hi https://example.com/x[[emoji:abc123:smile]]y" });
  expect(links().map((link) => link.textContent)).toEqual(["https://example.com/x"]);
});

it.each([
  ["https://sub.cafe東京.jp/menu", "https://sub.xn--cafe-8x5f052k.jp/menu"],
  ["https://example.com/files/report_", "https://example.com/files/report_"],
])("links, opens and copies %s exactly as shown", async (url, href) => {
  await render({ content: `see ${url}` });
  expect(links().map((link) => link.textContent)).toEqual([url]);
  await clickEvent(links()[0]);
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(href);
  await copyLinkFromMenu();
  expect(copyText).toHaveBeenCalledExactlyOnceWith(url);
});

it("leaves an ambiguous CJK host boundary plain", async () => {
  await render({ content: "看https://example.com很好/path" });
  expect(links()).toEqual([]);
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  expect(queryByRole(document.body, "menuitem", { name: "Copy link" })).toBeNull();
});

it("opens middle-clicked links through the platform helper", async () => {
  await render();
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
  await act(async () => { links()[0].dispatchEvent(press); });
  expect(press.defaultPrevented).toBe(true);
  const event = await auxClick(links()[0]);
  expect(event.defaultPrevented).toBe(true);
  expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/a?b=1");
  const right = await auxClick(links()[0], 2);
  expect(right.defaultPrevented).toBe(false);
  expect(openExternal).toHaveBeenCalledOnce();
});

it("keeps middle-click and Enter inert in selection mode and removes links from the tab order", async () => {
  await render({}, { onSelect: vi.fn(), selection: { selected: false, busy: false } });
  const event = await auxClick(links()[0]);
  expect(event.defaultPrevented).toBe(true);
  await act(async () => { links()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(openExternal).not.toHaveBeenCalled();
  expect(links().every((link) => link.tabIndex === -1)).toBe(true);
});

it("does not make links draggable, so dragging inside a URL selects text", async () => {
  await render();
  for (const link of links()) expect(link.getAttribute("draggable")).toBe("false");
});

it.each(["https://docs.example。test/guide", "https://docs.example%2Etest/guide", "https://example.com:/guide", "https://example.com:000443/guide"])("leaves %s plain with no Copy link", async (url) => {
  await render({ content: `see ${url}` });
  expect(links()).toEqual([]);
  await click(getByRole(document.body, "button", { name: "Message actions" }));
  expect(queryByRole(document.body, "menuitem", { name: "Copy link" })).toBeNull();
});

it("isolates link labels from surrounding bidi controls", async () => {
  await render({ content: "\u202Eabc https://example.com/a \u202Ctxt.exe" });
  const [link] = links();
  expect(link.getAttribute("dir")).toBe("ltr");
  expect(link.textContent).toBe("https://example.com/a");
  expect(await openedHrefs()).toEqual(["https://example.com/a"]);
});

it("hides Copy link when a live edit removes the long-pressed link instead of copying another", async () => {
  await render();
  await act(async () => { links()[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  expect(queryByRole(document.body, "menuitem", { name: "Copy link" })).not.toBeNull();
  await render({ content: "Edited: only https://other.example/x now", editedAt: 10 });
  expect(getByRole(document.body, "menu")).not.toBeNull();
  expect(queryByRole(document.body, "menuitem", { name: "Copy link" })).toBeNull();
  await render({ content: "Back to WWW.Example.org", editedAt: 11 });
  await click(getByRole(document.body, "menuitem", { name: "Copy link" }));
  expect(copyText).toHaveBeenCalledExactlyOnceWith("WWW.Example.org");
});

it("copies the first link when the menu was opened away from any link", async () => {
  await render();
  await act(async () => { dom.container().querySelector(".bubble")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await click(getByRole(document.body, "menuitem", { name: "Copy link" }));
  expect(copyText).toHaveBeenCalledExactlyOnceWith("https://example.com/a?b=1");
});

it("drops focus when a live edit changes the URL at the same position, so Enter cannot open the new one", async () => {
  await render({ content: "go https://old.example/a now" });
  const before = links()[0];
  before.focus();
  expect(document.activeElement).toBe(before);
  await render({ content: "go https://new.example/b now", editedAt: 10 });
  const after = links()[0];
  expect(after.textContent).toBe("https://new.example/b");
  expect(after).not.toBe(before);
  expect(document.activeElement).not.toBe(after);
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(openExternal).not.toHaveBeenCalled();
});

it("keeps focus when an edit leaves the focused URL unchanged", async () => {
  await render({ content: "go https://same.example/a now" });
  const before = links()[0];
  before.focus();
  await render({ content: "go https://same.example/a later", editedAt: 10 });
  expect(links()[0]).toBe(before);
  expect(document.activeElement).toBe(before);
});
