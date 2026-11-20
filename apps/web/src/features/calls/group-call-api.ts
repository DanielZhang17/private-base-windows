import { GROUP_CALL_CAPABILITY, type GroupCallPeer, type GroupCallRoom, type GroupCallStatusResponse } from "@e2ee-chat/shared";
import { api, resolveApiUrl } from "../../services/api.js";
import { supportsE2EECalling } from "../../platform/calls.js";

export function groupCallPath(conversationId: string, action: string, room?: GroupCallRoom, peer?: GroupCallPeer) {
  const query = new URLSearchParams();
  if (supportsE2EECalling()) query.set("cap", GROUP_CALL_CAPABILITY);
  if (room) query.set("callId", room.id);
  if (peer) query.set("sessionId", peer.sessionId);
  return `/api/group-calls/${encodeURIComponent(conversationId)}/${action}?${query}`;
}

export const loadGroupCallStatus = (conversationId: string, signal?: AbortSignal) =>
  api.get<GroupCallStatusResponse>(groupCallPath(conversationId, "status"), signal);

export function releaseGroupCall(room: GroupCallRoom, peer: GroupCallPeer, token: string) {
  const url = resolveApiUrl(groupCallPath(room.conversationId, "leave", room, peer));
  return fetch(url, { method: "POST", keepalive: true, headers: { Authorization: `Bearer ${token}` } })
    .then(() => undefined).catch(() => undefined);
}
