import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { GroupCallInvitation, GroupCallInvitationProof, GroupCallKey, GroupCallRoom } from "@e2ee-chat/shared";
import { toBase64Url } from "@e2ee-chat/crypto";
import { setLocalEncryptionKey } from "../../lib/local-key-encryption.js";
import { getReceiveReceipt } from "../../db/index.js";
import { grantMatchesRoom, groupCallGrantId, groupInvitationProofId,
  openGroupCallGrant, sealGroupCallGrant, verifyGroupInvitationProof } from "./group-call-keys.js";

vi.mock("../../db/index.js", () => ({ getReceiveReceipt: vi.fn() }));
vi.mock("../../lib/key-manager.js", () => ({ KeysLockedError: class extends Error {} }));
const peer = (userId: string, deviceId = userId + "-device", sessionId = userId + "-session") => ({ userId, deviceId, sessionId });
const alice = peer("alice"), bob = peer("bob"), carol = peer("carol");
const room: GroupCallRoom = { id: "call", conversationId: "group", initiatorId: "alice", type: "video",
  startedAt: 1, epoch: 4, aloneUntil: null, endedAt: null, participants: [carol, bob, alice].map((p) => ({ ...p, joinedAt: 1 })) };
const raw = new Uint8Array(32).fill(11);
const grant: GroupCallKey = {
  kind: "group_call_key", callId: room.id, conversationId: room.conversationId, epoch: room.epoch,
  from: alice, to: bob, key: toBase64Url(raw),
};

beforeEach(async () => {
  setLocalEncryptionKey(await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
});
afterEach(() => {
  setLocalEncryptionKey(null);
  vi.clearAllMocks();
});

it("seals received frame grants and binds them to both identities, the room epoch, and the local receipt", async () => {
  const id = await groupCallGrantId(room, alice, bob);
  const frame = { id, conversationId: "group", senderId: "alice", senderDeviceId: alice.deviceId };
  const sealed = await sealGroupCallGrant(JSON.stringify(grant), frame, bob.userId, bob.deviceId);
  expect(sealed.ciphertext).not.toContain(grant.key);
  expect(await groupCallGrantId(room, alice, carol)).not.toBe(id);
  vi.mocked(getReceiveReceipt).mockImplementation(async (receiptId, ownerId, deviceId) =>
    receiptId === id && ownerId === bob.userId && deviceId === bob.deviceId
      ? { id, ownerId, deviceId, expiresAt: Date.now() + 60_000, groupCallGrant: sealed } : undefined);
  expect(await openGroupCallGrant(room, alice, bob)).toEqual(raw);
  expect(await openGroupCallGrant(room, alice, carol)).toBeUndefined();
  const moved = peer(bob.userId, "second-device", "new-session");
  const rotated = { ...room, epoch: 5, participants: [alice, moved].map((p) => ({ ...p, joinedAt: 1 })) };
  expect(grantMatchesRoom(grant, rotated, alice, moved)).toBe(false);
  expect(await openGroupCallGrant(rotated, alice, moved)).toBeUndefined();
  await expect(sealGroupCallGrant(JSON.stringify(grant), { ...frame, senderDeviceId: "spoofed" }, bob.userId, bob.deviceId)).rejects.toThrow();
  setLocalEncryptionKey(null);
  expect(await openGroupCallGrant(room, alice, bob)).toBeUndefined();
});

it("recognizes a sealed invitation for this device and this ring window only", async () => {
  const invitation: GroupCallInvitation = { callId: room.id, conversationId: room.conversationId, initiatorId: alice.userId,
    callType: room.type, ringFrom: carol, ringUntil: Date.now() + 30_000 };
  const { ringFrom, ...metadata } = invitation;
  const to = { userId: bob.userId, deviceId: bob.deviceId };
  const proof: GroupCallInvitationProof = { ...metadata, kind: "group_call_invitation", from: ringFrom, to };
  const id = await groupInvitationProofId(invitation, to);
  const sealed = await sealGroupCallGrant(JSON.stringify(proof), { id, conversationId: room.conversationId,
    senderId: carol.userId, senderDeviceId: carol.deviceId }, bob.userId, bob.deviceId);
  vi.mocked(getReceiveReceipt).mockImplementation(async (requested) => requested === id
    ? { id, expiresAt: invitation.ringUntil, groupCallGrant: sealed } : undefined);
  expect(await verifyGroupInvitationProof(invitation, bob.userId, bob.deviceId)).toBe(true);
  expect(await verifyGroupInvitationProof(invitation, bob.userId, "legacy-device")).toBe(false);
  expect(await verifyGroupInvitationProof({ ...invitation, ringUntil: invitation.ringUntil + 10_000 }, bob.userId, bob.deviceId)).toBe(false);
  expect(await verifyGroupInvitationProof({ ...invitation, ringFrom: alice }, bob.userId, bob.deviceId)).toBe(false);
});
