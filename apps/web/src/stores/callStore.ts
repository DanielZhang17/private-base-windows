import { create } from "zustand";
import { registerLocalCallCleanup } from "../platform/session-cleanup.js";
import { stopAllCapturedTracks } from "../platform/media.js";
import type { CallStatus, CallType } from "@e2ee-chat/shared";

interface BaseCallMeta {
  callId: string;
  conversationId: string;
  callType: CallType;
  initiatorId: string;
}

type OutgoingCallMeta = BaseCallMeta & { conversationName?: string | null };

interface CallState {
  pendingCallStart: { token: symbol; callId: string | null } | null;
  beginCallStart: () => symbol | null;
  bindCallStart: (token: symbol, callId: string) => boolean;
  finishCallStart: (token: symbol) => void;
  /** This tab only; a local end/lock/sign-out invalidates pending call work. */
  localCallEpoch: number;
  // In-memory and tab-local: never persisted, broadcast, or inferred from server status.
  localCallOwnership: { callId: string; reason: "started" | "accepted" } | null;
  acceptLocalCall: (callId: string) => boolean;
  releaseCallOwnership: (callId: string) => void;
  activeCallId: string | null;
  conversationId: string | null;
  callType: CallType | null;
  callStatus: CallStatus | null;
  direction: "incoming" | "outgoing" | null;
  initiatorId: string | null;
  callerUserId: string | null;
  callerName: string | null;
  callerAvatarUrl: string | null;
  conversationName: string | null;
  keyReady: boolean;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  isMuted: boolean;
  isVideoOff: boolean;
  setIncomingCall: (
    meta: BaseCallMeta & {
      callerUserId: string;
      callerName?: string | null;
      callerAvatarUrl?: string | null;
      conversationName?: string | null;
      keyReady?: boolean;
    },
  ) => void;
  setOutgoingCall: (meta: OutgoingCallMeta, token?: symbol) => boolean;
  hydrateCall: (
    meta: BaseCallMeta & {
      status: CallStatus;
      direction: "incoming" | "outgoing";
      keyReady?: boolean;
      callerUserId?: string | null;
      callerName?: string | null;
      callerAvatarUrl?: string | null;
      conversationName?: string | null;
    },
  ) => void;
  updateCallStatus: (callId: string, status: CallStatus) => void;
  markKeyReady: (callId: string, ready?: boolean) => void;
  setCallDetails: (
    callId: string,
    details: { callerName?: string | null; callerAvatarUrl?: string | null; conversationName?: string | null },
  ) => void;
  setLocalStream: (stream: MediaStream | null) => void;
  addRemoteStream: (userId: string, stream: MediaStream) => void;
  toggleMute: () => void;
  toggleVideo: () => void;
  clearCall: (callId: string) => void;
  clearAllCalls: () => void;
  isMinimized: boolean;
  setMinimized: (minimized: boolean) => void;
}

function resetState(state: CallState) {
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.remoteStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  return {
    pendingCallStart: null,
    localCallOwnership: null,
    activeCallId: null,
    conversationId: null,
    callType: null,
    callStatus: null,
    direction: null,
    initiatorId: null,
    callerUserId: null,
    callerName: null,
    callerAvatarUrl: null,
    conversationName: null,
    keyReady: false,
    localStream: null,
    remoteStreams: new Map<string, MediaStream>(),
    isMuted: false,
    isVideoOff: false,
    isMinimized: false,
  };
}

export const useCallStore = create<CallState>()((set) => ({
  pendingCallStart: null,
  localCallEpoch: 0,
  localCallOwnership: null,
  activeCallId: null,
  conversationId: null,
  callType: null,
  callStatus: null,
  direction: null,
  initiatorId: null,
  callerUserId: null,
  callerName: null,
  callerAvatarUrl: null,
  conversationName: null,
  keyReady: false,
  localStream: null,
  remoteStreams: new Map(),
  isMuted: false,
  isVideoOff: false,
  isMinimized: false,
  setIncomingCall: (meta) =>
    set(() => ({
      localCallOwnership: null,
      isMinimized: false,
      activeCallId: meta.callId,
      conversationId: meta.conversationId,
      callType: meta.callType,
      callStatus: "ringing",
      direction: "incoming",
      initiatorId: meta.initiatorId,
      callerUserId: meta.callerUserId,
      callerName: meta.callerName ?? null,
      callerAvatarUrl: meta.callerAvatarUrl ?? null,
      conversationName: meta.conversationName ?? null,
      keyReady: meta.keyReady ?? false,
      remoteStreams: new Map(),
    })),
  beginCallStart: () => {
    let token: symbol | null = null;
    set((state) => {
      if (state.pendingCallStart || state.callStatus === "active" || state.callStatus === "ringing") return state;
      token = Symbol("call-start");
      return { ...resetState(state), pendingCallStart: { token, callId: null } };
    });
    return token;
  },
  bindCallStart: (token, callId) => {
    let bound = false;
    set((state) => {
      if (state.pendingCallStart?.token !== token) return state;
      bound = true;
      return { pendingCallStart: { token, callId } };
    });
    return bound;
  },
  finishCallStart: (token) => set((state) => state.pendingCallStart?.token === token ? { pendingCallStart: null } : state),
  setOutgoingCall: (meta, token) => {
    let started = false;
    set((state) => {
      if (token && (state.pendingCallStart?.token !== token || state.pendingCallStart.callId !== meta.callId)) return state;
      started = true;
      return {
        pendingCallStart: null,
        localCallOwnership: { callId: meta.callId, reason: "started" },
        isMinimized: false,
        activeCallId: meta.callId,
        conversationId: meta.conversationId,
        callType: meta.callType,
        callStatus: "ringing",
        direction: "outgoing",
        initiatorId: meta.initiatorId,
        callerUserId: meta.initiatorId,
        callerName: null,
        callerAvatarUrl: null,
        conversationName: meta.conversationName ?? null,
        keyReady: true,
        remoteStreams: new Map(),
      };
    });
    return started;
  },
  acceptLocalCall: (callId) => {
    let accepted = false;
    set((state) => {
      if (state.activeCallId !== callId || state.direction !== "incoming" || !state.keyReady ||
          (state.callStatus !== "ringing" && state.callStatus !== "active")) return {};
      accepted = true;
      return { pendingCallStart: null, localCallOwnership: { callId, reason: "accepted" }, callStatus: "active" };
    });
    return accepted;
  },
  releaseCallOwnership: (callId) => set((state) => state.localCallOwnership?.callId === callId ? { localCallOwnership: null, localCallEpoch: state.localCallEpoch + 1 } : {}),
  hydrateCall: (meta) =>
    set((state) => ({
      localCallOwnership: state.localCallOwnership?.callId === meta.callId &&
        (meta.status === "ringing" || meta.status === "active") ? state.localCallOwnership : null,
      activeCallId: meta.callId,
      conversationId: meta.conversationId,
      callType: meta.callType,
      callStatus: meta.status,
      direction: meta.direction,
      initiatorId: meta.initiatorId,
      callerUserId: meta.callerUserId ?? state.callerUserId,
      callerName: meta.callerName ?? state.callerName,
      callerAvatarUrl: meta.callerAvatarUrl ?? state.callerAvatarUrl,
      conversationName: meta.conversationName ?? state.conversationName,
      keyReady: meta.keyReady ?? state.keyReady,
    })),
  updateCallStatus: (callId, status) =>
    set((state) => {
      const ended = status === "ended" || status === "missed" || status === "declined";
      if (state.activeCallId === callId) return {
        callStatus: status,
        ...(ended ? { localCallOwnership: null, localCallEpoch: state.localCallEpoch + 1 } : {}),
      };
      if (ended && state.pendingCallStart?.callId === callId) return {
        pendingCallStart: null, localCallEpoch: state.localCallEpoch + 1,
      };
      return state;
    }),
  markKeyReady: (callId, ready = true) =>
    set((state) => (state.activeCallId === callId ? { keyReady: ready } : {})),
  setCallDetails: (callId, details) =>
    set((state) => {
      if (state.activeCallId !== callId) return {};
      return {
        callerName: details.callerName ?? state.callerName,
        callerAvatarUrl: details.callerAvatarUrl ?? state.callerAvatarUrl,
        conversationName: details.conversationName ?? state.conversationName,
      };
    }),
  setLocalStream: (stream) => set({ localStream: stream }),
  addRemoteStream: (userId, stream) =>
    set((state) => {
      const remoteStreams = new Map(state.remoteStreams);
      remoteStreams.set(userId, stream);
      return { remoteStreams };
    }),
  toggleMute: () =>
    set((state) => {
      state.localStream?.getAudioTracks().forEach((track) => {
        track.enabled = state.isMuted;
      });
      return { isMuted: !state.isMuted };
    }),
  toggleVideo: () =>
    set((state) => ({ isVideoOff: !state.isVideoOff })),
  clearCall: (callId) => set((state) => {
    // An unresolved/newer Start belongs to a different operation, even before its ID is known.
    if (state.activeCallId && state.activeCallId !== callId) return state;
    if (state.pendingCallStart && state.pendingCallStart.callId !== callId) return state;
    if (state.activeCallId !== callId && state.pendingCallStart?.callId !== callId) return state;
    return { ...resetState(state), localCallEpoch: state.localCallEpoch + 1 };
  }),
  clearAllCalls: () => set((state) => ({ ...resetState(state), localCallEpoch: state.localCallEpoch + 1 })),
  setMinimized: (minimized) =>
    set(() => ({ isMinimized: minimized })),
}));

registerLocalCallCleanup(() => {
  try { useCallStore.getState().clearAllCalls(); }
  finally { stopAllCapturedTracks(); }
});
