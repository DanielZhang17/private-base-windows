import type { DeviceLinkMethod } from "./types/users.js";
export type DeviceLinkRequestStatus = "pending" | "approved" | "rejected" | "expired" | "completed";
export interface DeviceLinkPublicBundle {
    deviceName: string;
    identityKey: string;
    signedPreKey: string;
    signedPreKeyId: number;
    signedPreKeySig: string;
    oneTimePreKeys: Array<{
        id: number;
        key: string;
    }>;
}
export interface DeviceLinkRequestSummary {
    id: string;
    userId: string;
    deviceName: string;
    identityKey: string;
    shortCode: string | null;
    status: DeviceLinkRequestStatus;
    linkMethod: DeviceLinkMethod;
    createdAt: number;
    expiresAt: number;
    approvedByDeviceId: string | null;
}
export declare function createDeviceLinkApprovalPayload(linkRequestId: string, newIdentityKey: string, shortCode: string, expiresAt: number): string;
export declare function createDeviceLinkChallengePayload(linkRequestId: string, challengeNonce: string): string;
//# sourceMappingURL=device-links.d.ts.map