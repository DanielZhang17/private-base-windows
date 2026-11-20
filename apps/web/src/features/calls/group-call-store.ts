import { deliverGroupInvitations } from "./group-call-invitations.js";
import { verifyGroupInvitationProof } from "./group-call-keys.js";
import { syncMessages } from "../../lib/message-sync.js";
import { create } from "zustand";
import {
  GROUP_CALL_CAPABILITY, groupCallErrorCodes,
  type GroupCallErrorCode, type GroupCallExitReason, type GroupCallInvitation, type GroupCallMetric,
  type GroupCallNotice, type GroupCallInviteTarget, type GroupCallPeer, type GroupCallRoom, type GroupCallStatusResponse, type CallType,
} from "@e2ee-chat/shared";
import { api, ApiError } from "../../services/api.js";
import { isSameSession } from "../../services/session-identity.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { supportsE2EECalling } from "../../platform/calls.js";
import { platformName } from "../../platform/environment.js";
import { advertiseGroupCallPush } from "../../services/web-push.js";
import { groupCallPath, loadGroupCallStatus, releaseGroupCall } from "./group-call-api.js";
import { hasLocalGroupCall, reserveGroupCall } from "./group-call-ownership.js";
import { GroupCallSession, type GroupCallSessionView, type GroupCallTransientEvent } from "./group-call-session.js";

export type GroupCallActionResult = { ok: true } | { ok: false; code: GroupCallErrorCode };
export type GroupCallLayout = "auto" | "grid" | "spotlight";

interface State {
  rollout: boolean;
  busy: boolean;
  session: GroupCallSessionView | null;
  ended: { room: GroupCallRoom; reason: GroupCallExitReason } | null;
  error: GroupCallErrorCode | null;
  statuses: Record<string, GroupCallStatusResponse>;
  activeByConversation: Record<string, string>;
  invitations: GroupCallInvitation[];
  notice: GroupCallNotice | null;
  event: GroupCallTransientEvent | null;
  layout: GroupCallLayout;
  pinnedUserId: string | null;
  minimized: boolean;
  selfViewHidden: boolean;
}

const initialState: State = {
  rollout: false, busy: false, session: null, ended: null, error: null, statuses: {}, activeByConversation: {},
  invitations: [], notice: null, event: null, layout: "auto", pinnedUserId: null, minimized: false, selfViewHidden: false,
};
export const useGroupCallStore = create<State>(() => initialState);
const { getState, setState } = useGroupCallStore;
const capability = GROUP_CALL_CAPABILITY;
const route = "/api/group-calls";
type Auth = ReturnType<typeof useAuthStore.getState>;
let lifetime: AbortController | undefined;
let currentCall: { session: GroupCallSession; room: GroupCallRoom; peer: GroupCallPeer; auth: Auth; release: () => void } | null = null;
const statusRequests = new Map<string, Promise<GroupCallStatusResponse | undefined>>();
let invitationRequest: Promise<GroupCallInvitation[]> | undefined;
let refreshInvitationsAgain = false;
let providerAuth: Auth | undefined;
let pendingEnter: { release: () => void; runtime: AbortController | undefined } | undefined;
let postedBusyCallId: string | undefined;

function sameAuth(auth: Auth) {
  const now = useAuthStore.getState();
  return isSameSession(auth, now) && now.user?.id === auth.user?.id && now.device?.id === auth.device?.id;
}

function runtimeCurrent() {
  return !!lifetime && !lifetime.signal.aborted && !!providerAuth && sameAuth(providerAuth);
}

function directBusy() {
  const direct = useCallStore.getState();
  return !!direct.pendingCallStart || direct.callStatus === "ringing" || direct.callStatus === "active";
}

export function currentGroupInvitation(invites: GroupCallInvitation[], now: number, busy: boolean) {
  return busy ? null : invites.find((invite) => invite.ringUntil > now) ?? null;
}

function recordMetric(event: GroupCallMetric["event"], room: GroupCallRoom) {
  const count = room.participants.length;
  const size = count <= 1 ? "1" : count <= 4 ? "2-4" : count <= 8 ? "5-8" : "9-12";
  if (runtimeCurrent()) void api.post(`${route}/metrics?cap=${capability}`,
    { event, size, media: room.type, platform: platformName() } satisfies GroupCallMetric,
    { signal: lifetime?.signal }).catch(() => undefined);
}

function groupCode(error: unknown): GroupCallErrorCode {
  const code = error instanceof ApiError ? error.code : undefined;
  return groupCallErrorCodes.find((known) => known === code) ?? "call_network";
}

function failure(code: GroupCallErrorCode): GroupCallActionResult {
  setState({ error: code });
  return { ok: false, code };
}

function removeInvitation(callId: string) {
  setState((state) => ({ invitations: state.invitations.filter((invitation) => invitation.callId !== callId) }));
}

export function refreshGroupCallStatus(conversationId: string) {
  if (!runtimeCurrent()) return Promise.resolve(undefined);
  const started = lifetime;
  const pending = statusRequests.get(conversationId);
  if (pending) return pending;
  const task = loadGroupCallStatus(conversationId, started?.signal).then((status) => {
    if (lifetime !== started || !runtimeCurrent()) return;
    setState((state) => {
      const activeByConversation = { ...state.activeByConversation };
      if (status.room) activeByConversation[conversationId] = status.room.id;
      else delete activeByConversation[conversationId];
      return { statuses: { ...state.statuses, [conversationId]: status }, activeByConversation };
    });
    return status;
  }).catch((error) => {
    if (lifetime !== started || !runtimeCurrent() || !(error instanceof ApiError) || error.status !== 403) return;
    setState((state) => {
      const statuses = { ...state.statuses };
      delete statuses[conversationId];
      const activeByConversation = { ...state.activeByConversation };
      delete activeByConversation[conversationId];
      return { statuses, activeByConversation, invitations: state.invitations.filter((invite) => invite.conversationId !== conversationId) };
    });
    return undefined;
  }).finally(() => {
    if (statusRequests.get(conversationId) === task) statusRequests.delete(conversationId);
  });
  statusRequests.set(conversationId, task);
  return task;
}

export function refreshGroupInvitations() {
  if (!runtimeCurrent() || !supportsE2EECalling()) return Promise.resolve<GroupCallInvitation[]>([]);
  if (invitationRequest) { refreshInvitationsAgain = true; return invitationRequest; }
  const started = lifetime;
  const request = api.get<GroupCallInvitation[]>(`${route}/incoming?cap=${capability}`, started?.signal).then((invitations) => {
    if (lifetime !== started || !runtimeCurrent()) return [];
    const eligible = invitations.filter((invite) => invite.ringUntil > Date.now() && currentCall?.room.id !== invite.callId);
    const ringing = eligible[0];
    setState({ invitations: eligible });
    if (ringing && ringing.callId !== postedBusyCallId && (hasLocalGroupCall() || directBusy())) {
      postedBusyCallId = ringing.callId;
      setState({ notice: { kind: "ring", conversationId: ringing.conversationId, callId: ringing.callId } });
    }
    return eligible;
  }).catch(() => []).finally(() => {
    if (invitationRequest !== request) return;
    invitationRequest = undefined;
    if (refreshInvitationsAgain) {
      refreshInvitationsAgain = false;
      void refreshGroupInvitations();
    }
  });
  invitationRequest = request;
  return request;
}

export function handleGroupCallNotice(notice: GroupCallNotice) {
  if (!runtimeCurrent()) return;
  if (notice.kind === "keys") {
    if (currentCall?.room.id === notice.callId) currentCall.session.refreshKeys();
    else if (getState().invitations.some((invite) => invite.callId === notice.callId)) {
      void syncMessages({ force: true, callControl: true }).catch(() => undefined);
    }
    return;
  }
  if (notice.kind !== "changed") setState((state) => ({ ...(notice.kind === "quiet" && { notice }),
    activeByConversation: { ...state.activeByConversation, [notice.conversationId]: notice.callId } }));
  void refreshGroupCallStatus(notice.conversationId);
  void refreshGroupInvitations();
}

type GroupCallActivity = { conversationId: string; callId: string; startedAt: number };

export async function refreshGroupCallActivity() {
  if (!runtimeCurrent()) return [];
  const started = lifetime;
  try {
    const active = await api.get<GroupCallActivity[]>(`${route}/active`, started?.signal);
    if (lifetime !== started || !runtimeCurrent() || !Array.isArray(active)) return [];
    setState({ activeByConversation: Object.fromEntries(active.map(({ conversationId, callId }) => [conversationId, callId])) });
    return active;
  } catch { return []; }
}

export function groupCallPresenceOpened() {
  if (!runtimeCurrent() || !supportsE2EECalling()) return;
  void refreshGroupInvitations();
  void refreshGroupCallActivity();
}

async function refreshRollout() {
  if (!runtimeCurrent() || !supportsE2EECalling()) return;
  const started = lifetime;
  try {
    const result = await api.get<{ enabled: boolean }>(`${route}/rollout`, started?.signal);
    if (lifetime !== started || !runtimeCurrent() || typeof result.enabled !== "boolean") return;
    const wasEnabled = getState().rollout;
    if (wasEnabled !== result.enabled) {
      setState({ rollout: result.enabled });
      if (result.enabled) {
        void advertiseGroupCallPush().catch(() => undefined);
        groupCallPresenceOpened();
      }
    }
  } catch { /* A missing rollout endpoint keeps this unavailable on older Workers. */ }
}

export function startGroupCallRuntime() {
  const auth = useAuthStore.getState();
  if (!auth.user || !auth.device || !auth.accessToken) return () => {};
  const runtime = new AbortController();
  lifetime = runtime;
  providerAuth = auth;
  void refreshRollout();
  let poll = 0;
  const interval = setInterval(() => {
    if (!runtimeCurrent()) return;
    const invitations = getState().invitations;
    const active = invitations.filter((invitation) => invitation.ringUntil > Date.now());
    if (active.length !== invitations.length) setState({ invitations: active });
    if (currentCall) void refreshGroupCallStatus(currentCall.room.conversationId);
    if (++poll % 4 === 0) {
      if (getState().rollout || Object.keys(getState().activeByConversation).length) void refreshGroupCallActivity();
      void refreshRollout();
    }
  }, 10_000);
  const unsub = useAuthStore.subscribe(() => { if (!sameAuth(auth)) stop(); });
  const visibility = () => { if (!document.hidden) groupCallPresenceOpened(); };
  const pageHide = () => {
    const owned = currentCall;
    if (owned) finishLocal("left", owned.room, true);
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", pageHide);
  function stop() {
    if (runtime.signal.aborted) return;
    if (currentCall && lifetime === runtime) finishLocal("left", currentCall.room, true);
    if (pendingEnter?.runtime === runtime) { pendingEnter.release(); pendingEnter = undefined; }
    runtime.abort();
    clearInterval(interval);
    unsub();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", pageHide);
    if (lifetime === runtime) {
      invitationRequest = undefined;
      refreshInvitationsAgain = false;
      postedBusyCallId = undefined;
      statusRequests.clear();
      setState(initialState);
      lifetime = undefined;
      providerAuth = undefined;
    }
  }
  return stop;
}

function finishLocal(reason: GroupCallExitReason, room: GroupCallRoom, notifyServer: boolean) {
  const owned = currentCall;
  if (!owned || owned.room.id !== room.id) return;
  if (notifyServer) {
    const token = (sameAuth(owned.auth) ? useAuthStore.getState().accessToken : null) ?? owned.auth.accessToken;
    if (token) void releaseGroupCall(room, owned.peer, token).then(() => refreshGroupCallStatus(room.conversationId));
  }
  currentCall = null;
  owned.release();
  owned.session.stop();
  setState({ session: null, ended: { room, reason }, minimized: false, pinnedUserId: null, event: null });
  void refreshGroupCallStatus(room.conversationId);
}

async function enter(conversationId: string, mode: { start: CallType; ringUserIds: string[] } | { callId: string; cameraOff: boolean }): Promise<GroupCallActionResult> {
  const auth = useAuthStore.getState();
  const { user, device } = auth;
  const started = lifetime;
  if (!runtimeCurrent() || !user || !device || !auth.accessToken) return failure("call_unavailable");
  if (!supportsE2EECalling()) return failure("call_capability_required");
  if (document.hidden) return failure("call_unavailable");
  if (directBusy() || hasLocalGroupCall()) return failure("call_already_in_progress");
  const release = reserveGroupCall();
  if (!release) return failure("call_already_in_progress");
  const admission = { release, runtime: started };
  pendingEnter = admission;
  const peer: GroupCallPeer = { userId: user.id, deviceId: device.id, sessionId: crypto.randomUUID() };
  let audio: AudioContext | undefined;
  let room: GroupCallRoom | undefined;
  let entered = false;
  const current = () => started === lifetime && runtimeCurrent() && sameAuth(auth);
  try {
    if (typeof AudioContext !== "undefined") {
      try { audio = new AudioContext(); void audio.resume().catch(() => undefined); } catch { /* Speaker detection is optional on this device. */ }
    }
    setState({ busy: true, error: null, ended: null, event: null, minimized: false, selfViewHidden: false });
    let created = false;
    let invites: GroupCallInviteTarget[] = [];
    if ("start" in mode) {
      const result = await api.post<{ room: GroupCallRoom; created: boolean; invites?: GroupCallInviteTarget[] }>(groupCallPath(conversationId, "start"),
        { type: mode.start, ringUserIds: mode.ringUserIds, sessionId: peer.sessionId });
      room = result.room;
      created = result.created;
      invites = result.invites ?? [];
      entered = created;
    }
    if (!entered) {
      if (!current()) return { ok: false, code: "call_unavailable" };
      const callId = room?.id ?? ("callId" in mode ? mode.callId : undefined);
      if (!callId) return failure("call_unavailable");
      const params = new URLSearchParams({ cap: capability, callId, sessionId: peer.sessionId });
      room = (await api.post<{ room: GroupCallRoom }>(`${route}/${encodeURIComponent(conversationId)}/join?${params}`)).room;
      entered = true;
    }
    if (!room || !current() || document.hidden) return current() ? failure("call_unavailable") : { ok: false, code: "call_unavailable" };
    const session = new GroupCallSession(room, peer, "cameraOff" in mode && mode.cameraOff, {
      change: (view) => {
        if (!current()) return;
        setState((state) => ({ session: view, pinnedUserId: view.tiles.some((tile) => tile.userId === state.pinnedUserId) ? state.pinnedUserId : null }));
      },
      exit: (reason, snapshot) => finishLocal(reason, snapshot, reason === "lost_connection"),
      event: (event) => { if (current()) setState({ event }); },
      metric: (event) => { if (current()) recordMetric(event, getState().session?.room ?? room!); },
    }, audio);
    currentCall = { session, room, peer, auth, release };
    if (invites.length) void deliverGroupInvitations(room, peer, invites, session.signal).catch(() => undefined);
    recordMetric(created ? "start" : "join", room);
    removeInvitation(room.id);
    void refreshGroupCallStatus(conversationId);
    return { ok: true };
  } catch (error) {
    return current() ? failure(groupCode(error)) : { ok: false, code: "call_unavailable" };
  } finally {
    if (pendingEnter === admission) pendingEnter = undefined;
    if (!currentCall || currentCall.peer.sessionId !== peer.sessionId) {
      release();
      void audio?.close().catch(() => undefined);
      if (entered && room) void releaseGroupCall(room, peer, auth.accessToken);
    }
    if (current()) setState({ busy: false });
  }
}

export const groupCallActions = {
  start: (conversationId: string, type: CallType, ringUserIds: string[]) => enter(conversationId, { start: type, ringUserIds }),
  join: (conversationId: string, callId: string) => enter(conversationId, { callId, cameraOff: false }),
  joinCameraOff: (conversationId: string, callId: string) => enter(conversationId, { callId, cameraOff: true }),
  joinInvitation: async (invite: GroupCallInvitation, cameraOff = false): Promise<GroupCallActionResult> => {
    const auth = useAuthStore.getState();
    if (!auth.user || !auth.device || !runtimeCurrent()) return failure("call_unavailable");
    const verified = await verifyGroupInvitationProof(invite, auth.user.id, auth.device.id).catch(() => false);
    if (!runtimeCurrent() || !sameAuth(auth)) return { ok: false, code: "call_unavailable" };
    return verified ? enter(invite.conversationId, { callId: invite.callId, cameraOff }) : failure("call_invitation_pending");
  },
  decline: async (invite: GroupCallInvitation): Promise<GroupCallActionResult> => {
    if (!runtimeCurrent()) return { ok: false, code: "call_unavailable" };
    const started = lifetime;
    const path = `${route}/${encodeURIComponent(invite.conversationId)}/decline?cap=${capability}&callId=${encodeURIComponent(invite.callId)}`;
    try {
      await api.post(path, undefined, { signal: started?.signal });
      if (started === lifetime && runtimeCurrent()) removeInvitation(invite.callId);
      return { ok: true };
    } catch (error) { return started === lifetime && runtimeCurrent() ? failure(groupCode(error)) : { ok: false, code: "call_unavailable" }; }
  },
  leave: async () => {
    if (!currentCall) return;
    const { room } = currentCall;
    const snapshot = getState().session?.room ?? room;
    recordMetric("leave", snapshot);
    finishLocal("left", snapshot, true);
  },
  endForEveryone: async (): Promise<GroupCallActionResult> => {
    const call = currentCall;
    if (!call) return failure("call_unavailable");
    try {
      const { room } = await api.post<{ room: GroupCallRoom }>(groupCallPath(call.room.conversationId, "end", call.room, call.peer),
        undefined, { signal: lifetime?.signal });
      if (runtimeCurrent() && currentCall === call) finishLocal("ended_for_everyone", room, false);
      return { ok: true };
    } catch (error) { return runtimeCurrent() && currentCall === call ? failure(groupCode(error)) : { ok: false, code: "call_unavailable" }; }
  },
  ring: async (userIds: string[]): Promise<GroupCallActionResult> => {
    const call = currentCall;
    if (!call) return failure("call_unavailable");
    try {
      const { invites } = await api.post<{ invites: GroupCallInviteTarget[] }>(
        groupCallPath(call.room.conversationId, "ring", call.room, call.peer), userIds, { signal: call.session.signal });
      if (runtimeCurrent() && currentCall === call) {
        const room = getState().session?.room ?? call.room;
        void deliverGroupInvitations(room, call.peer, invites, call.session.signal).catch(() => undefined);
        void refreshGroupCallStatus(call.room.conversationId);
      }
      return { ok: true };
    } catch (error) { return runtimeCurrent() && currentCall === call ? failure(groupCode(error)) : { ok: false, code: "call_unavailable" }; }
  },
  pin: (userId: string | null) => {
    if (userId === null || getState().session?.tiles.some((tile) => tile.userId === userId)) setState({ pinnedUserId: userId });
  },
  setLayout: (layout: GroupCallLayout) => setState({ layout }),
  setSelfViewHidden: (selfViewHidden: boolean) => setState({ selfViewHidden }),
  minimize: () => setState({ minimized: true }),
  restore: () => setState({ minimized: false }),
  dismissEnd: () => setState({ ended: null }),
  clearError: () => setState({ error: null }),
  clearNotice: () => setState({ notice: null }),
  toggleMute: () => currentCall?.session.toggleMute(),
  toggleCamera: () => currentCall?.session.toggleCamera(),
  retryMicrophone: () => currentCall?.session.retryMicrophone(),
  selectCamera: (id: string) => currentCall?.session.selectCamera(id),
  toggleScreenShare: () => currentCall?.session.toggleScreen(),
};
