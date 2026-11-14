import { ensureSodium, concat, fromBase64Url } from "./utils.js";
import { verify } from "./identity.js";
import { hkdf } from "./hkdf.js";
import type { PreKeyBundle } from "@e2ee-chat/shared";

const X3DH_INFO = new TextEncoder().encode("X3DH");
const X3DH_SALT = (() => {
  const out = new Uint8Array(32);
  const src = new TextEncoder().encode("E2EEChat-X3DH-v1");
  out.set(src.slice(0, 32));
  return out;
})();

export interface X3DHResult {
  sharedSecret: Uint8Array; // 32-byte root key for Double Ratchet
  ephemeralPublicKey: Uint8Array;
  usedOneTimePreKeyId?: number;
  usedSignedPreKeyId: number;
}

/**
 * Perform X3DH as the initiator (Alice).
 * Alice wants to send the first message to Bob.
 */
export async function x3dhInitiate(
  aliceIdentityPrivateX25519: Uint8Array,
  aliceIdentityPublicEd25519: Uint8Array,
  bobBundle: PreKeyBundle,
): Promise<X3DHResult> {
  const sodium = await ensureSodium();

  const bobIdentityEd25519 = fromBase64Url(bobBundle.identityKey);
  const bobSignedPreKey = fromBase64Url(bobBundle.signedPreKey);
  const bobSignedPreKeySig = fromBase64Url(bobBundle.signedPreKeySig);

  // Verify signed pre-key signature
  const valid = await verify(bobIdentityEd25519, bobSignedPreKey, bobSignedPreKeySig);
  if (!valid) {
    throw new Error("Invalid signed pre-key signature");
  }

  // Convert Bob's Ed25519 identity key to X25519
  const bobIdentityX25519 = sodium.crypto_sign_ed25519_pk_to_curve25519(bobIdentityEd25519);

  // Generate ephemeral key pair
  const ephemeral = sodium.crypto_box_keypair();

  // Compute DH values
  const dh1 = sodium.crypto_scalarmult(aliceIdentityPrivateX25519, bobSignedPreKey);
  const dh2 = sodium.crypto_scalarmult(ephemeral.privateKey, bobIdentityX25519);
  const dh3 = sodium.crypto_scalarmult(ephemeral.privateKey, bobSignedPreKey);

  let dhConcat: Uint8Array;
  let usedOneTimePreKeyId: number | undefined;

  if (bobBundle.oneTimePreKey) {
    const bobOTP = fromBase64Url(bobBundle.oneTimePreKey.key);
    const dh4 = sodium.crypto_scalarmult(ephemeral.privateKey, bobOTP);
    dhConcat = concat(dh1, dh2, dh3, dh4);
    usedOneTimePreKeyId = bobBundle.oneTimePreKey.id;
  } else {
    dhConcat = concat(dh1, dh2, dh3);
  }

  // Derive shared secret
  const sharedSecret = await hkdf(dhConcat, X3DH_SALT, X3DH_INFO, 32);

  return {
    sharedSecret,
    ephemeralPublicKey: ephemeral.publicKey,
    usedOneTimePreKeyId,
    usedSignedPreKeyId: bobBundle.signedPreKeyId,
  };
}

/**
 * Perform X3DH as the responder (Bob).
 * Bob received Alice's initial message and needs to derive the same shared secret.
 */
export async function x3dhRespond(
  bobIdentityPrivateX25519: Uint8Array,
  bobSignedPreKeyPrivate: Uint8Array,
  bobOneTimePreKeyPrivate: Uint8Array | null,
  aliceIdentityPublicEd25519: Uint8Array,
  aliceEphemeralPublicKey: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await ensureSodium();

  // Convert Alice's Ed25519 identity key to X25519
  const aliceIdentityX25519 = sodium.crypto_sign_ed25519_pk_to_curve25519(aliceIdentityPublicEd25519);

  // Compute DH values (mirrors initiator)
  const dh1 = sodium.crypto_scalarmult(bobSignedPreKeyPrivate, aliceIdentityX25519);
  const dh2 = sodium.crypto_scalarmult(bobIdentityPrivateX25519, aliceEphemeralPublicKey);
  const dh3 = sodium.crypto_scalarmult(bobSignedPreKeyPrivate, aliceEphemeralPublicKey);

  let dhConcat: Uint8Array;
  if (bobOneTimePreKeyPrivate) {
    const dh4 = sodium.crypto_scalarmult(bobOneTimePreKeyPrivate, aliceEphemeralPublicKey);
    dhConcat = concat(dh1, dh2, dh3, dh4);
  } else {
    dhConcat = concat(dh1, dh2, dh3);
  }

  return hkdf(dhConcat, X3DH_SALT, X3DH_INFO, 32);
}
