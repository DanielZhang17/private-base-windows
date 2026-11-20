import { expect, it } from "vitest";
import { groupFrameTransform, type GroupFrameKey } from "./group-frame-transform.js";

function frame(data: ArrayBuffer) {
  return { data } as RTCEncodedAudioFrame;
}

async function transform(mode: "sender" | "receiver", data: ArrayBuffer, key: GroupFrameKey | null) {
  const authenticated: number[] = [];
  const output: ArrayBuffer[] = [];
  const input = new ReadableStream({ start(controller) { controller.enqueue(frame(data)); controller.close(); } });
  await input.pipeThrough(groupFrameTransform(mode, () => key, (epoch) => authenticated.push(epoch))).pipeTo(
    new WritableStream({ write(received) { output.push(received.data); } }),
  );
  return { output, authenticated };
}

it("authenticates media before publication and drops tampered, missing-key, and stale-epoch frames", async () => {
  const local = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const plain = new TextEncoder().encode("frame").buffer;
  expect((await transform("sender", plain, null)).output).toEqual([]);
  expect((await transform("sender", plain, { epoch: 3, key: local, validUntil: Date.now() - 1 })).output).toEqual([]);
  const slot = { epoch: 3, key: local };
  const { output: [wire] } = await transform("sender", plain, slot);
  expect(new Uint8Array(wire)).not.toEqual(new Uint8Array(plain));
  expect(await transform("receiver", wire, slot)).toEqual({ output: [plain], authenticated: [3] });
  const corrupt = wire.slice(0);
  const bytes = new Uint8Array(corrupt);
  bytes[bytes.length - 1] ^= 1;
  for (const [input, key] of [[corrupt, slot], [plain, slot], [wire, null], [wire, { epoch: 4, key: fresh }]] as const) {
    expect(await transform("receiver", input, key)).toEqual({ output: [], authenticated: [] });
  }

  const rotated = { epoch: 4, key: fresh };
  const next = (await transform("sender", plain, rotated)).output[0];
  expect(await transform("receiver", next, slot)).toEqual({ output: [], authenticated: [] });
  expect(await transform("receiver", next, { epoch: 4, key: local })).toEqual({ output: [], authenticated: [] });
  expect(await transform("receiver", next, rotated)).toEqual({ output: [plain], authenticated: [4] });
});
