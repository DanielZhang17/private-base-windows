import { asArrayBufferView, fromBase64Url, toBase64Url } from "@e2ee-chat/crypto";
import { groupCallKeySchema, groupCallInvitationProofSchema, groupInvitationEnvelopeId, sameGroupCallPeer,
  type GroupCallInvitation, type GroupCallKey, type GroupCallPeer, type GroupCallRoom } from "@e2ee-chat/shared";
import { getReceiveReceipt } from "../../db/index.js";
import { decryptData, encryptData, localEncryptionKey } from "../../lib/local-key-encryption.js";
import { KeysLockedError } from "../../lib/key-manager.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function groupCallGrantId(room: GroupCallRoom, from: GroupCallPeer, to: GroupCallPeer) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(
    ["group-call-grant-v2", room.id, room.epoch, from.userId, from.deviceId, from.sessionId, to.userId, to.deviceId, to.sessionId])));
  return `gck_${toBase64Url(new Uint8Array(hash))}`;
}

function grantAAD(id: string, userId: string, deviceId: string) {
  return encoder.encode(JSON.stringify(["group-call-grant-v1", id, userId, deviceId]));
}

export async function sealGroupCallGrant(content: string, frame: {
  id: string; conversationId: string; senderId: string; senderDeviceId: string;
}, userId?: string, deviceId?: string) {
  const invitation = groupInvitationEnvelopeId.test(frame.id);
  const grant = (invitation ? groupCallInvitationProofSchema : groupCallKeySchema).parse(JSON.parse(content));
  if (!userId || !deviceId || grant.conversationId !== frame.conversationId || grant.from.userId !== frame.senderId
    || grant.from.deviceId !== frame.senderDeviceId || grant.to.userId !== userId || grant.to.deviceId !== deviceId
    || ("key" in grant && fromBase64Url(grant.key).byteLength !== 32)) throw new TypeError("Invalid group call grant");
  const key = localEncryptionKey;
  if (!key) throw new KeysLockedError();
  const sealed = await encryptData(key, encoder.encode(content), grantAAD(frame.id, userId, deviceId));
  if (localEncryptionKey !== key) throw new KeysLockedError();
  return sealed;
}

async function openSealedGroupCallControl(id: string, userId: string, deviceId: string): Promise<unknown> {
  const receipt = await getReceiveReceipt(id, userId, deviceId);
  const sealed = receipt?.groupCallGrant;
  const key = localEncryptionKey;
  if (!sealed || !key || (receipt.expiresAt ?? 0) <= Date.now()) return;
  const json = await decryptData(key, sealed.iv, sealed.ciphertext, grantAAD(id, userId, deviceId));
  if (key !== localEncryptionKey) return;
  return JSON.parse(decoder.decode(json));
}

export async function openGroupCallGrant(room: GroupCallRoom, from: GroupCallPeer, to: GroupCallPeer): Promise<Uint8Array | undefined> {
  const id = await groupCallGrantId(room, from, to);
  const parsed = groupCallKeySchema.safeParse(await openSealedGroupCallControl(id, to.userId, to.deviceId));
  if (parsed.success && grantMatchesRoom(parsed.data, room, from, to)) return fromBase64Url(parsed.data.key);
}

export function grantMatchesRoom(grant: GroupCallKey, room: GroupCallRoom, from: GroupCallPeer, to: GroupCallPeer) {
  return grant.callId === room.id && grant.conversationId === room.conversationId && grant.epoch === room.epoch
    && sameGroupCallPeer(grant.from, from) && sameGroupCallPeer(grant.to, to)
    && room.participants.some((p) => sameGroupCallPeer(p, from)) && room.participants.some((p) => sameGroupCallPeer(p, to));
}

export function importGroupCallKey(raw: Uint8Array) {
  return crypto.subtle.importKey("raw", asArrayBufferView(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function groupCallPeerIdentity({ userId, deviceId, sessionId }: GroupCallPeer): GroupCallPeer {
  return { userId, deviceId, sessionId };
}

export async function groupInvitationProofId(invitation: GroupCallInvitation, to: { userId: string; deviceId: string }) {
  const identities = [invitation.ringFrom.userId, invitation.ringFrom.deviceId, invitation.ringFrom.sessionId, to.userId, to.deviceId];
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(
    ["group-invitation-proof-v1", invitation.callId, invitation.ringUntil, ...identities])));
  return `gci_${toBase64Url(new Uint8Array(hash))}`;
}

export async function verifyGroupInvitationProof(invitation: GroupCallInvitation, userId: string, deviceId: string) {
  if (invitation.ringUntil <= Date.now()) return false;
  const id = await groupInvitationProofId(invitation, { userId, deviceId });
  const content = await openSealedGroupCallControl(id, userId, deviceId);
  const proof = groupCallInvitationProofSchema.safeParse(content);
  return proof.success && proof.data.callId === invitation.callId && proof.data.conversationId === invitation.conversationId
    && proof.data.initiatorId === invitation.initiatorId && proof.data.callType === invitation.callType
    && proof.data.ringUntil === invitation.ringUntil && sameGroupCallPeer(proof.data.from, invitation.ringFrom)
    && proof.data.to.userId === userId && proof.data.to.deviceId === deviceId && invitation.ringUntil > Date.now();
}
