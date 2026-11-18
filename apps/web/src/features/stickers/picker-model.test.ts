import { expect, it } from "vitest";
import { allowStickerSend, gridTarget, keyboardHeight, pageAt, pageOffset, panelHeight, tabTarget } from "./picker-model.js";
import { addFavourite, defaultStickerState, readStickerState, recordRecent, stickerStateKey, updateStickerState } from "./storage.js";

it("round-trips page positions for 55 pages in LTR and RTL", () => {
  for (const rtl of [false, true]) {
    for (let page = 0; page < 55; page++) expect(pageAt(pageOffset(page, 360, rtl), 360, 55)).toBe(page);
  }
  expect(pageAt(-22000, 360, 55)).toBe(54);
  expect(tabTarget("Home", 54, 55, true)).toBe(0);
  expect(tabTarget("End", 0, 55, false)).toBe(54);
  expect(tabTarget("ArrowLeft", 54, 55, true)).toBe(0);
  expect(tabTarget("ArrowRight", 0, 55, true)).toBe(54);
});

it("crosses pack boundaries by row, mirrors the inline axis and clamps partial rows", () => {
  expect(gridTarget("ArrowRight", 7, 16, false)).toEqual({ page: 1, index: 4 });
  expect(gridTarget("ArrowLeft", 7, 16, true)).toEqual({ page: 1, index: 4 });
  expect(gridTarget("ArrowRight", 4, 16, true)).toEqual({ page: -1, index: 7 });
  expect(gridTarget("ArrowRight", 6, 7, false)).toEqual({ page: 1, index: 4 });
  expect(gridTarget("End", 4, 7, false)).toEqual({ page: 0, index: 6 });
  expect(gridTarget("Home", 5, 7, true, true)).toEqual({ page: 0, index: 0 });
  expect(gridTarget("ArrowDown", 3, 7, true)).toEqual({ page: 0, index: 6 });
  expect(gridTarget("ArrowUp", 1, 7, true)).toEqual({ page: 0, index: -3 });
  expect(gridTarget("PageDown", 9, 16, false)).toEqual({ page: 1, index: 0 });
});

it("measures resize and overlay keyboards without summing them, and caps short landscape panels", () => {
  expect(keyboardHeight(800, 480, 480, 0)).toBe(320);
  expect(keyboardHeight(800, 800, 440, 40)).toBe(320);
  expect(keyboardHeight(800, 520, 420, 20)).toBe(280);
  expect(panelHeight(320, true)).toBe(144);
  expect(panelHeight(480, false, 330)).toBe(240);
  expect(panelHeight(860, false, 600)).toBe(400);
  expect(allowStickerSend(1000, 1399)).toBe(false);
  expect(allowStickerSend(1000, 1400)).toBe(true);
});

it("caps recents at 30 and reorders only in the stored list", () => {
  let state = defaultStickerState;
  for (let i = 0; i < 35; i++) state = recordRecent(state, String(i));
  const before = state.recent;
  expect(before).toHaveLength(30);
  expect(before[0]).toBe("34");
  expect(before.at(-1)).toBe("5");
  expect(recordRecent(state, "7").recent[0]).toBe("7");
  expect(before[0]).toBe("34");
});

it("counts unavailable favourites toward the cap and applies concurrent writes atomically per account and device", async () => {
  const key = stickerStateKey("test-user", crypto.randomUUID());
  const entries = Array.from({ length: 199 }, (_, index) => ({ id: `unavailable-${index}`, addedAt: index }));
  await updateStickerState(key, (state) => ({ ...state, favourites: entries }));
  await Promise.all(["a", "b"].map((id) => updateStickerState(key, (state) => addFavourite(state, { id, addedAt: 200 }))));
  const state = await readStickerState(key);
  expect(state.favourites).toHaveLength(200);
  expect(state.favourites.filter(({ id }) => id === "a" || id === "b")).toHaveLength(1);
  expect(addFavourite(state, { id: "another", addedAt: 201 })).toBe(state);
  expect(await readStickerState(stickerStateKey("other-user", "test-device"))).toEqual(defaultStickerState);
});
