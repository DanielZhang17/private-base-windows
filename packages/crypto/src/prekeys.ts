import { ensureSodium, toBase64Url, fromBase64Url } from "./utils.js";
import { sign } from "./identity.js";

export interface X25519KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface SignedPreKey {
  id: number;
  keyPair: X25519KeyPair;
  signature: Uint8Array; // Ed25519 signature over the public key
}

export interface OneTimePreKey {
  id: number;
  keyPair: X25519KeyPair;
}

export async function generateX25519KeyPair(): Promise<X25519KeyPair> {
  const sodium = await ensureSodium();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export async function generateSignedPreKey(
  id: number,
  identityPrivateEd25519: Uint8Array,
): Promise<SignedPreKey> {
  const keyPair = await generateX25519KeyPair();
  const signature = await sign(identityPrivateEd25519, keyPair.publicKey);
  return { id, keyPair, signature };
}

export async function generateOneTimePreKeys(
  startId: number,
  count: number,
): Promise<OneTimePreKey[]> {
  const keys: OneTimePreKey[] = [];
  for (let i = 0; i < count; i++) {
    const keyPair = await generateX25519KeyPair();
    keys.push({ id: startId + i, keyPair });
  }
  return keys;
}

export function serializeSignedPreKey(spk: SignedPreKey) {
  return {
    id: spk.id,
    publicKey: toBase64Url(spk.keyPair.publicKey),
    signature: toBase64Url(spk.signature),
  };
}

export function serializeOneTimePreKeys(keys: OneTimePreKey[]) {
  return keys.map((k) => ({
    id: k.id,
    key: toBase64Url(k.keyPair.publicKey),
  }));
}
