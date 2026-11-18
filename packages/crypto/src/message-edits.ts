import type { MessageEditRequest, MessageEditScope } from "@e2ee-chat/shared";
import { decrypt, encrypt, generateIV } from "./aes-gcm.js";
import { hmacSha256 } from "./hkdf.js";
import { sign, verify } from "./identity.js";
import { concat, fromBase64Url, toBase64Url } from "./utils.js";

const encoder = new TextEncoder();
const editKeyDomain = encoder.encode("e2ee-message-edit-key:v1");

function scopeAAD(scope: MessageEditScope, sequence: string): Uint8Array {
  // IDs are opaque. Reject separators to keep this encoding unambiguous.
  const ids = [scope.conversationId, scope.messageId, scope.senderId, scope.senderDeviceId];
  if (ids.some((id) => !id || id.includes("|"))) throw new Error("Invalid edit scope");
  return encoder.encode([...ids, sequence].join("|"));
}

export function messageEditAAD(scope: MessageEditScope, editSeq: number): Uint8Array {
  if (!Number.isSafeInteger(editSeq) || editSeq < 1) throw new Error("Invalid edit sequence");
  // The safe integer range fits in 16 decimal digits. The nonce always
  // begins at the same offset for a given scope.
  return scopeAAD(scope, String(editSeq).padStart(16, "0"));
}

type EditEnvelope = Pick<MessageEditRequest, "nonce" | "ciphertext" | "signature">;

export async function encryptMessageEdit(
  key: Uint8Array, signingKey: Uint8Array, scope: MessageEditScope, editSeq: number, text: string,
): Promise<EditEnvelope> {
  if (key.length !== 32 || !Number.isSafeInteger(editSeq) || editSeq < 1 || !text.trim()) throw new Error("Invalid edit");
  const aad = messageEditAAD(scope, editSeq);
  const nonce = generateIV();
  const ciphertext = await encrypt(key, nonce, encoder.encode(JSON.stringify({ text, editSeq })), aad);
  const signature = await sign(signingKey, concat(aad, nonce, ciphertext));
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext), signature: toBase64Url(signature) };
}

export async function decryptMessageEdit(
  key: Uint8Array, signingKey: Uint8Array, scope: MessageEditScope, editSeq: number, envelope: EditEnvelope,
): Promise<string> {
  const nonce = fromBase64Url(envelope.nonce);
  const ciphertext = fromBase64Url(envelope.ciphertext);
  const signature = fromBase64Url(envelope.signature);
  if (key.length !== 32 || signingKey.length !== 32 || nonce.length !== 12 || signature.length !== 64
    || !Number.isSafeInteger(editSeq) || editSeq < 1) throw new Error("Invalid edit envelope");
  const aad = messageEditAAD(scope, editSeq);
  if (!await verify(signingKey, concat(aad, nonce, ciphertext), signature)) throw new Error("Invalid edit signature");
  const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await decrypt(key, nonce, ciphertext, aad)));
  if (payload?.editSeq !== editSeq || typeof payload.text !== "string" || !payload.text.trim()) throw new Error("Invalid edit text");
  return payload.text;
}

export interface SealedEditKey {
  nonce: string;
  ciphertext: string;
  signature?: string;
}
export interface EditKeyToSeal {
  scope: MessageEditScope;
  bytes: Uint8Array;
}
export interface EditKeyToOpen {
  scope: MessageEditScope;
  sealed: SealedEditKey;
  accept: (bytes: Uint8Array) => void;
}

/** 6aec4f5 renders plaintext verbatim and ignores extra header fields. Seal
 * the edit key and identity beside the text under a separate message subkey. */
export async function sealEditKey(
  messageKey: Uint8Array, iv: Uint8Array, body: Uint8Array, companion: EditKeyToSeal, groupSigningKey?: Uint8Array,
): Promise<SealedEditKey> {
  const aad = concat(scopeAAD(companion.scope, "0"), iv, body);
  const nonce = generateIV();
  const ciphertext = await encrypt(await hmacSha256(messageKey, editKeyDomain), nonce, companion.bytes, aad);
  // A group recipient knows the symmetric message key. The existing sender's
  // signing key also authenticates this extension without changing the old signature.
  const signature = groupSigningKey && toBase64Url(await sign(groupSigningKey, concat(aad, nonce, ciphertext)));
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext), ...(signature && { signature }) };
}

export async function openEditKey(
  messageKey: Uint8Array, iv: Uint8Array, body: Uint8Array, companion: EditKeyToOpen, groupSigningKey?: Uint8Array,
): Promise<void> {
  const { sealed } = companion;
  // Unpadded base64url for a 12-byte nonce and a 64-byte payload with a 16-byte tag.
  if (typeof sealed?.nonce !== "string" || sealed.nonce.length !== 16
    || typeof sealed.ciphertext !== "string" || sealed.ciphertext.length !== 107) return;
  let opened: Uint8Array;
  try {
    const nonce = fromBase64Url(sealed.nonce), ciphertext = fromBase64Url(sealed.ciphertext);
    const aad = concat(scopeAAD(companion.scope, "0"), iv, body);
    if (groupSigningKey && (typeof sealed.signature !== "string" || sealed.signature.length !== 86
      || !await verify(groupSigningKey, concat(aad, nonce, ciphertext), fromBase64Url(sealed.signature)))) return;
    opened = await decrypt(await hmacSha256(messageKey, editKeyDomain), nonce, ciphertext, aad);
  } catch { return; } // A damaged optional extension must not discard the original text.
  if (opened.length === 64) companion.accept(opened);
}
