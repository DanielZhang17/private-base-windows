export type DeviceStatus = "pending" | "active" | "revoked";

export type DeviceLinkMethod = "register" | "approved_link" | "recovery";

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
  createdAt: number;
  lastSeenAt: number;
}
