import type { PreKeyBundle } from "./crypto.js";
import type { Call, CallType } from "./calls.js";
import type { Conversation, ConversationWithMembers, MemberRole } from "./conversations.js";
import type { CustomEmoji, ResolvedCustomEmoji } from "./emojis.js";
import type { ExpiryKind, Message, MessageType } from "./messages.js";
import type { Device, User } from "./users.js";
import type {
  DeviceLinkPublicBundle,
  DeviceLinkRequestStatus,
  DeviceLinkRequestSummary,
} from "../device-links.js";

// Auth
export interface RegisterRequest {
  username: string;
  displayName: string;
  password: string;
  recoveryKey: string;
  device: { name: string; identityKey: string };
}

export interface LoginRequest {
  username: string;
  password: string;
  deviceId: string;
}

export interface AuthResponse {
  user: User;
  device: Device;
  accessToken: string;
  refreshToken: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export interface RecoveryKeyStatusResponse {
  enrolled: boolean;
}

export interface EnrollRecoveryKeyRequest {
  recoveryKey: string;
}

export interface EnrollRecoveryKeyResponse {
  enrolledAt: number;
}

// Keys
export interface UploadPreKeyBundleRequest {
  signedPreKey: string;
  signedPreKeyId: number;
  signedPreKeySig: string;
  oneTimePreKeys: { id: number; key: string }[];
}

export interface ReplenishOTPKeysRequest {
  oneTimePreKeys: { id: number; key: string }[];
}

export type FetchPreKeyBundleResponse = PreKeyBundle;

// Conversations
export interface CreateConversationRequest {
  type: "direct" | "group";
  memberUserIds: string[];
  name?: string;
}

export type ListConversationsResponse = ConversationWithMembers[];
export type GetConversationResponse = ConversationWithMembers;

export interface AddMembersRequest {
  userIds: string[];
  role?: MemberRole;
}

// Device linking
export interface StartDeviceLinkRequest extends DeviceLinkPublicBundle {
  username: string;
  password: string;
}

export interface StartDeviceLinkResponse {
  linkRequestId: string;
  shortCode: string;
  expiresAt: number;
}

export interface ApproveDeviceLinkRequest {
  approvalSignature: string;
}

export interface RejectDeviceLinkResponse {
  success: true;
}

export interface DeviceLinkStatusResponse {
  status: DeviceLinkRequestStatus;
  expiresAt: number;
  shortCode: string | null;
  challengeNonce: string | null;
  deviceName: string;
  linkMethod: "approved_link" | "recovery";
}

export interface CompleteDeviceLinkRequest {
  possessionSignature: string;
}

export type ListDeviceLinkRequestsResponse = DeviceLinkRequestSummary[];

export interface RecoverDeviceLinkRequest extends DeviceLinkPublicBundle {
  username: string;
  password: string;
  recoveryKey: string;
}

export interface RecoverDeviceLinkResponse {
  linkRequestId: string;
  expiresAt: number;
  challengeNonce: string;
}

// Messages
export interface SendMessageRequest {
  id: string;
  conversationId: string;
  type: MessageType;
  ciphertext: string;
  iv: string;
  header: string;
  ttlSeconds?: number | null;
  fileId?: string | null;
}

export interface SendDirectBatchRequest {
  conversationId: string;
  type: MessageType;
  ttlSeconds?: number | null;
  fileId?: string | null;
  messages: Array<{
    id: string;
    ciphertext: string;
    iv: string;
    header: string;
  }>;
}

export interface SendMessageResponse {
  deleted?: boolean;
  deletedAt?: number;
  deletedByUserId?: string;
  id: string;
  serverTimestamp: number;
  expiresAt: number | null;
  expiryKind: ExpiryKind;
}

export interface SendDirectBatchResponse {
  deleted?: boolean;
  deletedAt?: number;
  deletedByUserId?: string;
  ids: string[];
  serverTimestamp: number;
  expiresAt: number | null;
  expiryKind: ExpiryKind;
}

export interface SyncMessagesResponse {
  messages: Message[];
  hasMore: boolean;
  mutations: (Message & { mutationSeq: number; deletedAt: number; deletedByUserId: string })[];
  hasMoreMutations: boolean;
  mutationCursor: number;
}

// Custom emoji
export interface RequestEmojiUploadUrlRequest {
  shortcode: string;
  mimeType: string;
  sizeBytes: number;
}

export interface EmojiUploadUrlResponse {
  emojiId: string;
  uploadUrl: string;
}

export interface UpdateCustomEmojiRequest {
  shortcode: string;
}

export interface ResolveCustomEmojisRequest {
  ids: string[];
}

export interface ResolveCustomEmojisResponse {
  emojis: ResolvedCustomEmoji[];
}

export type ListMyCustomEmojisResponse = CustomEmoji[];

export interface DeleteCustomEmojiResponse {
  success: true;
}

// Files
export interface RequestUploadUrlRequest {
  conversationId: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadUrlResponse {
  fileId: string;
  uploadUrl: string;
}

export interface DownloadUrlResponse {
  downloadUrl: string;
}

// Calls
export interface InitiateCallRequest {
  conversationId: string;
  type: CallType;
}

export interface InitiateCallResponse {
  call: Call;
  created: boolean;
  wsUrl: string;
}

export type GetCallResponse = Call;

export interface AcceptCallResponse {
  call: Call;
}

export interface DeclineCallResponse {
  call: Call;
}

export interface EndCallResponse {
  call: Call;
}

export interface TurnCredentialsResponse {
  iceServers: { urls: string[]; username?: string; credential?: string }[];
}

// Account
export interface DeleteAccountRequest {
  password: string;
  confirmationText: string;
}

export interface DeleteAccountResponse {
  success: true;
}

// Passkeys
export interface PasskeyInfo {
  id: string;
  credentialId: string;
  friendlyName: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

export type ListPasskeysResponse = PasskeyInfo[];

export interface PasskeyRegistrationOptionsResponse {
  challengeId: string;
  options: {
    challenge: string;
    rp: { name: string; id: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: { type: "public-key"; alg: number }[];
    timeout: number;
    attestation: string;
    authenticatorSelection: {
      residentKey: string;
      requireResidentKey?: boolean;
      userVerification: string;
    };
    extensions?: { credProps: boolean };
    excludeCredentials: { id: string; type: "public-key"; transports?: string[] }[];
  };
}

export interface PasskeyRegisterRequest {
  challengeId: string;
  credential: unknown;
  friendlyName: string;
}

export type PasskeyLoginOptionsRequest =
  | { username: string; deviceId: string }
  | { handoff: { codeChallenge: string } };

export interface PasskeyLoginOptionsResponse {
  challengeId: string;
  options: {
    challenge: string;
    rpId: string;
    timeout: number;
    userVerification: string;
    allowCredentials: { id: string; type: "public-key"; transports?: string[] }[];
  };
}

export type PasskeyLoginRequest = {
  challengeId: string;
  credential: unknown;
} & PasskeyLoginOptionsRequest;

// Profile
export interface UpdateProfileRequest {
  displayName?: string;
  avatarUrl?: string | null;
}

export interface UpdateProfileResponse {
  user: User;
}
