import { ensureSodium, toBase64Url, fromBase64Url } from "./utils.js";

export interface IdentityKeyPair {
  publicEd25519: Uint8Array;
  privateEd25519: Uint8Array;
  publicX25519: Uint8Array;
  privateX25519: Uint8Array;
}

export interface SerializedIdentityKeyPair {
  publicEd25519: string;
  privateEd25519: string;
  publicX25519: string;
  privateX25519: string;
}

export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
  const sodium = await ensureSodium();
  const edKeyPair = sodium.crypto_sign_keypair();
  const publicX25519 = sodium.crypto_sign_ed25519_pk_to_curve25519(edKeyPair.publicKey);
  const privateX25519 = sodium.crypto_sign_ed25519_sk_to_curve25519(edKeyPair.privateKey);

  return {
    publicEd25519: edKeyPair.publicKey,
    privateEd25519: edKeyPair.privateKey,
    publicX25519,
    privateX25519,
  };
}

export function serializeIdentityKeyPair(kp: IdentityKeyPair): SerializedIdentityKeyPair {
  return {
    publicEd25519: toBase64Url(kp.publicEd25519),
    privateEd25519: toBase64Url(kp.privateEd25519),
    publicX25519: toBase64Url(kp.publicX25519),
    privateX25519: toBase64Url(kp.privateX25519),
  };
}

export function deserializeIdentityKeyPair(s: SerializedIdentityKeyPair): IdentityKeyPair {
  return {
    publicEd25519: fromBase64Url(s.publicEd25519),
    privateEd25519: fromBase64Url(s.privateEd25519),
    publicX25519: fromBase64Url(s.publicX25519),
    privateX25519: fromBase64Url(s.privateX25519),
  };
}

export async function sign(privateEd25519: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const sodium = await ensureSodium();
  return sodium.crypto_sign_detached(message, privateEd25519);
}

export async function verify(
  publicEd25519: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const sodium = await ensureSodium();
  return sodium.crypto_sign_verify_detached(signature, message, publicEd25519);
}
