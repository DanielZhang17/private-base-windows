import { ensureSodium, toBase64Url, fromBase64Url, randomBytes } from "./utils.js";
import { hmacSha256 } from "./hkdf.js";
import * as aesGcm from "./aes-gcm.js";
import type { SenderKeyHeader } from "@e2ee-chat/shared";
import { openEditKey, sealEditKey, type EditKeyToOpen, type EditKeyToSeal, type SealedEditKey } from "./message-edits.js";

const SENDER_KEY_MSG_SEED = new TextEncoder().encode("SenderKeyMK");
const SENDER_KEY_CHAIN_SEED = new TextEncoder().encode("SenderKeyCK");
const MAX_CHAIN_GAP = 2_000;

export interface SenderKeyState {
  senderKeyId: number;
  chainKey: Uint8Array;
  signingPublicKey: Uint8Array; // Ed25519
  signingPrivateKey: Uint8Array; // Ed25519 (only for own sender key)
  chainIndex: number;
}

export interface SenderKeyDistribution {
  senderKeyId: number;
  chainKey: string; // Base64url
  signingPublicKey: string; // Base64url
  chainIndex: number;
}

export async function generateSenderKey(): Promise<SenderKeyState> {
  const sodium = await ensureSodium();
  const signingKeyPair = sodium.crypto_sign_keypair();
  return {
    senderKeyId: new DataView(crypto.getRandomValues(new Uint8Array(4)).buffer).getUint32(0, false),
    chainKey: randomBytes(32),
    signingPublicKey: signingKeyPair.publicKey,
    signingPrivateKey: signingKeyPair.privateKey,
    chainIndex: 0,
  };
}

export function createDistribution(state: SenderKeyState): SenderKeyDistribution {
  return {
    senderKeyId: state.senderKeyId,
    chainKey: toBase64Url(state.chainKey),
    signingPublicKey: toBase64Url(state.signingPublicKey),
    chainIndex: state.chainIndex,
  };
}

export function fromDistribution(dist: SenderKeyDistribution): SenderKeyState {
  return {
    senderKeyId: dist.senderKeyId,
    chainKey: fromBase64Url(dist.chainKey),
    signingPublicKey: fromBase64Url(dist.signingPublicKey),
    signingPrivateKey: new Uint8Array(0), // Remote keys don't have private
    chainIndex: dist.chainIndex,
  };
}

async function advanceChain(chainKey: Uint8Array): Promise<{ messageKey: Uint8Array; nextChainKey: Uint8Array }> {
  const messageKey = await hmacSha256(chainKey, SENDER_KEY_MSG_SEED);
  const nextChainKey = await hmacSha256(chainKey, SENDER_KEY_CHAIN_SEED);
  return { messageKey, nextChainKey };
}

export interface SenderKeyEncryptResult {
  header: SenderKeyHeader;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  sealedEditKey?: SealedEditKey;
}

export async function senderKeyEncrypt(
  state: SenderKeyState,
  plaintext: Uint8Array,
  editKey?: EditKeyToSeal,
): Promise<SenderKeyEncryptResult> {
  const sodium = await ensureSodium();

  const { messageKey, nextChainKey } = await advanceChain(state.chainKey);
  state.chainKey = nextChainKey;

  const iv = aesGcm.generateIV();
  const ciphertext = await aesGcm.encrypt(messageKey, iv, plaintext);

  // Sign the ciphertext for authentication
  const signature = sodium.crypto_sign_detached(ciphertext, state.signingPrivateKey);

  const header: SenderKeyHeader = {
    senderKeyId: state.senderKeyId,
    chainIndex: state.chainIndex,
    signature: toBase64Url(signature),
  };
  state.chainIndex++;

  return { header, ciphertext, iv, ...(editKey && { sealedEditKey: await sealEditKey(messageKey, iv, ciphertext, editKey, state.signingPrivateKey) }) };
}

export async function senderKeyDecrypt(
  state: SenderKeyState,
  header: SenderKeyHeader,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  editKey?: EditKeyToOpen,
): Promise<Uint8Array> {
  const sodium = await ensureSodium();

  // Verify signature
  const signature = fromBase64Url(header.signature);
  const valid = sodium.crypto_sign_verify_detached(signature, ciphertext, state.signingPublicKey);
  if (!valid) {
    throw new Error("Invalid sender key signature");
  }

  if (header.chainIndex < state.chainIndex) {
    throw new Error("Sender key message is outdated");
  }
  if (header.chainIndex - state.chainIndex > MAX_CHAIN_GAP) {
    throw new Error("Sender key chain index gap too large");
  }

  // Advance chain to correct index
  let currentChainKey = state.chainKey;
  for (let i = state.chainIndex; i < header.chainIndex; i++) {
    const { nextChainKey } = await advanceChain(currentChainKey);
    currentChainKey = nextChainKey;
  }

  const { messageKey, nextChainKey } = await advanceChain(currentChainKey);
  state.chainKey = nextChainKey;
  state.chainIndex = header.chainIndex + 1;

  const plaintext = await aesGcm.decrypt(messageKey, iv, ciphertext);
  if (editKey) await openEditKey(messageKey, iv, ciphertext, editKey, state.signingPublicKey);
  return plaintext;
}
