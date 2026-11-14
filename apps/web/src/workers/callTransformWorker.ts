/// <reference lib="webworker" />

type EncodedFrame = RTCEncodedVideoFrame | RTCEncodedAudioFrame;

interface TransformOptions {
  kind: "sender" | "receiver";
  rawKey: Uint8Array;
}

function asArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

async function importCallKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    asArrayBufferView(rawKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function startTransform(
  transformer: RTCRtpScriptTransformer,
  options: TransformOptions,
): void {
  void (async () => {
    const callKey = await importCallKey(options.rawKey);

    await transformer.readable
      .pipeThrough(new TransformStream<EncodedFrame, EncodedFrame>({
        async transform(frame, controller) {
          const data = new Uint8Array(frame.data);

          try {
            if (options.kind === "sender") {
              // The key is shared by every track and both peers, so counters that
              // restart per transform would reuse AES-GCM nonces.
              const iv = crypto.getRandomValues(new Uint8Array(12));
              const encrypted = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv: asArrayBufferView(iv) },
                callKey,
                asArrayBufferView(data),
              );
              const nextData = new Uint8Array(12 + encrypted.byteLength);
              nextData.set(iv, 0);
              nextData.set(new Uint8Array(encrypted), 12);
              frame.data = nextData.buffer;
            } else {
              if (data.length < 12) return;
              const iv = data.slice(0, 12);
              const ciphertext = data.slice(12);
              const decrypted = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: asArrayBufferView(iv) },
                callKey,
                asArrayBufferView(ciphertext),
              );
              frame.data = decrypted;
            }
          } catch {
            return;
          }

          controller.enqueue(frame);
        },
      }))
      .pipeTo(transformer.writable);
  })().catch((error) => {
    console.error("Call transform worker failed", error);
  });
}

self.addEventListener("rtctransform", (event) => {
  const transformer = (event as RTCTransformEvent).transformer;
  const options = transformer.options as TransformOptions;
  startTransform(transformer, options);
});
