import { verifyGroupInvitationProof } from "./group-call-keys.js";
import { syncMessages } from "../../lib/message-sync.js";
import { useEffect, useState } from "react";
import { groupCallCapacity, type CallType, type ConversationWithMembers, type GroupCallMember, type GroupCallRoom } from "@e2ee-chat/shared";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { supportsE2EECalling } from "../../platform/calls.js";
import { currentGroupInvitation, groupCallActions, refreshGroupCallStatus, useGroupCallStore } from "./group-call-store.js";

export function useGroupCall() {
  const { session, ended, busy, error, event, layout, pinnedUserId, minimized, selfViewHidden, statuses } = useGroupCallStore();
  const userId = useAuthStore((state) => state.user?.id);
  const room = session?.room ?? ended?.room;
  const chat = useChatStore((state) => state.conversations.find((conversation) => conversation.id === room?.conversationId));
  const status = room && statuses[room.conversationId];
  const me = status ? status.members.find((member) => member.userId === userId)
    : chat?.members.find((member) => member.userId === userId && member.acceptedAt !== null);
  const participants = session?.tiles.map((tile) => {
    const member = chat?.members.find((person) => person.userId === tile.userId);
    return { ...tile, displayName: member?.user.displayName, avatarUrl: member?.user.avatarUrl,
      role: (status && status.members.find((item) => item.userId === tile.userId)?.role) ?? member?.role };
  }) ?? [];
  const visibleSharer = participants.find((tile) => tile.userId === session?.screenShareOwnerId && tile.screen)?.userId
    ?? participants.find((tile) => tile.media?.sharing && tile.screen)?.userId;
  const spotlightUserId = pinnedUserId ?? visibleSharer
    ?? session?.activeSpeakerId ?? participants[0]?.userId ?? null;
  return { session, room, ended, busy, error, layout, pinnedUserId, spotlightUserId, minimized, selfViewHidden, participants,
    event: event && Date.now() - event.at < 4000 ? event : null,
    maxParticipants: room ? groupCallCapacity(room.type) : null,
    canEndForEveryone: !!session && !!me && (me.role === "admin" || room?.initiatorId === userId),
    actions: groupCallActions };
}

export type GroupCallBannerState = "loading" | "hidden" | "start" | "waiting" | "active" | "return" | "join_here"
  | "full" | "timed_out" | "unsupported" | "needs_members";

export function selectGroupCallBanner(input: {
  room: GroupCallRoom | null; enabled: boolean; accepted: boolean; supported: boolean;
  userId?: string; deviceId?: string; localCallId?: string; timedOutUntil?: number | null; now: number; acceptedCount: number;
}): GroupCallBannerState {
  const { room, enabled, accepted, supported, userId, deviceId, localCallId, timedOutUntil, now, acceptedCount } = input;
  if (!accepted || (!room && !enabled)) return "hidden";
  if (room && room.id === localCallId) return "return";
  if ((timedOutUntil ?? 0) > now) return "timed_out";
  if (!supported) return "unsupported";
  if (!room) return acceptedCount < 2 ? "needs_members" : "start";
  const participant = room.participants.find((peer) => peer.userId === userId);
  if (participant) return participant.deviceId !== deviceId ? "join_here" : room.participants.length === 1 ? "waiting" : "active";
  if (room.participants.length >= groupCallCapacity(room.type)) return "full";
  return room.participants.length === 1 ? "waiting" : "active";
}

export function useGroupCallBanner(conversation: ConversationWithMembers | null | undefined) {
  const conversationId = conversation?.type === "group" ? conversation.id : undefined;
  const userId = useAuthStore((state) => state.user?.id);
  const deviceId = useAuthStore((state) => state.device?.id);
  const enabled = useGroupCallStore((state) => state.rollout);
  const status = useGroupCallStore((state) => conversationId ? state.statuses[conversationId] : undefined);
  const localRoom = useGroupCallStore((state) => state.session?.room);
  const [now, setNow] = useState(Date.now);
  const membership = conversation?.members.find((member) => member.userId === userId);
  const accepted = !!membership && membership.acceptedAt !== null;
  useEffect(() => {
    if (!conversationId || !accepted) return;
    void refreshGroupCallStatus(conversationId);
    const timer = setInterval(() => void refreshGroupCallStatus(conversationId), 15_000);
    return () => clearInterval(timer);
  }, [conversationId, accepted, enabled]);
  const room = localRoom && localRoom.conversationId === conversationId ? localRoom : status?.room ?? null;
  const member = status?.members.find((item) => item.userId === userId);
  const timedOutUntil = member ? member.timedOutUntil : membership?.timedOutUntil;
  useEffect(() => {
    if (!room && !timedOutUntil) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [room?.id, timedOutUntil]);
  const clockOffset = useGroupClockOffset(status);
  const serverNow = now + clockOffset;
  const state = conversationId ? selectGroupCallBanner({
    room, enabled: status?.enabled ?? enabled, accepted, supported: supportsE2EECalling(), userId, deviceId, localCallId: localRoom?.id, timedOutUntil,
    now: serverNow, acceptedCount: status?.members.length ?? conversation?.members.filter((item) => item.acceptedAt !== null).length ?? 0,
  }) : "hidden";
  return { state, room, timedOutUntil, maxParticipants: room ? groupCallCapacity(room.type) : null,
    elapsedSeconds: room ? Math.max(0, Math.floor((serverNow - room.startedAt) / 1000)) : 0,
    timeline: status?.timeline ?? [], actions: groupCallActions };
}

function useGroupClockOffset(status: { serverTime: number } | undefined) {
  const [offset, setOffset] = useState(0);
  useEffect(() => { if (status) setOffset(status.serverTime - Date.now()); }, [status]);
  return offset;
}

export function selectRingMembers(
  members: GroupCallMember[], conversation: ConversationWithMembers, userId: string | undefined, room: GroupCallRoom | null, now: number,
) {
  return members.filter((member) => member.userId !== userId).map((member) => {
    const profile = conversation.members.find((person) => person.userId === member.userId)?.user;
    const inCall = !!room?.participants.some((participant) => participant.userId === member.userId);
    const stage = inCall ? "in_call" : (member.timedOutUntil ?? 0) > now ? "timed_out" : !member.capable ? "needs_update"
      : member.ringState === "ringing" && (member.ringUntil ?? 0) <= now ? "no_answer" : member.ringState ?? "available";
    return { ...member, ...profile, stage,
      canRing: !inCall && member.capable && (member.timedOutUntil ?? 0) <= now && (member.ringUntil ?? 0) <= now
        && (!room || room.participants.length < groupCallCapacity(room.type)) };
  });
}

export function useRingMembersPicker(conversation: ConversationWithMembers, type: CallType) {
  const banner = useGroupCallBanner(conversation);
  const userId = useAuthStore((state) => state.user?.id);
  const status = useGroupCallStore((state) => state.statuses[conversation.id]);
  const maxSelections = groupCallCapacity(banner.room?.type ?? type) - 1;
  const clockOffset = useGroupClockOffset(status);
  const members = selectRingMembers(status?.members ?? [], conversation, userId, banner.room, Date.now() + clockOffset);
  const eligible = members.filter((member) => member.canRing);
  const defaultSelectedUserIds = !banner.room && (status?.members.length ?? Infinity) <= maxSelections + 1
    ? eligible.map((member) => member.userId) : [];
  return { members, maxSelections, defaultSelectedUserIds, loading: !status };
}

export function useGroupCallInvitation() {
  const invites = useGroupCallStore((state) => state.invitations);
  const session = useGroupCallStore((state) => state.session);
  const starting = useGroupCallStore((state) => state.busy);
  const directBusy = useCallStore((state) => !!state.pendingCallStart || state.callStatus === "ringing" || state.callStatus === "active");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timers = invites.filter((invite) => invite.ringUntil > Date.now())
      .map((invite) => setTimeout(() => setNow(Date.now()), invite.ringUntil - Date.now() + 1));
    return () => timers.forEach(clearTimeout);
  }, [invites]);
  const invitation = currentGroupInvitation(invites, now, !!session || starting || directBusy);
  const userId = useAuthStore((state) => state.user?.id);
  const deviceId = useAuthStore((state) => state.device?.id);
  const [verified, setVerified] = useState<string | null>(null);
  const invitationKey = invitation && `${invitation.callId}:${invitation.ringUntil}`;
  useEffect(() => {
    if (!invitation || !userId || !deviceId || verified === invitationKey) return;
    let cancelled = false;
    const read = () => {
      void verifyGroupInvitationProof(invitation, userId, deviceId).then((ready) => {
        if (ready && !cancelled) setVerified(invitationKey);
      }).catch(() => undefined);
    };
    read();
    void syncMessages({ force: true, callControl: true }).catch(() => undefined).then(read);
    const timer = setInterval(read, 700);
    return () => { cancelled = true; clearInterval(timer); };
  }, [invitationKey, userId, deviceId, verified]);
  const status = useGroupCallStore((state) => invitation ? state.statuses[invitation.conversationId] : undefined);
  const notice = useGroupCallStore((state) => state.notice);
  return { invitation, notice, room: status?.room ?? null, keyReady: !!invitationKey && invitationKey === verified, actions: groupCallActions };
}


/** A cheap chat-list selector. The provider refreshes the active-room index. */
export function useGroupCallActivityIndicator(conversationId: string) {
  return useGroupCallStore((state) => state.activeByConversation[conversationId] ?? null);
}
