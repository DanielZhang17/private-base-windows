import type { GroupCallInvitation, GroupCallInvitationProof, GroupCallInviteTarget, GroupCallPeer, GroupCallRoom } from "@e2ee-chat/shared";
import { api } from "../../services/api.js";
import { encryptGroupCallControl } from "../../lib/message-processor.js";
import { groupInvitationProofId } from "./group-call-keys.js";

export async function deliverGroupInvitations(room: GroupCallRoom, from: GroupCallPeer, targets: GroupCallInviteTarget[], signal?: AbortSignal) {
  if (!targets.length || signal?.aborted) return;
  for (let offset = 0; offset < targets.length && !signal?.aborted; offset += 11) {
    const pending = await Promise.allSettled(targets.slice(offset, offset + 11).filter((target) => target.ringUntil > Date.now())
      .map(async ({ userId, deviceId, ringUntil }) => {
        const to = { userId, deviceId };
        const invitation: GroupCallInvitation = { callId: room.id, conversationId: room.conversationId, callType: room.type,
          initiatorId: room.initiatorId, ringUntil, ringFrom: from };
        const proof: GroupCallInvitationProof = { kind: "group_call_invitation", callId: room.id, conversationId: room.conversationId,
          callType: room.type, initiatorId: room.initiatorId, ringUntil, from, to };
        const id = await groupInvitationProofId(invitation, to);
        if (signal?.aborted) throw new DOMException("Call session ended", "AbortError");
        return { id, ...await encryptGroupCallControl(JSON.stringify(proof), userId, deviceId, {
          conversationId: room.conversationId, callId: room.id, sessionId: from.sessionId, epoch: room.epoch, inviteUntil: ringUntil,
        }) };
      }));
    const messages = pending.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!messages.length || signal?.aborted) continue;
    const inviteUntil = targets[offset].ringUntil;
    const payload = { conversationId: room.conversationId, type: "system", messages,
      groupCall: { callId: room.id, sessionId: from.sessionId, epoch: room.epoch, inviteUntil } };
    const send = () => api.post("/api/messages/send-direct-batch?callControl=1", payload, { signal });
    await send().catch(async (error) => {
      if (!signal?.aborted && ![403, 409, 410].includes(error?.status)) await send().catch(() => undefined);
    });
  }
}
