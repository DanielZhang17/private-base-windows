import type { Sticker, StickerSprite } from "./catalog.js";

export type StickerSize = "thumb" | "full";
type PackSource = Pick<Sticker, "pack" | "assetBase">;
type SpriteSnapshot = { state: "idle" | "loading" | "failed"; url?: undefined } | { state: "ready"; url: string };

export const idleSprite: SpriteSnapshot = { state: "idle" };
const SPRITE_IDLE_TIMEOUT_MS = 8_000;
const MAX_SPRITE_BYTES = 4 * 1024 * 1024;
const sprites = new Map<string, ReturnType<typeof createSprite>>();

function createSprite(url: string, { tileSize, sha256 }: StickerSprite) {
  let snapshot = idleSprite as SpriteSnapshot;
  const listeners = new Set<() => void>();

  function release() {
    if (listeners.size || snapshot.state === "loading") return;
    if (snapshot.url) URL.revokeObjectURL(snapshot.url);
    snapshot = idleSprite;
  }

  function publish(next: SpriteSnapshot) {
    snapshot = next;
    listeners.forEach((listener) => listener());
    release();
  }

  async function fetchSprite(refresh: boolean) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const noteProgress = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), SPRITE_IDLE_TIMEOUT_MS);
    };
    let objectUrl: string | undefined;
    try {
      noteProgress();
      const response = await fetch(url, {
        credentials: "omit", mode: "cors", referrerPolicy: "no-referrer", redirect: "error",
        cache: refresh ? "reload" : "default", signal: controller.signal,
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error("Sprite unavailable");
      }
      noteProgress();
      let received = 0;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, output) {
          if (!chunk.byteLength) return;
          received += chunk.byteLength;
          if (received > MAX_SPRITE_BYTES) throw new Error("Sprite exceeds the import size limit");
          noteProgress();
          output.enqueue(chunk);
        },
      }), { signal: controller.signal });
      const bytes = await new Response(body).arrayBuffer();
      clearTimeout(timeout);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== sha256) throw new Error("Sprite digest mismatch");
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      if (image.naturalWidth !== tileSize * 4 || image.naturalHeight !== tileSize * 4) throw new Error("Invalid sprite dimensions");
      publish({ state: "ready", url: objectUrl });
    } catch {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      publish({ state: "failed" });
    } finally {
      clearTimeout(timeout);
    }
  }

  function load(refresh: boolean) {
    publish({ state: "loading" });
    return fetchSprite(refresh);
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); release(); };
    },
    snapshot: () => snapshot,
    start: () => { if (snapshot.state === "idle") return load(false); },
    retry: () => { if (snapshot.state === "failed") return load(true); },
  };
}

/** Resource identity contains the pack and size. Tile identity is only used in rendering. */
export function packSprite({ pack, assetBase }: PackSource, size: StickerSize) {
  const url = `${assetBase}/packs/${size}/${pack.id}.webp`;
  let sprite = sprites.get(url);
  if (!sprite) {
    sprite = createSprite(url, pack.sprites[size]);
    sprites.set(url, sprite);
  }
  return sprite;
}
