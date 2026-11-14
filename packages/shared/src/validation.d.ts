import { z } from "zod";
export declare const ALLOWED_MIME_TYPES: readonly ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4", "video/mp4", "video/webm", "video/ogg", "application/pdf", "application/octet-stream"];
export declare const registerSchema: z.ZodObject<{
    username: z.ZodString;
    displayName: z.ZodString;
    password: z.ZodString;
    recoveryKey: z.ZodString;
    avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    device: z.ZodObject<{
        name: z.ZodString;
        identityKey: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        name: string;
        identityKey: string;
    }, {
        name: string;
        identityKey: string;
    }>;
}, "strip", z.ZodTypeAny, {
    username: string;
    displayName: string;
    password: string;
    recoveryKey: string;
    device: {
        name: string;
        identityKey: string;
    };
    avatarUrl?: string | null | undefined;
}, {
    username: string;
    displayName: string;
    password: string;
    recoveryKey: string;
    device: {
        name: string;
        identityKey: string;
    };
    avatarUrl?: string | null | undefined;
}>;
export declare const loginSchema: z.ZodObject<{
    username: z.ZodString;
    password: z.ZodString;
    deviceId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    username: string;
    password: string;
    deviceId: string;
}, {
    username: string;
    password: string;
    deviceId: string;
}>;
export declare const refreshSchema: z.ZodObject<{
    refreshToken: z.ZodString;
}, "strip", z.ZodTypeAny, {
    refreshToken: string;
}, {
    refreshToken: string;
}>;
export declare const uploadPreKeyBundleSchema: z.ZodObject<{
    signedPreKey: z.ZodString;
    signedPreKeyId: z.ZodNumber;
    signedPreKeySig: z.ZodString;
    oneTimePreKeys: z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        key: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: number;
        key: string;
    }, {
        id: number;
        key: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    signedPreKey: string;
    signedPreKeyId: number;
    signedPreKeySig: string;
    oneTimePreKeys: {
        id: number;
        key: string;
    }[];
}, {
    signedPreKey: string;
    signedPreKeyId: number;
    signedPreKeySig: string;
    oneTimePreKeys: {
        id: number;
        key: string;
    }[];
}>;
export declare const replenishOTPKeysSchema: z.ZodObject<{
    oneTimePreKeys: z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        key: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: number;
        key: string;
    }, {
        id: number;
        key: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    oneTimePreKeys: {
        id: number;
        key: string;
    }[];
}, {
    oneTimePreKeys: {
        id: number;
        key: string;
    }[];
}>;
export declare const createConversationSchema: z.ZodObject<{
    type: z.ZodEnum<["direct", "group"]>;
    memberUserIds: z.ZodArray<z.ZodString, "many">;
    name: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "direct" | "group";
    memberUserIds: string[];
    name?: string | undefined;
}, {
    type: "direct" | "group";
    memberUserIds: string[];
    name?: string | undefined;
}>;
export declare const addMembersSchema: z.ZodObject<{
    userIds: z.ZodArray<z.ZodString, "many">;
    role: z.ZodOptional<z.ZodEnum<["admin", "member"]>>;
}, "strip", z.ZodTypeAny, {
    userIds: string[];
    role?: "admin" | "member" | undefined;
}, {
    userIds: string[];
    role?: "admin" | "member" | undefined;
}>;
export declare const updateConversationSchema: z.ZodObject<{
    name: z.ZodString;
}, "strip", z.ZodTypeAny, {
    name: string;
}, {
    name: string;
}>;
export declare const startDeviceLinkSchema: z.ZodIntersection<z.ZodObject<{
    username: z.ZodString;
    password: z.ZodString;
}, "strip", z.ZodTypeAny, {
    username: string;
    password: string;
}, {
    username: string;
    password: string;
}>, z.ZodObject<{
    deviceName: z.ZodString;
    identityKey: z.ZodString;
    signedPreKey: z.ZodString;
    signedPreKeyId: z.ZodNumber;
    signedPreKeySig: z.ZodString;
    oneTimePreKeys: z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        key: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: number;
        key: string;
    }, {
        id: number;
        key: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    deviceName: string;
    identityKey: string;
    signedPreKey: string;
    signedPreKeyId: number;
    signedPreKeySig: string;
    oneTimePreKeys: {
        id: number;
        key: string;
    }[];
}, {
    deviceName: string;
    identityKey: string;
    signedPreKey: string;
    signedPreKeyId: number;
    signedPreKeySig: string;
    oneTimePreKeys: {
        id: number;
        key: string;
    }[];
}>>;
export declare const approveDeviceLinkSchema: z.ZodObject<{
    approvalSignature: z.ZodString;
}, "strip", z.ZodTypeAny, {
    approvalSignature: string;
}, {
    approvalSignature: string;
}>;
export declare const completeDeviceLinkSchema: z.ZodObject<{
    possessionSignature: z.ZodString;
}, "strip", z.ZodTypeAny, {
    possessionSignature: string;
}, {
    possessionSignature: string;
}>;
export declare const recoverDeviceLinkSchema: z.ZodIntersection<z.ZodObject<{
    username: z.ZodString;
    password: z.ZodString;
    recoveryKey: z.ZodString;
}, "strip", z.ZodTypeAny, {
    username: string;
    password: string;
    recoveryKey: string;
}, {
    username: string;
    password: string;
    recoveryKey: string;
}>, z.ZodObject<{
    deviceName: z.ZodString;
    identityKey: z.ZodString;
    signedPreKey: z.ZodString;
    signedPreKeyId: z.ZodNumber;
    signedPreKeySig: z.ZodString;
    oneTimePreKeys: z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        key: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: number;
        key: string;
    }, {
        id: number;
        key: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    deviceName: string;
    identityKey: string;
    signedPreKey: string;
    signedPreKeyId: number;
    signedPreKeySig: string;
    oneTimePreKeys: {
        id: number;
        key: string;
    }[];
}, {
    deviceName: string;
    identityKey: string;
    signedPreKey: string;
    signedPreKeyId: number;
    signedPreKeySig: string;
    oneTimePreKeys: {
        id: number;
        key: string;
    }[];
}>>;
export declare const enrollRecoveryKeySchema: z.ZodObject<{
    recoveryKey: z.ZodString;
}, "strip", z.ZodTypeAny, {
    recoveryKey: string;
}, {
    recoveryKey: string;
}>;
export declare const sendMessageSchema: z.ZodEffects<z.ZodObject<{
    id: z.ZodString;
    conversationId: z.ZodString;
    type: z.ZodEnum<["text", "file", "key_exchange", "sender_key_distribution", "system"]>;
    ciphertext: z.ZodString;
    iv: z.ZodString;
    header: z.ZodString;
    ttlSeconds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    fileId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    type: "text" | "file" | "key_exchange" | "sender_key_distribution" | "system";
    id: string;
    conversationId: string;
    ciphertext: string;
    iv: string;
    header: string;
    ttlSeconds?: number | null | undefined;
    fileId?: string | null | undefined;
}, {
    type: "text" | "file" | "key_exchange" | "sender_key_distribution" | "system";
    id: string;
    conversationId: string;
    ciphertext: string;
    iv: string;
    header: string;
    ttlSeconds?: number | null | undefined;
    fileId?: string | null | undefined;
}>, {
    type: "text" | "file" | "key_exchange" | "sender_key_distribution" | "system";
    id: string;
    conversationId: string;
    ciphertext: string;
    iv: string;
    header: string;
    ttlSeconds?: number | null | undefined;
    fileId?: string | null | undefined;
}, {
    type: "text" | "file" | "key_exchange" | "sender_key_distribution" | "system";
    id: string;
    conversationId: string;
    ciphertext: string;
    iv: string;
    header: string;
    ttlSeconds?: number | null | undefined;
    fileId?: string | null | undefined;
}>;
export declare const sendDirectBatchSchema: z.ZodEffects<z.ZodObject<{
    conversationId: z.ZodString;
    type: z.ZodEnum<["text", "file", "key_exchange", "sender_key_distribution", "system"]>;
    ttlSeconds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    fileId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    messages: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        ciphertext: z.ZodString;
        iv: z.ZodString;
        header: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        ciphertext: string;
        iv: string;
        header: string;
    }, {
        id: string;
        ciphertext: string;
        iv: string;
        header: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    type: "text" | "file" | "key_exchange" | "sender_key_distribution" | "system";
    conversationId: string;
    messages: {
        id: string;
        ciphertext: string;
        iv: string;
        header: string;
    }[];
    ttlSeconds?: number | null | undefined;
    fileId?: string | null | undefined;
}, {
    type: "text" | "file" | "key_exchange" | "sender_key_distribution" | "system";
    conversationId: string;
    messages: {
        id: string;
        ciphertext: string;
        iv: string;
        header: string;
    }[];
    ttlSeconds?: number | null | undefined;
    fileId?: string | null | undefined;
}>, {
    type: "text" | "file" | "key_exchange" | "sender_key_distribution" | "system";
    conversationId: string;
    messages: {
        id: string;
        ciphertext: string;
        iv: string;
        header: string;
    }[];
    ttlSeconds?: number | null | undefined;
    fileId?: string | null | undefined;
}, {
    type: "text" | "file" | "key_exchange" | "sender_key_distribution" | "system";
    conversationId: string;
    messages: {
        id: string;
        ciphertext: string;
        iv: string;
        header: string;
    }[];
    ttlSeconds?: number | null | undefined;
    fileId?: string | null | undefined;
}>;
export declare const requestUploadUrlSchema: z.ZodObject<{
    conversationId: z.ZodString;
    mimeType: z.ZodEnum<["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4", "video/mp4", "video/webm", "video/ogg", "application/pdf", "application/octet-stream"]>;
    sizeBytes: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    conversationId: string;
    mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/heic" | "audio/mpeg" | "audio/ogg" | "audio/webm" | "audio/mp4" | "video/mp4" | "video/webm" | "video/ogg" | "application/pdf" | "application/octet-stream";
    sizeBytes: number;
}, {
    conversationId: string;
    mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/heic" | "audio/mpeg" | "audio/ogg" | "audio/webm" | "audio/mp4" | "video/mp4" | "video/webm" | "video/ogg" | "application/pdf" | "application/octet-stream";
    sizeBytes: number;
}>;
export declare const requestEmojiUploadUrlSchema: z.ZodObject<{
    shortcode: z.ZodString;
    mimeType: z.ZodEnum<["image/png", "image/webp"]>;
    sizeBytes: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    mimeType: "image/png" | "image/webp";
    sizeBytes: number;
    shortcode: string;
}, {
    mimeType: "image/png" | "image/webp";
    sizeBytes: number;
    shortcode: string;
}>;
export declare const updateCustomEmojiSchema: z.ZodObject<{
    shortcode: z.ZodString;
}, "strip", z.ZodTypeAny, {
    shortcode: string;
}, {
    shortcode: string;
}>;
export declare const resolveCustomEmojisSchema: z.ZodObject<{
    ids: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    ids: string[];
}, {
    ids: string[];
}>;
export declare const initiateCallSchema: z.ZodObject<{
    conversationId: z.ZodString;
    type: z.ZodEnum<["audio", "video"]>;
}, "strip", z.ZodTypeAny, {
    type: "audio" | "video";
    conversationId: string;
}, {
    type: "audio" | "video";
    conversationId: string;
}>;
export declare const updateProfileSchema: z.ZodObject<{
    displayName: z.ZodOptional<z.ZodString>;
    avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    displayName?: string | undefined;
    avatarUrl?: string | null | undefined;
}, {
    displayName?: string | undefined;
    avatarUrl?: string | null | undefined;
}>;
export declare const deleteAccountSchema: z.ZodObject<{
    password: z.ZodString;
    confirmationText: z.ZodLiteral<"DELETE">;
}, "strip", z.ZodTypeAny, {
    password: string;
    confirmationText: "DELETE";
}, {
    password: string;
    confirmationText: "DELETE";
}>;
//# sourceMappingURL=validation.d.ts.map