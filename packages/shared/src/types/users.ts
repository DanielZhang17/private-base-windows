export type DeviceStatus = "pending" | "active" | "revoked";

export type DeviceLinkMethod = "register" | "approved_link" | "recovery" | "passkey";

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Device {
  id: string;
  userId: string;
  deviceName: string;
  identityKey: string; // Base64url-encoded public Ed25519 key
  status: DeviceStatus;
  activatedAt: number | null;
  revokedAt: number | null;
  linkMethod: DeviceLinkMethod;
  platform?: DevicePlatform;
  createdAt: number;
  lastSeenAt: number;
}

export type DevicePlatform = "web" | "macos" | "windows" | "android" | "ios";

export type DeviceAlertKind = "passkey_signin" | "recovery_signin" | "approval_disabled";

export interface DeviceAlert {
  alertId: string;
  kind: DeviceAlertKind;
  deviceId: string;
  deviceName: string;
  platform: DevicePlatform | null;
  at: number;
  credentialId?: string;
  credentialName?: string;
  replacedDeviceName?: string;
  actingDeviceName?: string;
}

export interface DeviceLimitEntry {
  id: string;
  name: string;
  platform: DevicePlatform | null;
  lastActiveAt: number;
  createdAt: number;
  activatedAt: number | null;
  linkMethod: DeviceLinkMethod;
}

export interface DeviceLimitResponse {
  error: "device_limit";
  limit: number;
  slotsToFree: number;
  limitTicket: string | null;
  hasRecoveryKey: boolean;
  devices: DeviceLimitEntry[];
}

export interface PendingPasskeySetup {
  setupId: string;
  deviceId: string;
  user: { id: string; username: string };
  deviceName: string;
  platform: DevicePlatform;
  expiresAt: number;
  setupToken: string;
}
