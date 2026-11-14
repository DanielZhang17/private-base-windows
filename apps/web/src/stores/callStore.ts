import { create } from "zustand";
import type { CallStatus, CallType } from "@e2ee-chat/shared";

interface BaseCallMeta {
  callId: string;
  conversationId: string;
  callType: CallType;
  initiatorId: string;
}

interface CallState {
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
  setOutgoingCall: (meta: BaseCallMeta & { conversationName?: string | null }) => void;
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
  clearCall: () => void;
  isMinimized: boolean;
  setMinimized: (minimized: boolean) => void;
}

function resetState(state: CallState) {
  state.localStream?.getTracks().forEach((track) => track.stop());
  return {
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
  setOutgoingCall: (meta) =>
    set(() => ({
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
    })),
  hydrateCall: (meta) =>
    set((state) => ({
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
    set((state) => (state.activeCallId === callId ? { callStatus: status } : {})),
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
  clearCall: () =>
    set((state) => resetState(state as CallState)),
  setMinimized: (minimized) =>
    set(() => ({ isMinimized: minimized })),
}));
