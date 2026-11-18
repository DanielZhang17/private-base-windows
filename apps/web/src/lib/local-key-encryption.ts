import { asArrayBufferView, fromBase64Url, toBase64Url } from "@e2ee-chat/crypto";

export interface EncryptedLocalData { iv: string; ciphertext: string }

/** The unlocked device KEK shared by private-key and edit-key storage. */
export let localEncryptionKey: CryptoKey | null = null;
export function setLocalEncryptionKey(key: CryptoKey | null) {
  localEncryptionKey = key;
}

export async function encryptData(key: CryptoKey, data: Uint8Array, aad?: Uint8Array): Promise<EncryptedLocalData> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params: AesGcmParams = { name: "AES-GCM", iv: asArrayBufferView(iv) };
  if (aad !== undefined) params.additionalData = asArrayBufferView(aad);
  const encrypted = await crypto.subtle.encrypt(params, key, asArrayBufferView(data));
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(encrypted)) };
}

export async function decryptData(key: CryptoKey, iv: string, ciphertext: string, aad?: Uint8Array): Promise<Uint8Array> {
  const params: AesGcmParams = { name: "AES-GCM", iv: asArrayBufferView(fromBase64Url(iv)) };
  if (aad !== undefined) params.additionalData = asArrayBufferView(aad);
  const decrypted = await crypto.subtle.decrypt(params, key, asArrayBufferView(fromBase64Url(ciphertext)));
  return new Uint8Array(decrypted);
}

export interface SealedAttachment { iv: Uint8Array; ciphertext: Blob }

function attachmentAAD(ownerId: string, fileId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(["attachment-cache-v1", ownerId, fileId]));
}

export async function sealAttachmentBytes(key: CryptoKey, ownerId: string, fileId: string, wire: ArrayBuffer): Promise<SealedAttachment> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: attachmentAAD(ownerId, fileId) }, key, wire);
  return { iv, ciphertext: new Blob([ciphertext]) };
}

export async function openAttachmentBytes(key: CryptoKey, ownerId: string, fileId: string, sealed: SealedAttachment): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: asArrayBufferView(sealed.iv), additionalData: attachmentAAD(ownerId, fileId) },
    key, await sealed.ciphertext.arrayBuffer());
}
