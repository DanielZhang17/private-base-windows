import { z } from "zod";
import { MAX_LATEST_EDIT_IDS } from "./types/messages.js";
import {
  MAX_CUSTOM_EMOJIS_PER_USER,
  MAX_CUSTOM_EMOJI_SIZE,
  MAX_TIMED_MESSAGE_TTL_SECONDS,
  MIN_TIMED_MESSAGE_TTL_SECONDS,
  OTP_KEY_POOL_SIZE,
} from "./constants.js";

export const ALLOWED_MIME_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic",
  "image/avif", "image/heif", "image/heic-sequence", "image/heif-sequence",
  "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4",
  "video/mp4", "video/webm", "video/ogg", "video/quicktime",
  "application/pdf",
  "application/octet-stream",
] as const;

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).refine((value) => value.startsWith("https://"), "HTTPS is required"),
  keys: z.object({
    p256dh: z.string().regex(/^B[A-Za-z0-9_-]{86}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }).strict(),
  expirationTime: z.number().nullable().optional(),
}).strict();
export const deletePushSubscriptionSchema = z.union([
  z.object({ endpoint: z.string().url().max(2048) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
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
  requireDeviceApproval: z.boolean().optional(),
  newDeviceApproval: z.boolean().optional(),
  approvalProof: z.object({ challengeId: z.string().min(1).max(128), signature: base64url.length(86) }).strict().optional(),
}).strict().refine(({ approvalProof, ...data }) => Object.values(data).some(value => value !== undefined) &&
  (data.requireDeviceApproval === undefined || data.newDeviceApproval === undefined ||
    data.requireDeviceApproval === data.newDeviceApproval) &&
  (!approvalProof || (data.requireDeviceApproval ?? data.newDeviceApproval) === false), {
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

// UUID producers use the same delimiter-free alphabet; retain legacy opaque tokens.
// A colon is reserved exclusively for <family>:<recipient-device> fanout envelopes.
const familyMessageId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const fanoutEnvelopeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?::[A-Za-z0-9_-]{1,128})?$/);

export const sendMessageSchema = z.object({
  id: familyMessageId,
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
      id: fanoutEnvelopeId,
      ciphertext: z.string(),
      iv: base64url,
      header: z.string(),
    }),
  ).min(1).max(64),
}).superRefine((value, ctx) => {
  const root = value.messages[0].id;
  for (const [index, message] of value.messages.entries()) {
    let recipient: unknown;
    try { recipient = JSON.parse(message.header).recipientDeviceId; } catch { /* Route rejects invalid headers. */ }
    const valid = value.type === "sender_key_distribution"
      ? familyMessageId.safeParse(message.id).success
      : index === 0 ? familyMessageId.safeParse(root).success
        : message.id === `${root}:${recipient}` && typeof recipient === "string";
    if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid fanout message id", path: ["messages", index, "id"] });
  }

  if (value.type !== "file" && value.fileId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fileId is only valid for file messages",
      path: ["fileId"],
    });
  }
});

export const messageEditSchema = z.object({
  messageId: familyMessageId,
  conversationId: z.string().min(1),
  editSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  ciphertext: base64url,
  nonce: base64url.length(16),
  signature: base64url.length(86),
});

export const latestMessageEditsSchema = z.object({
  ids: z.array(familyMessageId).min(1).max(MAX_LATEST_EDIT_IDS),
  after: z.record(familyMessageId, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).optional(),
  confirm: z.boolean().optional(),
}).refine(({ ids, after }) => !after || Object.keys(after).every((id) => ids.includes(id)), {
  path: ["after"], message: "Sequences must belong to requested message IDs",
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
  deviceSignature: base64url.length(86),
  challengeId: z.string().min(1),
  credential: webauthnCredential,
  friendlyName: z.string().min(1).max(64),
});

export const passkeyCodeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const passkeyHandoffSchema = z.object({ codeChallenge: passkeyCodeChallengeSchema });

export const passkeyLoginOptionsSchema = z.union([
  z.object({ handoff: passkeyHandoffSchema }),
  z.object({ username: z.string().optional(), deviceId: z.string().trim().min(1) }),
]);

export const passkeyLoginSchema = z.union([
  z.object({ challengeId: z.string().min(1), credential: webauthnCredential, handoff: passkeyHandoffSchema }),
  z.object({ challengeId: z.string().min(1), credential: webauthnCredential, username: z.string().optional(), deviceId: z.string().trim().min(1) }),
]);

export const passkeyProvisionBundleSchema = publicPreKeyBundleSchema.extend({
  identityKey: base64url.length(43),
  signedPreKey: base64url.length(43),
  signedPreKeyId: z.number().int().min(0).max(0xffffffff),
  signedPreKeySig: base64url.length(86),
  oneTimePreKeys: z.array(z.object({
    id: z.number().int().min(0).max(0xffffffff),
    key: base64url.length(43),
  }).strict()).min(1).max(OTP_KEY_POOL_SIZE),
  platform: z.enum(["web", "macos", "windows", "android", "ios"]),
  bundleSignature: base64url.length(86),
}).strict().refine(bundle => new Set(bundle.oneTimePreKeys.map(key => key.id)).size === bundle.oneTimePreKeys.length, {
  message: "Duplicate one-time pre-key IDs",
});

export const passkeyProvisionOptionsSchema = z.object({
  bundleHash: passkeyCodeChallengeSchema,
  handoff: passkeyHandoffSchema.optional(),
}).strict();

const provisionAssertion = z.object({
  challengeId: z.string().min(1).max(128),
  credential: webauthnCredential,
});
export const passkeyProvisionSchema = z.union([
  provisionAssertion.extend({ setupId: z.string().uuid(), bundle: passkeyProvisionBundleSchema }).strict(),
  provisionAssertion.extend({ bundleHash: passkeyCodeChallengeSchema, handoff: passkeyHandoffSchema }).strict(),
]);

const redeemSecrets = z.object({ code: passkeyCodeChallengeSchema, codeVerifier: passkeyCodeChallengeSchema });
export const passkeyHandoffRedeemSchema = z.union([
  redeemSecrets.extend({ deviceId: z.string().trim().min(1) }).strict(),
  redeemSecrets.extend({ setupId: z.string().uuid(), bundle: passkeyProvisionBundleSchema }).strict(),
]);
export const passkeyHandoffStartSchema = z.object({ codeChallenge: passkeyCodeChallengeSchema });
export const passkeyTicketSchema = z.object({ ticket: passkeyCodeChallengeSchema });
export const passkeyTicketRegisterSchema = passkeyRegisterSchema.omit({ friendlyName: true, deviceSignature: true }).extend({ ticket: passkeyCodeChallengeSchema });
export const passkeyHandoffCompleteSchema = z.object({
  deviceSignature: base64url.length(86),
  pendingId: z.string().min(1),
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  friendlyName: z.string().trim().min(1).max(64).default("Private Base"),
});

export const passkeySetupSchema = z.object({ setupId: z.string().uuid() }).strict();
export const deviceActionProofSchema = z.object({
  challengeId: z.string().min(1).max(128),
  signature: base64url.length(86),
}).strict();
export const passkeySetupProofSchema = passkeySetupSchema.extend(deviceActionProofSchema.shape).strict();
export const passkeyReplaceSchema = passkeySetupSchema.extend({
  limitTicket: z.string().max(2048),
  revokeDeviceId: z.string().min(1).max(128).nullable(),
  recoveryKeyProof: recoveryKey.optional(),
  bundle: passkeyProvisionBundleSchema,
}).strict().refine(data => data.revokeDeviceId === null || !!data.recoveryKeyProof);
export const verifyAccountPasswordSchema = z.object({ password: z.string().min(1).max(128) }).strict();
