import { vi } from "vitest";
import type { Sticker } from "./catalog.js";
import runtime from "./catalog.runtime.json";

type FixtureHash = { update(text: string): FixtureHash; digest(encoding: "hex"): string };
const { createHash, webcrypto } = await vi.importActual<{
  createHash: (algorithm: "sha256") => FixtureHash;
  webcrypto: Crypto;
}>("node:crypto");

export const spriteBase = "https://dist.718788.xyz/private-base/assets/stickers/genshin/v2";

function spriteFixture(size: string, packId: string) {
  return `${size}:${packId.padStart("genshin-00".length, "0")}`;
}

const catalogHashes = new Map(runtime.packs.flatMap(({ id, sprites }) =>
  Object.entries(sprites).map(([size, sprite]) => [spriteFixture(size, id), sprite.sha256] as const)));

export function spriteSource(set: number): Pick<Sticker, "pack" | "assetBase"> {
  const id = `genshin-${set}`;
  const digest = (size: string) => createHash("sha256").update(spriteFixture(size, id)).digest("hex");
  return { assetBase: spriteBase, pack: {
    id, set, cover: "", stickers: [],
    sprites: { full: { tileSize: 320, sha256: digest("full") }, thumb: { tileSize: 128, sha256: digest("thumb") } },
  } };
}

export function spriteResponse(url: string) {
  const [size, file] = url.split("/").slice(-2);
  return new Response(spriteFixture(size, file.replace(/\.webp$/, "")), {
    headers: { "content-type": "image/webp" },
  });
}

export function mockSpriteIO({ catalog = false } = {}) {
  const network = vi.fn(async (url: string, _options: RequestInit) => spriteResponse(url));
  const revoke = vi.fn();
  const decode = vi.fn(async () => undefined);
  // UI tests use synthetic WebPs with the bundled metadata. Resource tests use real digests.
  vi.stubGlobal("crypto", catalog ? {
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    subtle: { async digest(algorithm: string, bytes: ArrayBuffer) {
      const hash = catalogHashes.get(new TextDecoder().decode(bytes));
      return hash ? Uint8Array.from(hash.match(/../g)!, (pair) => Number.parseInt(pair, 16)).buffer : webcrypto.subtle.digest(algorithm, bytes);
    } },
  } : webcrypto);
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL(blob: Blob) { return blob.size === spriteFixture("thumb", "genshin-1").length ? "blob:sticker-thumb" : "blob:sticker-full"; }
    static revokeObjectURL = revoke;
  });
  vi.stubGlobal("Image", class {
    src = "";
    get naturalWidth() { return this.src.includes("thumb") ? 512 : 1280; }
    get naturalHeight() { return this.naturalWidth; }
    decode = decode;
  });
  return { network, revoke, decode };
}
