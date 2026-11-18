import { afterEach, expect, it, vi } from "vitest";
import { packSprite } from "./pack-assets.js";
import { mockSpriteIO, spriteBase, spriteResponse, spriteSource } from "./pack-assets.test-utils.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("fetches and decodes one credentialless sprite shared by mounted consumers of its pack and size", async () => {
  const { network, revoke, decode } = mockSpriteIO();
  const source = spriteSource(1);
  const a = packSprite(source, "full");
  const b = packSprite(source, "full");
  const first = vi.fn();
  const second = vi.fn();
  const releaseA = a.subscribe(first);
  const releaseB = b.subscribe(second);
  try {
    expect(a).toBe(b);
    const loading = a.start();
    expect(b.start()).toBeUndefined();
    await loading;
    expect(a.snapshot()).toEqual({ state: "ready", url: "blob:sticker-full" });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledExactlyOnceWith(`${spriteBase}/packs/full/genshin-1.webp`, expect.objectContaining({
      credentials: "omit", mode: "cors", referrerPolicy: "no-referrer", redirect: "error",
    }));
    releaseA();
    expect(revoke).not.toHaveBeenCalled();
  } finally { releaseA(); releaseB(); }
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:sticker-full");
});

it("shares a failed decode and a single successful pack retry with every subscriber", async () => {
  const { network, decode } = mockSpriteIO();
  decode.mockRejectedValueOnce(new Error("Invalid WebP"));
  const sprite = packSprite(spriteSource(2), "thumb");
  const seen: string[] = [];
  const release = sprite.subscribe(() => seen.push(sprite.snapshot().state));
  try {
    await sprite.start();
    expect(sprite.snapshot().state).toBe("failed");
    const retry = sprite.retry();
    expect(sprite.retry()).toBeUndefined();
    await retry;
    expect(sprite.snapshot().state).toBe("ready");
    expect(seen).toEqual(["loading", "failed", "loading", "ready"]);
    expect(network.mock.calls.map(([url]) => url)).toEqual(Array(2).fill(`${spriteBase}/packs/thumb/genshin-2.webp`));
  } finally { release(); }
});

it("times out a stalled fetch and allows a fresh retry", async () => {
  vi.useFakeTimers();
  const { network } = mockSpriteIO();
  network.mockImplementationOnce(async (_url, { signal }) => new Promise((_, reject) => {
    signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const sprite = packSprite(spriteSource(3), "full");
  const release = sprite.subscribe(() => undefined);
  try {
    const pending = sprite.start();
    await vi.advanceTimersByTimeAsync(8000);
    await pending;
    expect(sprite.snapshot().state).toBe("failed");
    await sprite.retry();
    expect(sprite.snapshot().state).toBe("ready");
    expect(network).toHaveBeenCalledTimes(2);
  } finally { release(); }
});

it("allows a sprite download to exceed eight seconds while bytes are arriving", async () => {
  const { network, decode } = mockSpriteIO();
  const bytes = new Uint8Array(await spriteResponse(`${spriteBase}/packs/full/genshin-4.webp`).arrayBuffer());
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  network.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })));
  const sprite = packSprite(spriteSource(4), "full");
  const release = sprite.subscribe(() => undefined);
  try {
    const pending = sprite.start();
    for (const chunk of [bytes.slice(0, 4), bytes.slice(4, 8), bytes.slice(8)]) {
      await vi.advanceTimersByTimeAsync(6_000);
      expect(sprite.snapshot().state).toBe("loading");
      stream.enqueue(chunk);
    }
    stream.close();
    await pending;
    expect(sprite.snapshot().state).toBe("ready");
    expect(decode).toHaveBeenCalledOnce();
    expect(network).toHaveBeenCalledOnce();
  } finally { release(); }
});

it("fails and cancels a response that stalls after delivering bytes", async () => {
  vi.useFakeTimers();
  const { network, decode } = mockSpriteIO();
  const cancel = vi.fn();
  network.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    cancel,
  })));
  const sprite = packSprite(spriteSource(5), "full");
  const release = sprite.subscribe(() => undefined);
  try {
    const pending = sprite.start();
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;
    expect(sprite.snapshot().state).toBe("failed");
    expect(cancel).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
    await sprite.retry();
    expect(sprite.snapshot().state).toBe("ready");
  } finally { release(); }
});
