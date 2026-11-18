import { expect, it } from "vitest";
import { isSticker, parseStickerToken, stickerToken } from "../../lib/stickers.js";
import catalog from "./catalog.genshin.json";
import runtime from "./catalog.runtime.json";
import ranges from "./catalog.ids.json";

it("keeps the slim runtime catalog and eager ID index in sync", () => {
  const runtimeSprite = ({ tileSize, sha256 }: { tileSize: number; sha256: string }) => ({ tileSize, sha256 });
  expect(runtime).toEqual({
    version: catalog.version,
    assetBase: catalog.assetBase,
    packs: catalog.packs.map(({ id, set, cover, stickers, sprites }) => ({
      id, set, cover, sprites: { full: runtimeSprite(sprites.full), thumb: runtimeSprite(sprites.thumb) },
      stickers: stickers.map(({ id, n, w, h, alt }: typeof stickers[number] & { alt?: Record<string, string> }) =>
        ({ id, n, w, h, ...(alt ? { alt } : {}) })),
    })),
  });
  expect(catalog.version).toBe(2);
  expect(catalog.assetBase).toMatch(/\/genshin\/v2$/);
  expect(catalog.packs).toHaveLength(53);
  for (const pack of catalog.packs) {
    expect(pack.stickers.map(({ n }) => n)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
    for (const { sha256, bytes } of Object.values(pack.sprites)) {
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(bytes).toBeGreaterThan(0);
    }
  }
  const indexed = ranges.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, i) => `genshin_hoyolab_${first + i}`));
  const expected = catalog.packs.flatMap(({ stickers }) => stickers.map(({ id }) => id));
  expect(indexed.sort()).toEqual(expected.sort());
  for (const id of expected) expect(parseStickerToken(stickerToken(id))).toBe(id);
});

it.each([
  "[[sticker:genshin:genshin_hoyolab_20]]",
  "[[sticker:genshin:genshin_hoyolab_818]]",
  "[[sticker:genshin:genshin_hoyolab_021]]",
  "[[sticker:other:genshin_hoyolab_21]]",
  "[[sticker:genshin:GENSHIN_hoyolab_21]]",
  " [[sticker:genshin:genshin_hoyolab_21]]",
  "[[sticker:genshin:genshin_hoyolab_21]]\n",
  "hey [[sticker:genshin:genshin_hoyolab_21]]",
  "[[sticker:genshin:genshin_hoyolab_21]][[sticker:genshin:genshin_hoyolab_22]]",
])("keeps invalid token %j as text", (content) => {
  expect(parseStickerToken(content)).toBeNull();
});

it("only classifies live text messages as stickers", () => {
  const content = stickerToken("genshin_hoyolab_21");
  expect(isSticker({ content, type: "text" })).toBe(true);
  expect(isSticker({ content, type: "file" })).toBe(false);
  expect(isSticker({ content, type: "text", deletedAt: 10 })).toBe(false);
});
