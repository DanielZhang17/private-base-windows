export interface PreKeyBundle {
  deviceId: string;
  identityKey: string; // Base64url public Ed25519
  signedPreKey: string; // Base64url public X25519
  signedPreKeyId: number;
  signedPreKeySig: string; // Base64url Ed25519 signature
  oneTimePreKey?: { id: number; key: string }; // Consumed on fetch
}

export interface EncryptedPayload {
  ciphertext: string; // Base64url
  iv: string; // Base64url (12 bytes for AES-GCM)
  header: string; // JSON-encoded ratchet header or sender key header
}

export interface RatchetHeader {
  dhPublicKey: string; // Base64url current ratchet public key
  n: number; // Message number in current sending chain
  pn: number; // Previous chain length
}

export interface SenderKeyHeader {
  senderKeyId: number;
  chainIndex: number;
  signature: string; // Base64url Ed25519 signature
}

export interface InitialMessageHeader {
  identityKey: string; // Sender's public identity key
  ephemeralKey: string; // Sender's ephemeral public key
  oneTimePreKeyId?: number; // Which OTP was used
  signedPreKeyId: number;
}
