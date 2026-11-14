import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>("node:crypto");
let onTransform: (event: { transformer: unknown }) => void;
let rawKey: Uint8Array<ArrayBuffer>;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("self", { addEventListener: (_name: string, listener: typeof onTransform) => { onTransform = listener; } });
  await vi.importActual("./callTransformWorker.js");
  rawKey = new Uint8Array(16);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function transform(kind: "sender" | "receiver", data: ArrayBuffer): Promise<ArrayBuffer[]> {
  const output: ArrayBuffer[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const readable = new ReadableStream({ start(controller) { controller.enqueue({ data }); controller.close(); } });
  const writable = new WritableStream({ write(frame) { output.push(frame.data); }, close: finish });
  onTransform({ transformer: { options: { kind, rawKey }, readable, writable } });
  await done;
  return output;
}

it("encrypts WebKit worker frames with unique nonces across transforms and decrypts them", async () => {
  const plaintext = new Uint8Array([1, 2, 3, 4]).buffer;
  const [first] = await transform("sender", plaintext.slice(0));
  const [second] = await transform("sender", plaintext.slice(0));
  expect(first.byteLength).toBe(plaintext.byteLength + 12 + 16);
  expect(new Uint8Array(first).slice(0, 12)).not.toEqual(new Uint8Array(second).slice(0, 12));
  const [decrypted] = await transform("receiver", first);
  expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(plaintext));
});

it("drops WebKit sender frames when encryption fails without forwarding plaintext", async () => {
  vi.spyOn(crypto.subtle, "encrypt").mockRejectedValue(new Error("Encryption unavailable"));
  expect(await transform("sender", new Uint8Array([1, 2, 3]).buffer)).toEqual([]);
});

it("drops plaintext, truncated and unauthenticated WebKit receiver frames", async () => {
  expect(await transform("receiver", new Uint8Array(3).buffer)).toEqual([]);
  expect(await transform("receiver", new Uint8Array(40).buffer)).toEqual([]);
});
