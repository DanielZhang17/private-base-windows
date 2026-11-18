import { act } from "react";
import { getByRole, queryByRole, waitFor, within } from "@testing-library/dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAppDB } from "../../db/index.js";
import { ToastProvider } from "../../ui/index.js";
import { click, setupDom } from "../../ui/test-utils.js";
import { useStickerPicker, StickerProvider } from "./useStickerPicker.js";
import { clearUnlockedSessionState } from "../../platform/session-cleanup.js";
import * as storage from "./storage.js";
import { addFavourite, defaultStickerState, readStickerState, stickerStateKey, updateStickerState } from "./storage.js";

vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "a" }, device: { id: "d" }, sessionId: "session" })) };
});

const dom = setupDom();
const key = stickerStateKey("a", "d");
const id = "genshin_hoyolab_21";

function Tab({ name }: { name: string }) {
  const picker = useStickerPicker()!;
  const favourite = picker.state.favourites.some((entry) => entry.id === id);
  return <section aria-label={name}>
    <button type="button" onClick={() => void picker.setFavourite(id, favourite ? "remove" : "add")}>{favourite ? "Remove" : "Add"}</button>
  </section>;
}

beforeEach(async () => { await updateStickerState(key, () => defaultStickerState); });
afterEach(async () => { await act(async () => clearUnlockedSessionState()); });

async function renderTabs() {
  await dom.render(<ToastProvider>
    <StickerProvider><Tab name="First tab" /></StickerProvider>
    <StickerProvider><Tab name="Second tab" /></StickerProvider>
  </ToastProvider>);
  const first = within(getByRole(document.body, "region", { name: "First tab" }));
  const second = within(getByRole(document.body, "region", { name: "Second tab" }));
  return { first, second };
}

it("treats the second tab's stale Add as an idempotent add", async () => {
  const { first, second } = await renderTabs();
  const addFirst = first.getByRole<HTMLButtonElement>("button", { name: "Add" });
  const addSecond = second.getByRole<HTMLButtonElement>("button", { name: "Add" });
  const update = vi.spyOn(storage, "updateStickerState");
  try {
    await act(async () => { addFirst.click(); addSecond.click(); });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await act(async () => { await update.mock.results[1].value; });
  } finally { update.mockRestore(); }
  await waitFor(() => second.getByRole("button", { name: "Remove" }));
  expect((await readStickerState(key)).favourites.map((entry) => entry.id)).toEqual([id]);
});

it("treats the second tab's stale Remove as an idempotent remove", async () => {
  await updateStickerState(key, (state) => addFavourite(state, { id, addedAt: 1 }));
  const { first, second } = await renderTabs();
  await waitFor(() => second.getByRole("button", { name: "Remove" }));
  const removeFirst = first.getByRole<HTMLButtonElement>("button", { name: "Remove" });
  const removeSecond = second.getByRole<HTMLButtonElement>("button", { name: "Remove" });
  const update = vi.spyOn(storage, "updateStickerState");
  try {
    await act(async () => { removeFirst.click(); removeSecond.click(); });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await act(async () => { await update.mock.results[1].value; });
  } finally { update.mockRestore(); }
  await waitFor(() => second.getByRole("button", { name: "Add" }));
  expect((await readStickerState(key)).favourites).toEqual([]);
});

it.each([false, true])("preserves Undo across navigation and clears it on lock (locked=%s)", async (locked) => {
  await updateStickerState(key, (state) => addFavourite(state, { id, addedAt: 1 }));
  const render = (inChat: boolean) => dom.render(<ToastProvider>
    {inChat ? <StickerProvider><Tab name="Chat" /></StickerProvider> : <p>Another page</p>}
  </ToastProvider>);
  await render(true);
  await click(await waitFor(() => getByRole(document.body, "button", { name: "Remove" })));
  await waitFor(() => getByRole(document.body, "button", { name: "Undo" }));
  await render(false);
  const undo = getByRole(document.body, "button", { name: "Undo" });
  if (locked) {
    await act(async () => clearUnlockedSessionState());
    expect(queryByRole(document.body, "button", { name: "Undo" })).toBeNull();
    await click(undo);
    expect((await readStickerState(key)).favourites).toEqual([]);
  } else {
    await click(undo);
    await waitFor(async () => expect((await readStickerState(key)).favourites).toEqual([{ id, addedAt: 1 }]));
  }
});

it("also invalidates an already captured Undo callback when the same account locks", async () => {
  await updateStickerState(key, (state) => addFavourite(state, { id, addedAt: 1 }));
  let undo: (() => void) | undefined;
  function SheetAction() {
    const picker = useStickerPicker()!;
    return <button type="button" onClick={() => void picker.setFavourite(id, "remove", {
      onFull: () => undefined, onRemoved: (restore) => { undo = restore; },
    })}>Remove</button>;
  }
  await dom.render(<ToastProvider><StickerProvider><SheetAction /></StickerProvider></ToastProvider>);
  await click(getByRole(document.body, "button", { name: "Remove" }));
  await waitFor(() => expect(undo).toBeTypeOf("function"));
  const write = vi.spyOn(storage, "updateStickerState");
  try {
    await act(async () => { clearUnlockedSessionState(); undo?.(); });
    expect(write).not.toHaveBeenCalled();
    expect((await readStickerState(key)).favourites).toEqual([]);
  } finally { write.mockRestore(); }
});

it.each(["Add", "Remove"] as const)("reports a failed %s commit and leaves favourites unchanged", async (intent) => {
  if (intent === "Remove") await updateStickerState(key, (state) => addFavourite(state, { id, addedAt: 1 }));
  const { first } = await renderTabs();
  const action = await waitFor(() => first.getByRole("button", { name: intent }));
  const before = await readStickerState(key);
  const fail = vi.spyOn(storage, "updateStickerState").mockImplementationOnce(async (_key, update) => {
    update(before);
    throw new Error("IndexedDB transaction aborted");
  });
  try {
    await click(action);
    const error = await waitFor(() => getByRole(document.body, "alert"));
    expect(error.textContent).toContain("Could not save favourites");
    expect(queryByRole(document.body, "button", { name: "Undo" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Added to favourites|Removed from favourites/);
    expect(first.getByRole("button", { name: intent })).toBeTruthy();
    expect((await readStickerState(key)).favourites).toEqual(before.favourites);
    await click(action);
    await waitFor(() => first.getByRole("button", { name: intent === "Add" ? "Remove" : "Add" }));
  } finally { fail.mockRestore(); }
});

it("updates a newly mounted picker when Undo commits through the old provider", async () => {
  await updateStickerState(key, (state) => addFavourite(state, { id, addedAt: 1 }));
  const render = (chat?: string) => dom.render(<ToastProvider>
    {chat ? <StickerProvider key={chat}><Tab name={chat} /></StickerProvider> : <p>Chat list</p>}
  </ToastProvider>);
  await render("Old chat");
  await click(await waitFor(() => getByRole(document.body, "button", { name: "Remove" })));
  await waitFor(() => getByRole(document.body, "button", { name: "Undo" }));
  await render();
  await render("New chat");
  const newChat = within(getByRole(document.body, "region", { name: "New chat" }));
  expect(newChat.getByRole("button", { name: "Add" })).toBeTruthy();
  await click(getByRole(document.body, "button", { name: "Undo" }));
  await waitFor(() => newChat.getByRole("button", { name: "Remove" }));
  expect((await readStickerState(key)).favourites).toEqual([{ id, addedAt: 1 }]);
});

it("re-reads committed favourites after an account and device scoped signal from another tab", async () => {
  await updateStickerState(key, (state) => addFavourite(state, { id, addedAt: 1 }));
  await dom.render(<ToastProvider><StickerProvider><Tab name="Chat" /></StickerProvider></ToastProvider>);
  await waitFor(() => getByRole(document.body, "button", { name: "Remove" }));

  // Write directly to IndexedDB to bypass the receiving tab's in-memory listener map.
  await (await getAppDB()).put("accountState", { id: key, value: 1, updatedAt: Date.now(), stickerPickerState: defaultStickerState });
  const signalKey = `privatebase:favourites:${key}`;
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: `${signalKey}-other-device`, newValue: "commit" })));
  expect(getByRole(document.body, "button", { name: "Remove" })).toBeTruthy();
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: signalKey, newValue: "commit" })));
  const add = await waitFor(() => getByRole(document.body, "button", { name: "Add" }));

  const publish = vi.spyOn(Storage.prototype, "setItem");
  try {
    await click(add);
    await waitFor(() => expect(publish).toHaveBeenCalledWith(signalKey, expect.any(String)));
    expect((await readStickerState(key)).favourites.map((entry) => entry.id)).toEqual([id]);
    expect(window.localStorage.getItem(signalKey)).toBeNull();
  } finally { publish.mockRestore(); }
});
