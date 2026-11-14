export type MessageType =
  | "text"
  | "file"
  | "key_exchange"
  | "sender_key_distribution"
  | "system";

export type ExpiryKind = "timed" | "retention";

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
}

export interface DecryptedMessage {
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

export interface FileMetadata {
  fileId: string;
  fileName: string;
  mimeType: string;
  size: number;
  fileKey: string; // Base64url AES-256 key
  iv: string; // Base64url
}
