import { ensureSodium, toBase64Url, fromBase64Url, concat } from "./utils.js";
import { hkdf, hmacSha256 } from "./hkdf.js";
import * as aesGcm from "./aes-gcm.js";
import type { RatchetHeader } from "@e2ee-chat/shared";
import { MAX_SKIPPED_KEYS } from "@e2ee-chat/shared";

const RATCHET_INFO = new TextEncoder().encode("RatchetRK");
const CHAIN_KEY_SEED_MSG = new Uint8Array([0x01]);
const CHAIN_KEY_SEED_CHAIN = new Uint8Array([0x02]);

export interface RatchetSession {
  // DH ratchet state
  dhSendingKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
  dhRemotePublicKey: Uint8Array | null; // null until first message received
  rootKey: Uint8Array;

  // Sending chain
  sendingChainKey: Uint8Array | null;
  sendMessageNumber: number;

  // Receiving chain
  receivingChainKey: Uint8Array | null;
  recvMessageNumber: number;

  // Previous sending chain length
  previousChainLength: number;

  // Skipped message keys: Map<"base64pubkey:msgNum", messageKey>
  skippedKeys: Map<string, Uint8Array>;
}

export interface SerializedRatchetSession {
  dhSendingKeyPair: { publicKey: string; privateKey: string };
  dhRemotePublicKey: string | null;
  rootKey: string;
  sendingChainKey: string | null;
  sendMessageNumber: number;
  receivingChainKey: string | null;
  recvMessageNumber: number;
  previousChainLength: number;
  skippedKeys: [string, string][]; // [key, base64url messageKey]
}

export function serializeSession(session: RatchetSession): SerializedRatchetSession {
  return {
    dhSendingKeyPair: {
      publicKey: toBase64Url(session.dhSendingKeyPair.publicKey),
      privateKey: toBase64Url(session.dhSendingKeyPair.privateKey),
    },
    dhRemotePublicKey: session.dhRemotePublicKey ? toBase64Url(session.dhRemotePublicKey) : null,
    rootKey: toBase64Url(session.rootKey),
    sendingChainKey: session.sendingChainKey ? toBase64Url(session.sendingChainKey) : null,
    sendMessageNumber: session.sendMessageNumber,
    receivingChainKey: session.receivingChainKey ? toBase64Url(session.receivingChainKey) : null,
    recvMessageNumber: session.recvMessageNumber,
    previousChainLength: session.previousChainLength,
    skippedKeys: Array.from(session.skippedKeys.entries()).map(([k, v]) => [k, toBase64Url(v)]),
  };
}

export function deserializeSession(s: SerializedRatchetSession): RatchetSession {
  return {
    dhSendingKeyPair: {
      publicKey: fromBase64Url(s.dhSendingKeyPair.publicKey),
      privateKey: fromBase64Url(s.dhSendingKeyPair.privateKey),
    },
    dhRemotePublicKey: s.dhRemotePublicKey ? fromBase64Url(s.dhRemotePublicKey) : null,
    rootKey: fromBase64Url(s.rootKey),
    sendingChainKey: s.sendingChainKey ? fromBase64Url(s.sendingChainKey) : null,
    sendMessageNumber: s.sendMessageNumber,
    receivingChainKey: s.receivingChainKey ? fromBase64Url(s.receivingChainKey) : null,
    recvMessageNumber: s.recvMessageNumber,
    previousChainLength: s.previousChainLength,
    skippedKeys: new Map(s.skippedKeys.map(([k, v]) => [k, fromBase64Url(v)])),
  };
}

/**
 * Initialize a ratchet session as the initiator (Alice).
 * Called after X3DH completes.
 * Alice uses Bob's signed pre-key as the initial remote public key.
 */
export async function initSessionAsInitiator(
  sharedSecret: Uint8Array,
  bobSignedPreKeyPublic: Uint8Array,
): Promise<RatchetSession> {
  const sodium = await ensureSodium();
  const dhSendingKeyPair = sodium.crypto_box_keypair();

  // Perform initial DH ratchet step
  const dhOutput = sodium.crypto_scalarmult(dhSendingKeyPair.privateKey, bobSignedPreKeyPublic);
  const derived = await hkdf(dhOutput, sharedSecret, RATCHET_INFO, 64);

  return {
    dhSendingKeyPair: { publicKey: dhSendingKeyPair.publicKey, privateKey: dhSendingKeyPair.privateKey },
    dhRemotePublicKey: bobSignedPreKeyPublic,
    rootKey: derived.slice(0, 32),
    sendingChainKey: derived.slice(32, 64),
    sendMessageNumber: 0,
    receivingChainKey: null,
    recvMessageNumber: 0,
    previousChainLength: 0,
    skippedKeys: new Map(),
  };
}

/**
 * Initialize a ratchet session as the responder (Bob).
 * Bob uses his signed pre-key as the initial DH key pair.
 */
export async function initSessionAsResponder(
  sharedSecret: Uint8Array,
  bobSignedPreKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array },
): Promise<RatchetSession> {
  return {
    dhSendingKeyPair: bobSignedPreKeyPair,
    dhRemotePublicKey: null,
    rootKey: sharedSecret,
    sendingChainKey: null,
    sendMessageNumber: 0,
    receivingChainKey: null,
    recvMessageNumber: 0,
    previousChainLength: 0,
    skippedKeys: new Map(),
  };
}

// KDF for chain key -> (messageKey, nextChainKey)
async function kdfCK(chainKey: Uint8Array): Promise<{ messageKey: Uint8Array; nextChainKey: Uint8Array }> {
  const messageKey = await hmacSha256(chainKey, CHAIN_KEY_SEED_MSG);
  const nextChainKey = await hmacSha256(chainKey, CHAIN_KEY_SEED_CHAIN);
  return { messageKey, nextChainKey };
}

// DH ratchet step
async function dhRatchetStep(
  session: RatchetSession,
  remotePublicKey: Uint8Array,
): Promise<void> {
  const sodium = await ensureSodium();

  session.previousChainLength = session.sendMessageNumber;
  session.sendMessageNumber = 0;
  session.recvMessageNumber = 0;
  session.dhRemotePublicKey = remotePublicKey;

  // Derive receiving chain key
  const dhRecv = sodium.crypto_scalarmult(session.dhSendingKeyPair.privateKey, remotePublicKey);
  const derivedRecv = await hkdf(dhRecv, session.rootKey, RATCHET_INFO, 64);
  session.rootKey = derivedRecv.slice(0, 32);
  session.receivingChainKey = derivedRecv.slice(32, 64);

  // Generate new sending key pair
  const newKeyPair = sodium.crypto_box_keypair();
  session.dhSendingKeyPair = { publicKey: newKeyPair.publicKey, privateKey: newKeyPair.privateKey };

  // Derive sending chain key
  const dhSend = sodium.crypto_scalarmult(newKeyPair.privateKey, remotePublicKey);
  const derivedSend = await hkdf(dhSend, session.rootKey, RATCHET_INFO, 64);
  session.rootKey = derivedSend.slice(0, 32);
  session.sendingChainKey = derivedSend.slice(32, 64);
}

function skippedKeyId(publicKey: Uint8Array, msgNum: number): string {
  return `${toBase64Url(publicKey)}:${msgNum}`;
}

async function skipMessageKeys(
  session: RatchetSession,
  until: number,
  publicKey: Uint8Array,
): Promise<void> {
  if (!session.receivingChainKey) return;
  if (until - session.recvMessageNumber > MAX_SKIPPED_KEYS) {
    throw new Error("Too many skipped messages");
  }
  while (session.recvMessageNumber < until) {
    const { messageKey, nextChainKey } = await kdfCK(session.receivingChainKey);
    session.skippedKeys.set(skippedKeyId(publicKey, session.recvMessageNumber), messageKey);
    session.receivingChainKey = nextChainKey;
    session.recvMessageNumber++;
  }
}

export interface EncryptResult {
  header: RatchetHeader;
  ciphertext: Uint8Array;
  iv: Uint8Array;
}

/**
 * Canonical AAD serialization for AES-GCM.
 * MUST produce identical bytes on encrypt and decrypt regardless of
 * JS engine field ordering or numeric formatting differences.
 */
function canonicalHeaderAAD(header: RatchetHeader): Uint8Array {
  // Fixed field order: dhPublicKey, n, pn — always integers as-is
  const canonical = `{"dhPublicKey":"${header.dhPublicKey}","n":${header.n},"pn":${header.pn}}`;
  return new TextEncoder().encode(canonical);
}

export async function ratchetEncrypt(
  session: RatchetSession,
  plaintext: Uint8Array,
): Promise<EncryptResult> {
  if (!session.sendingChainKey) {
    throw new Error("Session not ready to send");
  }

  const { messageKey, nextChainKey } = await kdfCK(session.sendingChainKey);
  session.sendingChainKey = nextChainKey;

  const header: RatchetHeader = {
    dhPublicKey: toBase64Url(session.dhSendingKeyPair.publicKey),
    n: session.sendMessageNumber,
    pn: session.previousChainLength,
  };
  session.sendMessageNumber++;

  const iv = aesGcm.generateIV();
  const headerBytes = canonicalHeaderAAD(header);
  const ciphertext = await aesGcm.encrypt(messageKey, iv, plaintext, headerBytes);

  return { header, ciphertext, iv };
}

export async function ratchetDecrypt(
  session: RatchetSession,
  header: RatchetHeader,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const remotePublicKey = fromBase64Url(header.dhPublicKey);
  const headerBytes = canonicalHeaderAAD(header);

  // Check skipped keys first
  const skId = skippedKeyId(remotePublicKey, header.n);
  const skippedKey = session.skippedKeys.get(skId);
  if (skippedKey) {
    session.skippedKeys.delete(skId);
    return aesGcm.decrypt(skippedKey, iv, ciphertext, headerBytes);
  }

  // Check if we need a DH ratchet step
  const isNewRatchetKey =
    !session.dhRemotePublicKey ||
    toBase64Url(session.dhRemotePublicKey) !== header.dhPublicKey;

  if (isNewRatchetKey) {
    if (session.dhRemotePublicKey && session.receivingChainKey) {
      await skipMessageKeys(session, header.pn, session.dhRemotePublicKey);
    }
    await dhRatchetStep(session, remotePublicKey);
  }

  if (!session.receivingChainKey) {
    throw new Error("No receiving chain key");
  }

  await skipMessageKeys(session, header.n, remotePublicKey);

  const { messageKey, nextChainKey } = await kdfCK(session.receivingChainKey);
  session.receivingChainKey = nextChainKey;
  session.recvMessageNumber++;

  return aesGcm.decrypt(messageKey, iv, ciphertext, headerBytes);
}
