import { z } from "zod";
import { MAX_FILE_SIZE } from "./constants.js";

export const HISTORY_TRANSFER_TTL_MS = 10 * 60_000;
export const HISTORY_TRANSFER_VERSION = 5;
export const HISTORY_TRANSFER_SIGNAL_BYTES = 32 * 1024;
export const historyTransferRoomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const historyTransferDeviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const publicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const historyTransferQrSchema = z.object({
  v: z.literal(HISTORY_TRANSFER_VERSION),
  secret: z.string().regex(/^[A-Za-z0-9_-]{15}$/),
  receiverDeviceId: historyTransferDeviceIdSchema,
}).strict();
export type HistoryTransferQr = z.infer<typeof historyTransferQrSchema>;

const attempt = { attempt: z.string().uuid() };
const dataChannelSdp = z.string().max(30 * 1024).regex(/^v=0\r?\n/).regex(/^m=application /m);
export const historyTransferSignalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), ...attempt, publicKey, v: z.number().int().safe().optional() }).strict(),
  z.object({ type: z.literal("description"), ...attempt, kind: z.enum(["offer", "answer"]), sdp: dataChannelSdp, restart: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal("ice"), ...attempt, candidate: z.string().max(2048).regex(/^candidate:[^\r\n]+$/), sdpMid: z.string().max(64).nullable(), sdpMLineIndex: z.number().int().min(0).max(255).nullable() }).strict(),
  z.object({ type: z.literal("paired"), ...attempt }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
  z.object({ type: z.literal("cancel") }).strict(),
  z.object({ type: z.literal("reject") }).strict(),
  z.object({ type: z.literal("version-mismatch"), v: z.number().int().safe().optional() }).strict(),
  z.object({ type: z.literal("abort") }).strict(),
]);
export type HistoryTransferSignal = z.infer<typeof historyTransferSignalSchema>;
export type HistoryTransferServerFrame = Exclude<HistoryTransferSignal, { type: "ping" | "paired" }> |
  { type: "room"; expiresAt: number } |
  { type: "lease"; expiresAt: number } |
  { type: "peer"; attempt: string; pairingId: string; deviceId: string; deviceName: string } |
  { type: "peer-left"; attempt: string } |
  { type: "pong" };

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().safe();
const time = count.nullable();

export const transferredMessageId = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?::[A-Za-z0-9_-]{1,128})?$/);
export const HISTORY_OWNERSHIP_BATCH_SIZE = 500;
export const historyOwnershipCandidateSchema = z.object({
  id: transferredMessageId, conversationId: id, senderId: id, timestamp: count,
  type: z.enum(["text", "file"]), deletedAt: time,
}).strict();
export const historyOwnershipLookupSchema = z.object({
  messages: z.array(historyOwnershipCandidateSchema).min(1).max(HISTORY_OWNERSHIP_BATCH_SIZE),
}).strict();
export type HistoryOwnershipCandidate = z.infer<typeof historyOwnershipCandidateSchema>;
export const HISTORY_DELETION_BATCH_SIZE = 100;
export const historyDeletionLookupSchema = z.object({
  messages: z.array(z.object({ id: transferredMessageId, conversationId: id, senderId: id }).strict()).min(1).max(HISTORY_DELETION_BATCH_SIZE),
}).strict();
export type HistoryDeletionLookup = z.infer<typeof historyDeletionLookupSchema>["messages"][number];
export type HistoryDeletionResult = HistoryDeletionLookup & { deletedAt: number; deletedByUserId: string };

const member = z.object({
  conversationId: id, userId: id, role: z.enum(["admin", "member"]),
  joinedAt: count, acceptedAt: time,
  user: z.object({ username: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() }),
});

export const historyTransferConversationSchema = z.object({
  id, type: z.enum(["direct", "group"]), name: z.string().nullable(), avatarUrl: z.string().nullable(),
  invitePolicy: z.enum(["any_member", "admins_only"]), createdBy: id, createdAt: count, updatedAt: count,
  members: z.array(member),
});

export const historyTransferMessageSchema = z.object({
  id: transferredMessageId, conversationId: id, senderId: id, type: z.enum(["text", "file"]),
  content: z.string(), timestamp: count, expiresAt: time, expiryKind: z.enum(["retention", "timed"]).nullish(),
  status: z.enum(["sent", "delivered", "read", "failed"]),
  editedAt: time.optional(), editedByUserId: id.nullish(), deletedAt: time.optional(), deletedByUserId: id.nullish(),
});

export const historyTransferFileMetadataSchema = z.object({
  fileId: id, fileName: z.string().min(1), mimeType: z.string().min(1),
  fileKey: publicKey, iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/).optional(),
  fileIv: z.string().regex(/^[A-Za-z0-9_-]{16}$/).optional(), size: count.optional(), sizeBytes: count.optional(),
}).refine((file) => !!(file.iv ?? file.fileIv));

export const historyTransferEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conversation"), conversation: historyTransferConversationSchema }),
  z.object({
    kind: z.literal("deletion"), id: transferredMessageId, conversationId: id, senderId: id, deletedAt: count, deletedByUserId: id,
  }),
  z.object({
    kind: z.literal("message"), message: historyTransferMessageSchema,
    attachment: z.object({ id, mimeType: z.string(), fileName: z.string(), expiresAt: count, size: count }).optional(),
  }),
]);
export type HistoryTransferEntry = z.infer<typeof historyTransferEntrySchema>;

const chatSize = z.object({ id, messages: count, bytes: count, attachmentBytes: count, attachmentFiles: count.optional() });
export const historyTransferStickerPreferencesSchema = z.object({
  favourites: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), addedAt: count }).strict()).max(200),
  recent: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)).max(30),
}).strict();
export type HistoryTransferStickerPreferences = z.infer<typeof historyTransferStickerPreferencesSchema>;

export const historyTransferAdditionSchema = z.object({ messages: count, attachmentFiles: count, attachmentBytes: count, skipped: z.boolean().optional() }).strict();
export type HistoryTransferAddition = z.infer<typeof historyTransferAdditionSchema>;
export const HISTORY_TRANSFER_SPACE_BATCH_ITEMS = 16;
export const HISTORY_TRANSFER_SPACE_BATCH_ATTACHMENT_BYTES = MAX_FILE_SIZE;
export const historyTransferSpaceItemsSchema = z.array(z.discriminatedUnion("kind", [z.object({
  kind: z.literal("message"), conversationId: id, id: transferredMessageId, senderId: id, direct: z.boolean(),
  bytes: count, editedAt: time.optional(), attachment: z.object({ id, bytes: count }).strict().optional(),
}).strict(), z.object({
  kind: z.literal("conversation"), conversationId: id, updatedAt: count, bytes: count, checkpointBytes: count,
}).strict()])).max(HISTORY_TRANSFER_SPACE_BATCH_ITEMS)
  .refine((items) => items.reduce((total, item) => total + (item.kind === "message" ? item.attachment?.bytes ?? 0 : 0), 0) <= HISTORY_TRANSFER_SPACE_BATCH_ATTACHMENT_BYTES);
export type HistoryTransferSpaceItem = z.infer<typeof historyTransferSpaceItemsSchema>[number];
export const historyTransferSpaceResultSchema = z.object({ required: count, free: count.optional() }).strict();
export type HistoryTransferSpaceResult = z.infer<typeof historyTransferSpaceResultSchema>;
export const historyTransferManifestSchema = z.object({
  v: z.literal(HISTORY_TRANSFER_VERSION),
  resumeId: z.string().uuid().optional(),
  bytes: count,
  copyDownloadedFiles: z.boolean(),
  stickers: historyTransferStickerPreferencesSchema.optional(),
  chats: z.array(chatSize.extend({ name: z.string().nullable(), skippedLegacyMessages: count.optional(), missingFiles: z.array(z.string()).optional() })),
}).strict();
export type HistoryTransferManifest = z.infer<typeof historyTransferManifestSchema>;

export const historyTransferCheckpointSchema = z.object({
  chats: z.array(chatSize.extend({ additions: historyTransferAdditionSchema.optional(), missingFileCount: count.optional() })), completedChatIds: z.array(id), bytes: count, copyDownloadedFiles: z.boolean(),
  resumeId: z.string().uuid().optional(),
  confirmationOnly: z.literal(true).optional(),
}).strict();
export type HistoryTransferCheckpoint = z.infer<typeof historyTransferCheckpointSchema>;
