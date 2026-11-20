type Frame = RTCEncodedAudioFrame | RTCEncodedVideoFrame;
export interface GroupFrameKey { epoch: number; key: CryptoKey; validUntil?: number }

const prefixBytes = 20;

export function groupFrameTransform(
  mode: "sender" | "receiver",
  current: () => GroupFrameKey | null,
  authenticated: (epoch: number) => void,
): TransformStream<Frame, Frame> {
  let reportedEpoch = 0;
  return new TransformStream({
    async transform(frame, controller) {
      const slot = current();
      if (!slot || (slot.validUntil !== undefined && slot.validUntil <= Date.now())) return;
      const data = new Uint8Array(frame.data);
      try {
        if (mode === "sender") {
          const header = new Uint8Array(prefixBytes);
          new DataView(header.buffer).setBigUint64(0, BigInt(slot.epoch));
          crypto.getRandomValues(header.subarray(8));
          const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: header.subarray(8), additionalData: header }, slot.key, data);
          const wire = new Uint8Array(prefixBytes + encrypted.byteLength);
          wire.set(header);
          wire.set(new Uint8Array(encrypted), prefixBytes);
          frame.data = wire.buffer;
        } else {
          if (data.length < prefixBytes + 16 || new DataView(data.buffer).getBigUint64(0) !== BigInt(slot.epoch)) return;
          frame.data = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: data.subarray(8, prefixBytes), additionalData: data.subarray(0, prefixBytes) },
            slot.key, data.subarray(prefixBytes));
        }
      } catch { return; }
      if (current() !== slot || (slot.validUntil !== undefined && slot.validUntil <= Date.now())) return;
      if (mode === "receiver" && reportedEpoch !== slot.epoch) {
        reportedEpoch = slot.epoch;
        authenticated(slot.epoch);
      }
      controller.enqueue(frame);
    },
  });
}
