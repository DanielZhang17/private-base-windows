export type MessageType =
  | "text"
  | "file"
  | "key_exchange"
  | "sender_key_distribution"
  | "system";

export type ExpiryKind = "timed" | "retention";

export function carriesEditKey(header: string): boolean {
  try {
    const key = JSON.parse(header)?.editKey;
    return typeof key?.nonce === "string" && key.nonce.length === 16
      && typeof key.ciphertext === "string" && key.ciphertext.length === 107;
  } catch { return false; }
}

export const MAX_EDIT_ENVELOPE_BYTES = 65_536;
// Fifty maximum-size envelopes fit within the Worker/D1 sync byte budget.
export const MAX_LATEST_EDIT_IDS = 50;

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string;
  type: MessageType;
  ciphertext: string;
  iv: string;
  header: string;
  timestamp: number;
  expiresAt: number | null;
  expiryKind: ExpiryKind;
  serverTimestamp: number;
  latestEditSeq?: number | null;
}

export interface DecryptedMessage {
  ownerId?: string;
  transferSourceId?: string;
  imported?: { fromDeviceId: string; at: number };
  importedAt?: number;
  editedAt?: number | null;
  editedByUserId?: string | null;
  deletedAt?: number | null;
  deletedByUserId?: string | null;
  editSequence?: number;
  latestEditSeq?: number | null;
  editKeyAccepted?: boolean;
  editSenderDeviceId?: string;
  pendingEdit?: { id: string; content: string } | null;
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  content: string;
  fileMetadata?: FileMetadata;
  timestamp: number;
  expiresAt: number | null;
  expiryKind: ExpiryKind;
  status: "sending" | "sent" | "delivered" | "read" | "failed";
}

export interface MessageEditRequest {
  messageId: string;
  conversationId: string;
  editSeq: number;
  nonce: string;
  ciphertext: string;
  signature: string;
}

export interface MessageEditScope {
  conversationId: string;
  messageId: string;
  senderId: string;
  senderDeviceId: string;
}

export const SYNC_PAGE_TOO_LARGE = "SYNC_PAGE_TOO_LARGE";

export interface MessageEditReceipt {
  editedAt: number;
  mutationSeq: number;
  editSeq: number;
}

export interface FileMetadata {
  fileId: string;
  fileName: string;
  mimeType: string;
  size: number;
  fileKey: string; // Base64url AES-256 key
  iv: string; // Base64url
}
