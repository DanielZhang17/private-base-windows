import { act, useRef, useState } from "react";
import { fireEvent, getByRole, queryByRole, waitFor } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { mockSpriteIO, spriteResponse, spriteBase } from "../../features/stickers/pack-assets.test-utils.js";
import * as storage from "../../features/stickers/storage.js";
import { useAuthStore } from "../../stores/authStore.js";
import { StickerProvider, useStickerPicker } from "../../features/stickers/useStickerPicker.js";
import { ToastProvider } from "../../ui/index.js";
import { click, mockCloseRequests, press, setupDom } from "../../ui/test-utils.js";
import MessageInput from "./MessageInput.js";
import MessageBubble from "./MessageBubble.js";

vi.mock("../../services/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/api.js")>(),
  api: { get: async () => [] },
}));

const dom = setupDom();
let spriteIO: ReturnType<typeof mockSpriteIO>;
beforeEach(() => { spriteIO = mockSpriteIO({ catalog: true }); });

function Chat({ send }: { send: (value: string, options: { ttlSeconds: number | null }) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  return <div ref={pane}>
    <div role="log" ref={list}><span>Message body</span></div>
    <MessageInput onSend={send} onSendFile={vi.fn()} messageList={list} dropTarget={pane} />
  </div>;
}

function handset() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width") || query.includes("coarse"),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

async function openPicker(send: Parameters<typeof Chat>[0]["send"] = vi.fn()) {
  await dom.render(<QueryClientProvider client={new QueryClient()}><ToastProvider><StickerProvider><Chat send={send} /></StickerProvider></ToastProvider></QueryClientProvider>);
  await click(getByRole(document.body, "button", { name: "Emoji and stickers" }));
  await click(getByRole(document.body, "tab", { name: "Stickers" }));
  return waitFor(() => getByRole(document.body, "tab", { name: "Paimon's Paintings 1", selected: true }));
}

function tile(index = 0) {
  return document.querySelector<HTMLButtonElement>(`.sticker-page:not([inert]) [data-sticker-tile="${index}"]`)!;
}

async function load(element: HTMLElement) {
  await waitFor(() => expect(element.querySelector(".sticker-art[style]")).not.toBeNull());
}

function pointer(target: HTMLElement, type: string, x = 100, y = 100) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerType: { value: "touch" }, pointerId: { value: 1 }, isPrimary: { value: true } });
  target.dispatchEvent(event);
}
async function tap(element: HTMLElement) {
  await act(async () => {
    pointer(element, "pointerdown");
    pointer(element, "pointerup");
    fireEvent.click(element, { detail: 1 });
  });
}

it.each([false, true])("keeps the composer control sizes and states when opening the picker (phone=%s)", async (phone) => {
  if (phone) handset();
  await dom.render(<QueryClientProvider client={new QueryClient()}><ToastProvider><StickerProvider><Chat send={vi.fn()} /></StickerProvider></ToastProvider></QueryClientProvider>);
  const field = getByRole<HTMLTextAreaElement>(document.body, "textbox", { name: "Message" });
  const trigger = getByRole(document.body, "button", { name: "Emoji and stickers", expanded: false });
  const send = getByRole<HTMLButtonElement>(document.body, "button", { name: "Send" });
  expect(field.parentElement?.classList.contains("sticker-composer-field")).toBe(true);
  expect(trigger.classList.contains("size-11")).toBe(true);
  expect(send.classList.contains("size-11")).toBe(true);
  expect(send.classList.contains("send-button-themed")).toBe(true);
  expect(send.classList.contains("disabled:opacity-50")).toBe(true);
  expect(send.disabled).toBe(true);

  await click(trigger);
  const expanded = getByRole(document.body, "button", { name: phone ? "Show keyboard" : "Emoji and stickers", expanded: true });
  expect(expanded).toBe(trigger);
  expect(expanded.classList.contains("sticker-composer-trigger")).toBe(true);
  expect(expanded.querySelector("svg")?.getAttribute("data-icon")).toBe(phone ? "keyboard" : "emoji");
  await act(async () => fireEvent.change(field, { target: { value: "Hello" } }));
  expect(send.disabled).toBe(false);
  await act(async () => fireEvent.change(field, { target: { value: "  " } }));
  expect(send.disabled).toBe(true);
});

it.each([false, true])("closes the sticker picker on Edit and blocks pack sends until editing ends (phone=%s)", async (phone) => {
  if (phone) handset();
  const send = vi.fn();
  const saveEdit = vi.fn(async () => true);
  function EditableChat() {
    const [editing, setEditing] = useState(false);
    const text = { id: "text", conversationId: "chat", senderId: "alice", content: "Original", type: "text", status: "sent",
      timestamp: 1000, expiresAt: null, expiryKind: "retention" } as const;
    return <>
      <MessageBubble message={text} isOwn onEdit={() => setEditing(true)} />
      <MessageBubble message={{ ...text, id: "sticker", content: "[[sticker:genshin:genshin_hoyolab_21]]" }} isOwn />
      <MessageInput onSend={send} editing={editing ? text : undefined} onSaveEdit={saveEdit} onCancelEdit={() => setEditing(false)} />
    </>;
  }
  await dom.render(<QueryClientProvider client={new QueryClient()}><ToastProvider><StickerProvider><EditableChat /></StickerProvider></ToastProvider></QueryClientProvider>);
  const field = getByRole<HTMLTextAreaElement>(document.body, "textbox", { name: "Message" });
  await act(async () => fireEvent.change(field, { target: { value: "Unsent draft" } }));
  await click(getByRole(document.body, "button", { name: "Emoji and stickers" }));
  await click(getByRole(document.body, "tab", { name: "Stickers" }));
  const [text] = dom.container().querySelectorAll("article");
  await click(getByRole(text, "button", { name: "Message actions" }));
  await click(getByRole(document.body, "menuitem", { name: "Edit message" }));
  expect(queryByRole(document.body, "tablist", { name: "Emoji and stickers" })).toBeNull();
  expect(field.value).toBe("Original");
  expect(document.activeElement).toBe(field);

  const openPack = await waitFor(() => getByRole(document.body, "button", { name: /open sticker pack/i }));
  await click(openPack);
  const pack = () => getByRole(document.body, "dialog", { name: "Paimon's Paintings 1" });
  expect(queryByRole(pack(), "button", { name: "Send sticker" })).toBeNull();
  expect(send).not.toHaveBeenCalled();
  await press("Escape");

  await click(getByRole(document.body, "button", { name: "Add emoji" }));
  const tabs = getByRole(document.body, "tablist", { name: "Add emoji" });
  expect(queryByRole(tabs, "tab", { name: "Stickers" })).toBeNull();
  expect(getByRole(tabs, "tab", { name: "Emoji", selected: true })).toBeTruthy();
  await act(async () => fireEvent.change(field, { target: { value: "Revised" } }));
  await click(getByRole(document.body, "button", { name: "Save" }));
  expect(saveEdit).toHaveBeenCalledExactlyOnceWith("text", "Revised");
  expect(field.value).toBe("Unsent draft");
  await click(openPack);
  await click(getByRole(pack(), "button", { name: "Send sticker" }));
  expect(send).toHaveBeenCalledExactlyOnceWith("[[sticker:genshin:genshin_hoyolab_21]]", { ttlSeconds: null });
});

it("mounts only neighbouring grids and focuses an immediate keyboard jump in RTL", async () => {
  const pack = await openPicker();
  expect(document.querySelectorAll(".sticker-page [data-sticker-tile]")).toHaveLength(32);
  document.documentElement.dir = "rtl";
  try {
    pack.focus();
    await press("End");
    expect(document.activeElement).toBe(getByRole(document.body, "tab", { name: "Paimon's Paintings 53", selected: true }));
    expect(document.querySelectorAll(".sticker-page [data-sticker-tile]")).toHaveLength(32);
    await press("ArrowDown");
    expect(document.activeElement).toBe(tile());
    await press("PageUp");
    expect(document.activeElement).toBe(tile());
    expect(getByRole(document.body, "tab", { name: "Paimon's Paintings 52", selected: true })).toBeTruthy();
    await press("ArrowRight");
    expect(document.activeElement).toBe(tile(3));
    expect(getByRole(document.body, "tab", { name: "Paimon's Paintings 51", selected: true })).toBeTruthy();
  } finally { document.documentElement.dir = "ltr"; }
});

it("jumps the cover strip on a saved distant pack and on nonadjacent navigation", async () => {
  const original = useAuthStore.getState();
  const key = storage.stickerStateKey("saved-pack", "device");
  await storage.updateStickerState(key, () => ({ ...storage.defaultStickerState, tab: "stickers", page: "genshin-53" }));
  useAuthStore.setState({ user: { id: "saved-pack" }, device: { id: "device" }, sessionId: "session" } as never);
  const scroll = vi.fn();
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("sticker-strip")) {
      this.scrollBy = scroll;
      return new DOMRect(0, 0, 250, 48);
    }
    return new DOMRect(600, 0, 48, 48);
  });
  try {
    await dom.render(<QueryClientProvider client={new QueryClient()}><ToastProvider><StickerProvider><Chat send={vi.fn()} /></StickerProvider></ToastProvider></QueryClientProvider>);
    await click(getByRole(document.body, "button", { name: "Emoji and stickers" }));
    await waitFor(() => getByRole(document.body, "tab", { name: "Paimon's Paintings 53", selected: true }));
    expect(scroll).toHaveBeenCalled();
    expect(scroll.mock.calls.every(([options]) => options.behavior === "instant")).toBe(true);

    await click(getByRole(document.body, "tab", { name: "Paimon's Paintings 15" }));
    expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "instant" }));
    await click(getByRole(document.body, "tab", { name: "Paimon's Paintings 16" }));
    expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "smooth" }));
  } finally {
    rect.mockRestore();
    await act(async () => useAuthStore.setState(original));
  }
});

it("queues zero messages for loading tiles, drags, scrolls, cancellation, an edge gesture or release over another tile", async () => {
  const send = vi.fn();
  let showArt!: () => void;
  const loading = new Promise<void>((resolve) => { showArt = resolve; });
  spriteIO.network.mockImplementation(async (url) => {
    if (url.endsWith("/thumb/genshin-1.webp")) await loading;
    return spriteResponse(url);
  });
  await openPicker(send);
  const first = tile();
  await tap(first);
  await act(async () => { pointer(first, "pointerdown"); showArt(); });
  await load(first);
  await act(async () => pointer(first, "pointerup"));
  await act(async () => {
    for (const [x, y] of [[121, 100], [100, 121], [111, 111]]) {
      pointer(first, "pointerdown");
      pointer(first, "pointermove", x, y);
      pointer(first, "pointerup", x, y);
      fireEvent.click(first, { detail: 1 });
    }
    pointer(first, "pointerdown");
    fireEvent.scroll(first.closest("section")!);
    pointer(first, "pointerup");
    pointer(first, "pointerdown");
    pointer(first, "pointercancel");
    pointer(first, "pointerup");
    pointer(first, "pointerdown", 12, 100);
    pointer(first, "pointermove", 33, 100);
    pointer(first, "pointerup", 33, 100);
    pointer(first, "pointerdown");
    pointer(tile(1), "pointerup");
  });
  expect(send).not.toHaveBeenCalled();
  await tap(first);
  await tap(first);
  expect(send).toHaveBeenCalledExactlyOnceWith("[[sticker:genshin:genshin_hoyolab_21]]", { ttlSeconds: null });
});

it("sends a ready sticker tapped without movement inside either phone edge", async () => {
  handset();
  vi.stubGlobal("innerWidth", 400);
  const send = vi.fn();
  await openPicker(send);
  const left = tile(), right = tile(3);
  await load(left);
  await load(right);
  await act(async () => {
    for (const [target, x] of [[left, 12], [right, 388]] as const) {
      pointer(target, "pointerdown", x, 100);
      pointer(target, "pointerup", x, 100);
      fireEvent.click(target, { detail: 1 });
    }
  });
  expect(send.mock.calls.map(([value]) => value)).toEqual([
    "[[sticker:genshin:genshin_hoyolab_21]]",
    "[[sticker:genshin:genshin_hoyolab_24]]",
  ]);
});

it("freezes Recent order until the page is shown again and ignores a second tap at the same position", async () => {
  const send = vi.fn();
  await openPicker(send);
  await load(tile()); await load(tile(1));
  await tap(tile()); await tap(tile(1));
  await click(getByRole(document.body, "tab", { name: "Recent" }));
  expect(tile(1).dataset.stickerId).toBe("genshin_hoyolab_21");
  await load(tile(1));
  // Send the same ID again after the send guard expires.
  const time = Date.now();
  const now = vi.spyOn(Date, "now").mockReturnValue(time + 401);
  try {
    await tap(tile(1)); await tap(tile(1));
    expect(tile(1).dataset.stickerId).toBe("genshin_hoyolab_21");
    expect(send).toHaveBeenCalledTimes(3);
    await click(getByRole(document.body, "tab", { name: "Paimon's Paintings 1" }));
    await click(getByRole(document.body, "tab", { name: "Recent" }));
    expect(tile().dataset.stickerId).toBe("genshin_hoyolab_21");
  } finally { now.mockRestore(); }
});

it("opens only the preview on hold, then dismisses one phone layer per Back", async () => {
  handset();
  const back = mockCloseRequests();
  const send = vi.fn();
  await openPicker(send);
  await load(tile());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    pointer(tile(), "pointerdown");
    await vi.advanceTimersByTimeAsync(500);
  });
  const menu = getByRole(document.body, "menu");
  await act(async () => {
    pointer(tile(), "pointerup");
    fireEvent.click(tile(), { detail: 1 });
  });
  expect(send).not.toHaveBeenCalled();
  expect(menu.isConnected).toBe(true);
  vi.useRealTimers();
  await back();
  expect(queryByRole(document.body, "menu")).toBeNull();
  expect(getByRole(document.body, "region", { name: "Emoji and stickers" })).toBeTruthy();
  await back();
  expect(queryByRole(document.body, "region", { name: "Emoji and stickers" })).toBeNull();
});

it("keeps the desktop picker open after preview dismissal and pack sheet sending", async () => {
  const send = vi.fn();
  await openPicker(send);
  const first = tile();
  await act(async () => fireEvent.contextMenu(first, { clientX: 100, clientY: 100 }));
  expect(document.querySelector(".message-action-popover .sticker-menu-preview")).toBeTruthy();
  await press("Escape");
  expect(queryByRole(document.body, "menu")).toBeNull();
  expect(document.activeElement).toBe(first);
  const open = getByRole(document.body, "button", { name: "Open Paimon's Paintings 1" });
  await click(open);
  const sheet = getByRole(document.body, "dialog", { name: "Paimon's Paintings 1" });
  await click(getByRole(sheet, "button", { name: "Send sticker" }));
  expect(queryByRole(document.body, "dialog", { name: "Paimon's Paintings 1" })).toBeNull();
  expect(document.activeElement).toBe(open);
  expect(getByRole(document.body, "dialog", { name: "Emoji and stickers" })).toBeTruthy();
  expect(send).toHaveBeenCalledTimes(1);
});

it("retries a failed desktop preview from the keyboard menu and keeps the preview open", async () => {
  const path = `${spriteBase}/packs/full/genshin-1.webp`;
  let unavailable = true;
  spriteIO.network.mockImplementation(async (url) =>
    url === path && unavailable ? new Response(null, { status: 503 }) : spriteResponse(url));
  await openPicker();
  const first = tile();
  await act(async () => first.focus());
  await press("F10", { shiftKey: true });
  const menu = getByRole(document.body, "menu");
  const retry = await waitFor(() => getByRole(menu, "menuitem", { name: "Retry" }));
  await press("End");
  expect(document.activeElement).toBe(retry);
  unavailable = false;
  await click(retry);
  await waitFor(() => expect(menu.closest(".message-action-popover")?.querySelector(".sticker-menu-art .sticker-art[style]")).toBeTruthy());
  expect(document.activeElement).toBe(menu);
  expect(spriteIO.network.mock.calls.filter(([url]) => url === path).map(([, options]) => options.cache)).toEqual(["default", "reload"]);
  await press("ArrowDown");
  expect(document.activeElement).toBe(getByRole(menu, "menuitem", { name: "Send sticker" }));
  await press("Escape");
  expect(document.activeElement).toBe(first);
});

it("leaves the draft, caret and staged attachment intact when dismissing the phone panel", async () => {
  handset();
  await dom.render(<QueryClientProvider client={new QueryClient()}><ToastProvider><StickerProvider><Chat send={vi.fn()} /></StickerProvider></ToastProvider></QueryClientProvider>);
  const input = getByRole<HTMLTextAreaElement>(document.body, "textbox", { name: "Message" });
  input.focus();
  await act(async () => {
    fireEvent.change(input, { target: { value: "private draft" } });
    input.setSelectionRange(3, 3);
    const file = new File(["document"], "note.txt", { type: "text/plain" });
    fireEvent.drop(input, { dataTransfer: { files: [file] } });
  });
  await click(getByRole(document.body, "button", { name: "Emoji and stickers" }));
  expect(document.activeElement).not.toBe(input);
  await press("Escape");
  expect(input.value).toBe("private draft");
  expect(input.selectionStart).toBe(3);
  expect(getByRole(document.body, "button", { name: "Remove attachment" })).toBeTruthy();
});

it("keeps the favourite Undo button reachable inside a pack dialog", async () => {
  const original = useAuthStore.getState();
  const key = storage.stickerStateKey("sheet-user", "sheet-device");
  await storage.updateStickerState(key, () => storage.defaultStickerState);
  useAuthStore.setState({ user: { id: "sheet-user" }, device: { id: "sheet-device" }, sessionId: "sheet-session" } as never);
  try {
    await openPicker();
    await click(getByRole(document.body, "button", { name: "Open Paimon's Paintings 1" }));
    const pack = getByRole(document.body, "dialog", { name: "Paimon's Paintings 1" });
    await click(getByRole(pack, "button", { name: "Add to favourites" }));
    await click(await waitFor(() => getByRole(pack, "button", { name: "Remove from favourites" })));
    const undo = await waitFor(() => getByRole(pack, "button", { name: "Undo" }));
    undo.focus();
    expect(document.activeElement).toBe(undo);
    await click(undo);
    expect(await waitFor(() => getByRole(pack, "button", { name: "Remove from favourites" }))).toBeTruthy();
  } finally { await act(async () => useAuthStore.setState(original)); }
});

it("includes a send already queued when Recent opens before IndexedDB finishes", async () => {
  const original = useAuthStore.getState();
  const key = storage.stickerStateKey("recent-user", "recent-device");
  await storage.updateStickerState(key, () => storage.defaultStickerState);
  useAuthStore.setState({
    user: { id: "recent-user" }, device: { id: "recent-device" }, sessionId: "recent-session",
  } as never);
  let releaseWrite!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const send = vi.fn();
  const updateStickerState = storage.updateStickerState;
  const write = vi.spyOn(storage, "updateStickerState");
  try {
    await openPicker(send);
    await waitFor(async () => expect((await storage.readStickerState(key)).tab).toBe("stickers"));
    write.mockImplementationOnce(async (...args) => {
      await blocked;
      return updateStickerState(...args);
    });
    await load(tile());
    await tap(tile());
    expect(send).toHaveBeenCalledTimes(1);
    await click(getByRole(document.body, "tab", { name: "Recent" }));
    expect(getByRole(document.body, "tab", { name: "Recent", selected: true })).toBeTruthy();
    expect(tile()).toBeNull();
    await act(async () => releaseWrite());
    await waitFor(() => expect(tile()?.dataset.stickerId).toBe("genshin_hoyolab_21"));
  } finally {
    releaseWrite();
    write.mockRestore();
    await act(async () => useAuthStore.setState(original));
  }
});

it("retries a failed thumbnail sprite once and restores all mounted tiles in the pack", async () => {
  const path = `${spriteBase}/packs/thumb/genshin-1.webp`;
  let unavailable = true;
  spriteIO.network.mockImplementation(async (url) =>
    url === path && unavailable ? new Response(null, { status: 503 }) : spriteResponse(url));
  const send = vi.fn();
  await openPicker(send);
  await waitFor(() => expect(tile(0).getAttribute("aria-label")).toMatch(/did not load/));
  expect(tile(1).getAttribute("aria-label")).toMatch(/did not load/);
  unavailable = false;
  await tap(tile(0));
  await load(tile(0));
  await load(tile(1));
  expect(spriteIO.network.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
  expect(send).not.toHaveBeenCalled();
  await tap(tile(1));
  expect(send).toHaveBeenCalledTimes(1);
});

it("retries a failed full-size pack preview from the sheet", async () => {
  const path = `${spriteBase}/packs/full/genshin-1.webp`;
  let unavailable = true;
  spriteIO.network.mockImplementation(async (url) =>
    url === path && unavailable ? new Response(null, { status: 503 }) : spriteResponse(url));
  await openPicker();
  await click(getByRole(document.body, "button", { name: "Open Paimon's Paintings 1" }));
  const sheet = getByRole(document.body, "dialog", { name: "Paimon's Paintings 1" });
  const retry = await waitFor(() => getByRole(sheet, "button", { name: /did not load/ }));
  unavailable = false;
  await click(retry);
  await waitFor(() => expect(sheet.querySelector<HTMLElement>(".sticker-pack-hero .sticker-art[style]")?.style.backgroundImage).toContain("blob:sticker-full"));
  expect(spriteIO.network.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
});

it("selects a failed thumbnail in the pack sheet and retries thumbnails through a separate control", async () => {
  const path = `${spriteBase}/packs/thumb/genshin-1.webp`;
  let unavailable = true;
  spriteIO.network.mockImplementation(async (url) =>
    url === path && unavailable ? new Response(null, { status: 503 }) : spriteResponse(url));
  const send = vi.fn();
  await openPicker(send);
  await click(getByRole(document.body, "button", { name: "Open Paimon's Paintings 1" }));
  const sheet = getByRole(document.body, "dialog", { name: "Paimon's Paintings 1" });
  const retry = await waitFor(() => getByRole(sheet, "button", { name: "Retry thumbnails" }));
  const failedTile = getByRole(sheet, "button", { name: "Sticker 2 of 16, Paimon's Paintings 1", pressed: false });
  await tap(failedTile);
  expect(failedTile.getAttribute("aria-pressed")).toBe("true");
  expect(await waitFor(() => getByRole(sheet, "img", { name: "Sticker 2 of 16, Paimon's Paintings 1" }))).toBeTruthy();
  expect(spriteIO.network.mock.calls.filter(([url]) => url === path)).toHaveLength(1);
  unavailable = false;
  await click(retry);
  await load(failedTile);
  expect(spriteIO.network.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
  expect(send).not.toHaveBeenCalled();
});

it("wraps Tab through the pack sheet's current roving grid stop", async () => {
  await openPicker();
  await click(getByRole(document.body, "button", { name: "Open Paimon's Paintings 1" }));
  const sheet = getByRole(document.body, "dialog", { name: "Paimon's Paintings 1" });
  const close = getByRole(sheet, "button", { name: "Close" });
  const grid = getByRole(sheet, "group", { name: "Stickers in Paimon's Paintings 1" });
  const first = grid.querySelector<HTMLButtonElement>('[data-sticker-tile="0"]')!;
  const second = grid.querySelector<HTMLButtonElement>('[data-sticker-tile="1"]')!;
  await act(async () => close.focus());
  await press("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(first);
  await press("ArrowRight");
  expect(document.activeElement).toBe(second);
  expect(first.tabIndex).toBe(-1);
  expect(second.tabIndex).toBe(0);
  await press("Tab");
  expect(document.activeElement).toBe(close);
  await press("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(second);
});

it("re-reads recents committed in another tab when reopening the picker", async () => {
  const original = useAuthStore.getState();
  const key = storage.stickerStateKey("shared-recent", "device");
  const first = "genshin_hoyolab_21", second = "genshin_hoyolab_22";
  await storage.updateStickerState(key, () => ({ ...storage.defaultStickerState, recent: [first] }));
  useAuthStore.setState({ user: { id: "shared-recent" }, device: { id: "device" }, sessionId: "session" } as never);
  try {
    await openPicker();
    await click(getByRole(document.body, "tab", { name: "Recent" }));
    await waitFor(() => expect(tile()?.dataset.stickerId).toBe(first));
    await press("Escape");
    expect(queryByRole(document.body, "dialog", { name: "Emoji and stickers" })).toBeNull();
    await storage.updateStickerState(key, (state) => storage.recordRecent(state, second));
    await click(getByRole(document.body, "button", { name: "Emoji and stickers" }));
    await waitFor(() => {
      expect(tile()?.dataset.stickerId).toBe(second);
      expect(tile(1)?.dataset.stickerId).toBe(first);
    });
  } finally { await act(async () => useAuthStore.setState(original)); }
});

it("includes pending sends when opening on the saved Recent page", async () => {
  const original = useAuthStore.getState();
  const key = storage.stickerStateKey("saved-recent", "device");
  await storage.updateStickerState(key, () => ({ ...storage.defaultStickerState, tab: "stickers", page: "recent" }));
  useAuthStore.setState({ user: { id: "saved-recent" }, device: { id: "device" }, sessionId: "session" } as never);
  let releaseWrite!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const updateStickerState = storage.updateStickerState;
  const write = vi.spyOn(storage, "updateStickerState").mockImplementationOnce(async (...args) => {
    await blocked;
    return updateStickerState(...args);
  });
  function PackAction() {
    const picker = useStickerPicker()!;
    return <button type="button" disabled={picker.state.page !== "recent" || !picker.canSend}
      onClick={() => picker.send("genshin_hoyolab_21")}>Send from pack</button>;
  }
  try {
    await dom.render(<QueryClientProvider client={new QueryClient()}><ToastProvider><StickerProvider>
      <Chat send={vi.fn()} /><PackAction />
    </StickerProvider></ToastProvider></QueryClientProvider>);
    const fromPack = getByRole<HTMLButtonElement>(document.body, "button", { name: "Send from pack" });
    await waitFor(() => expect(fromPack.disabled).toBe(false));
    await click(fromPack);
    await click(getByRole(document.body, "button", { name: "Emoji and stickers" }));
    await waitFor(() => getByRole(document.body, "tab", { name: "Recent", selected: true }));
    expect(tile()).toBeNull();
    await act(async () => { releaseWrite(); await write.mock.results[0].value; });
    await waitFor(() => expect(tile()?.dataset.stickerId).toBe("genshin_hoyolab_21"));
  } finally {
    releaseWrite();
    write.mockRestore();
    await act(async () => useAuthStore.setState(original));
  }
});
