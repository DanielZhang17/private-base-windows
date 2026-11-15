import { z } from "zod";
import {
  MAX_CUSTOM_EMOJIS_PER_USER,
  MAX_CUSTOM_EMOJI_SIZE,
  MAX_TIMED_MESSAGE_TTL_SECONDS,
  MIN_TIMED_MESSAGE_TTL_SECONDS,
} from "./constants.js";

export const ALLOWED_MIME_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic",
  "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4",
  "video/mp4", "video/webm", "video/ogg",
  "application/pdf",
  "application/octet-stream",
] as const;

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const recoveryKey = z.string().trim().min(16).max(128);
const ttlSeconds = z.number().int().min(MIN_TIMED_MESSAGE_TTL_SECONDS).max(MAX_TIMED_MESSAGE_TTL_SECONDS);
const customEmojiShortcode = z.string().trim().regex(/^[a-z0-9_]{2,32}$/);
const publicPreKeyBundleSchema = z.object({
  deviceName: z.string().min(1).max(64),
  identityKey: base64url,
  signedPreKey: base64url,
  signedPreKeyId: z.number().int().nonnegative(),
  signedPreKeySig: base64url,
  oneTimePreKeys: z.array(
    z.object({ id: z.number().int().nonnegative(), key: base64url }),
  ).min(1),
});

const avatarUrlPattern = z.string().max(256).regex(
  /^(genshin:\/\/[a-z0-9-]+|dicebear:\/\/[a-z-]+\/[a-zA-Z0-9_-]+|r2:\/\/[a-zA-Z0-9_-]+)$/
);

export const registerSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  displayName: z.string().min(1).max(64),
  password: z.string().min(8).max(128),
  recoveryKey,
  avatarUrl: avatarUrlPattern.nullable().optional(),
  device: z.object({
    name: z.string().min(1).max(64),
    identityKey: base64url,
  }),
});

export const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
  deviceId: z.string().trim().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string(),
});

export const uploadPreKeyBundleSchema = z.object({
  signedPreKey: base64url,
  signedPreKeyId: z.number().int().nonnegative(),
  signedPreKeySig: base64url,
  oneTimePreKeys: z.array(
    z.object({ id: z.number().int().nonnegative(), key: base64url })
  ),
});

export const replenishOTPKeysSchema = z.object({
  oneTimePreKeys: z
    .array(z.object({ id: z.number().int().nonnegative(), key: base64url }))
    .min(1),
});

export const createConversationSchema = z.object({
  type: z.enum(["direct", "group"]),
  memberUserIds: z.array(z.string()).min(1),
  name: z.string().max(128).optional(),
}).refine(data => data.type !== "direct" || data.memberUserIds.length === 1, {
  message: "Direct conversations require exactly one other member",
  path: ["memberUserIds"],
});

export const updatePrivacySchema = z.object({
  discoverable: z.boolean().optional(),
  groupInvites: z.enum(["everyone", "contacts", "nobody"]).optional(),
}).strict().refine(data => data.discoverable !== undefined || data.groupInvites !== undefined, {
  message: "At least one field required",
});

export const addMembersSchema = z.object({
  userIds: z.array(z.string()).min(1),
  role: z.enum(["admin", "member"]).optional(),
});

export const updateConversationSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  invitePolicy: z.enum(["any_member", "admins_only"]).optional(),
}).refine(data => data.name !== undefined || data.invitePolicy !== undefined, {
  message: "At least one field required",
});

export const batchDownloadUrlsSchema = z.object({
  fileIds: z.array(z.string().min(1)).min(1).max(100),
});

export const avatarUploadUrlSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.number().int().positive().max(2 * 1024 * 1024),
});

export const startDeviceLinkSchema = z.object({
  username: z.string(),
  password: z.string(),
}).and(publicPreKeyBundleSchema);

export const approveDeviceLinkSchema = z.object({
  approvalSignature: base64url,
});

export const completeDeviceLinkSchema = z.object({
  possessionSignature: base64url,
});

export const recoverDeviceLinkSchema = z.object({
  username: z.string(),
  password: z.string(),
  recoveryKey,
}).and(publicPreKeyBundleSchema);

export const enrollRecoveryKeySchema = z.object({
  recoveryKey,
});

export const sendMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  type: z.enum(["text", "file", "key_exchange", "sender_key_distribution", "system"]),
  ciphertext: z.string(),
  iv: base64url,
  header: z.string(),
  ttlSeconds: ttlSeconds.nullable().optional(),
  fileId: z.string().trim().min(1).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.type !== "file" && value.fileId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fileId is only valid for file messages",
      path: ["fileId"],
    });
  }
});

export const sendDirectBatchSchema = z.object({
  conversationId: z.string(),
  type: z.enum(["text", "file", "key_exchange", "sender_key_distribution", "system"]),
  ttlSeconds: ttlSeconds.nullable().optional(),
  fileId: z.string().trim().min(1).nullable().optional(),
  messages: z.array(
    z.object({
      id: z.string(),
      ciphertext: z.string(),
      iv: base64url,
      header: z.string(),
    }),
  ).min(1).max(64),
}).superRefine((value, ctx) => {
  if (value.type !== "file" && value.fileId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fileId is only valid for file messages",
      path: ["fileId"],
    });
  }
});

export const requestUploadUrlSchema = z.object({
  conversationId: z.string(),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  sizeBytes: z.number().int().positive(),
});

export const requestEmojiUploadUrlSchema = z.object({
  shortcode: customEmojiShortcode,
  mimeType: z.enum(["image/png", "image/webp"]),
  sizeBytes: z.number().int().positive().max(MAX_CUSTOM_EMOJI_SIZE),
});

export const updateCustomEmojiSchema = z.object({
  shortcode: customEmojiShortcode,
});

export const resolveCustomEmojisSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(MAX_CUSTOM_EMOJIS_PER_USER),
});

export const initiateCallSchema = z.object({
  conversationId: z.string(),
  type: z.enum(["audio", "video"]),
});

export const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  avatarUrl: avatarUrlPattern.nullable().optional(),
});

export const deleteAccountSchema = z.object({
  password: z.string().min(8).max(128),
  confirmationText: z.literal("DELETE"),
});

// --- WebAuthn / Passkey schemas ---

const webauthnCredentialResponse = z.object({
  clientDataJSON: z.string(),
  attestationObject: z.string().optional(),
  authenticatorData: z.string().optional(),
  signature: z.string().optional(),
  userHandle: z.string().optional(),
  transports: z.array(z.string()).optional(),
});

const webauthnCredential = z.object({
  id: z.string(),
  rawId: z.string(),
  type: z.literal("public-key"),
  response: webauthnCredentialResponse,
  authenticatorAttachment: z.string().optional(),
  clientExtensionResults: z.object({
    credProps: z.object({ rk: z.boolean().optional() }).optional(),
  }).optional(),
});

export const passkeyRegisterSchema = z.object({
  challengeId: z.string().min(1),
  credential: webauthnCredential,
  friendlyName: z.string().min(1).max(64),
});

export const passkeyCodeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const passkeyHandoffSchema = z.object({ codeChallenge: passkeyCodeChallengeSchema });

export const passkeyLoginOptionsSchema = z.union([
  z.object({ handoff: passkeyHandoffSchema }),
  z.object({ username: z.string(), deviceId: z.string().trim().min(1) }),
]);

export const passkeyLoginSchema = z.union([
  z.object({ challengeId: z.string().min(1), credential: webauthnCredential, handoff: passkeyHandoffSchema }),
  z.object({ challengeId: z.string().min(1), credential: webauthnCredential, username: z.string(), deviceId: z.string().trim().min(1) }),
]);

export const passkeyHandoffRedeemSchema = z.object({
  code: passkeyCodeChallengeSchema,
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  deviceId: z.string().trim().min(1),
});
export const passkeyHandoffStartSchema = z.object({ codeChallenge: passkeyCodeChallengeSchema });
export const passkeyTicketSchema = z.object({ ticket: passkeyCodeChallengeSchema });
export const passkeyTicketRegisterSchema = passkeyRegisterSchema.omit({ friendlyName: true }).extend({ ticket: passkeyCodeChallengeSchema });
export const passkeyHandoffCompleteSchema = z.object({
  pendingId: z.string().min(1),
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  friendlyName: z.string().trim().min(1).max(64).default("Private Base"),
});
