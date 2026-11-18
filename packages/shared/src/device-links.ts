import type { DeviceLinkMethod, DevicePlatform } from "./types/users.js";

export type DeviceLinkRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "completed";

export interface DeviceLinkPublicBundle {
  deviceName: string;
  identityKey: string;
  signedPreKey: string;
  signedPreKeyId: number;
  signedPreKeySig: string;
  oneTimePreKeys: Array<{ id: number; key: string }>;
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

export function createDeviceLinkApprovalPayload(
  linkRequestId: string,
  newIdentityKey: string,
  shortCode: string,
  expiresAt: number,
): string {
  return JSON.stringify({
    kind: "device_link_approval",
    linkRequestId,
    newIdentityKey,
    shortCode,
    expiresAt,
  });
}

export function createDeviceLinkChallengePayload(
  linkRequestId: string,
  challengeNonce: string,
): string {
  return JSON.stringify({
    kind: "device_link_complete",
    linkRequestId,
    challengeNonce,
  });
}

export type PasskeyProvisionBundle = DeviceLinkPublicBundle & {
  platform: DevicePlatform;
  bundleSignature: string;
};

export function createPasskeyProvisionPayload(bundle: Omit<PasskeyProvisionBundle, "bundleSignature">): string {
  return JSON.stringify([
    "privatebase-passkey-provision-v1", bundle.deviceName, bundle.platform, bundle.identityKey,
    bundle.signedPreKey, bundle.signedPreKeyId, bundle.signedPreKeySig,
    bundle.oneTimePreKeys.map(({ id, key }) => [id, key]),
  ]);
}

export function serializeSignedPasskeyProvisionBundle(bundle: PasskeyProvisionBundle): string {
  return JSON.stringify([createPasskeyProvisionPayload(bundle), bundle.bundleSignature]);
}

export function createDeviceActionPayload(
  action: "resume_setup" | "disable_approval" | "ack_device_alert" | "revoke_alert_device" | "remove_device",
  subject: string, challengeId: string,
): string {
  return JSON.stringify(["privatebase-device-action-v1", action, subject, challengeId]);
}

export function deviceRemovalProofSubject(actingDeviceId: string, targetDeviceId: string): string {
  return JSON.stringify([actingDeviceId, targetDeviceId]);
}

export function deviceAlertActionProofContext(action: "ack" | "not-me", deviceId: string, alertId: string) {
  return {
    action: action === "ack" ? "ack_device_alert" : "revoke_alert_device",
    subject: JSON.stringify([deviceId, alertId]),
  } as const;
}

export function createPasskeyEnrollmentPayload(deviceId: string, enrollment:
  | { kind: "web"; challengeId: string; clientDataJSON: string; attestationObject: string }
  | { kind: "native"; pendingId: string },
): string {
  const ceremony = enrollment.kind === "web"
    ? [enrollment.challengeId, enrollment.clientDataJSON, enrollment.attestationObject]
    : [enrollment.pendingId];
  return JSON.stringify(["privatebase-passkey-enrollment-v1", deviceId, enrollment.kind, ...ceremony]);
}
