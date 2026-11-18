import { HISTORY_TRANSFER_VERSION } from "@e2ee-chat/shared";
import { hkdf } from "./hkdf.js";
import { ensureSodium, fromBase64Url } from "./utils.js";

export async function deriveHistoryTransferKeys(
  privateKey: Uint8Array,
  peerPublicKey: Uint8Array,
  context: {
    psk: string;
    roomId: string;
    receiverDeviceId: string;
    senderDeviceId: string;
    receiverPublicKey: string;
    senderPublicKey: string;
    pairingId: string;
    linkId: string;
  },
): Promise<{ toReceiver: Uint8Array; toSender: Uint8Array; checkCode: string }> {
  const sodium = await ensureSodium();
  // libsodium also rejects low-order public keys.
  const secret = sodium.crypto_scalarmult(privateKey, peerPublicKey);
  let master: Uint8Array | undefined;
  const psk = fromBase64Url(context.psk);
  try {
    if (psk.length !== 11) throw new Error("Invalid history transfer secret");
    const encoder = new TextEncoder();
    const { roomId, receiverDeviceId, senderDeviceId, receiverPublicKey, senderPublicKey, pairingId, linkId } = context;
    master = await hkdf(secret, psk,
      encoder.encode(JSON.stringify([`history-transfer-v${HISTORY_TRANSFER_VERSION}`, roomId, pairingId, receiverDeviceId, receiverPublicKey, senderDeviceId, senderPublicKey])), 32);
    const digits = await hkdf(master, new Uint8Array(), encoder.encode("check-code"), 8);
    const checkCode = String(new DataView(new Uint8Array(digits).buffer).getBigUint64(0) % 1_000_000n).padStart(6, "0");
    const keys = await hkdf(master, digits, encoder.encode(JSON.stringify(["data-channel", linkId])), 64);
    digits.fill(0);
    return { toReceiver: keys.subarray(0, 32), toSender: keys.subarray(32), checkCode };
  } finally {
    psk.fill(0);
    master?.fill(0);
    secret.fill(0);
  }
}
