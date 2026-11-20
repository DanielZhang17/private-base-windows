// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationWithMembers, GroupCallRoom } from "@e2ee-chat/shared";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { groupCallActions, useGroupCallStore } from "./group-call-store.js";
import { selectGroupCallBanner, useGroupCall, useGroupCallActivityIndicator, useGroupCallBanner, useGroupCallInvitation, useRingMembersPicker } from "./useGroupCall.js";

vi.mock("../../platform/calls.js", async (load) => ({
  ...await load<typeof import("../../platform/calls.js")>(), supportsE2EECalling: () => true,
}));
vi.mock("./group-call-keys.js", async (load) => ({
  ...await load<typeof import("./group-call-keys.js")>(), verifyGroupInvitationProof: vi.fn(async () => true),
}));
vi.mock("../../lib/message-sync.js", () => ({ syncMessages: vi.fn(async () => undefined) }));

const self = { userId: "me", deviceId: "mine", sessionId: "session" };
const other = { userId: "other", deviceId: "their-device", sessionId: "their-session" };
const now = 2_000_000;
const room: GroupCallRoom = { id: "call", conversationId: "group", initiatorId: "me", epoch: 1, type: "video",
  startedAt: now - 60_000, aloneUntil: null, endedAt: null, participants: [{ ...self, joinedAt: now }] };
const membership = (userId: string) => ({
  conversationId: "group", userId, role: "member" as const, joinedAt: now - 1000, acceptedAt: now - 500,
  user: { displayName: userId, username: userId, avatarUrl: null },
});
const chat: ConversationWithMembers = { id: "group", type: "group", createdAt: 1, updatedAt: 1, createdBy: "me",
  name: "Test", avatarUrl: null, invitePolicy: "any_member", members: ["me", "other", "legacy", "timed"].map(membership) };
const initial = useGroupCallStore.getInitialState();
let root: ReturnType<typeof createRoot>;
let container: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(now);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  useGroupCallStore.setState(initial);
  useCallStore.getState().clearAllCalls();
  useAuthStore.setState({ user: { id: "me" }, device: { id: "mine" } } as never);
});
afterEach(async () => {
  await act(async () => root.unmount());
  useGroupCallStore.setState(initial);
  useCallStore.getState().clearAllCalls();
  useAuthStore.getState().logout();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("maps the active banner, participant picker, and call-list indicator from the scoped store", async () => {
  let banner!: ReturnType<typeof useGroupCallBanner>;
  let picker!: ReturnType<typeof useRingMembersPicker>;
  let activity: string | null;
  function Probe() {
    banner = useGroupCallBanner(chat);
    picker = useRingMembersPicker(chat, "video");
    activity = useGroupCallActivityIndicator(chat.id);
    return null;
  }
  const members = chat.members.map(({ userId, role }) => ({ userId, role, capable: userId !== "legacy",
    timedOutUntil: userId === "timed" ? now + 30_000 : null }));
  const status = { enabled: true, serverTime: now, room: null, members, timeline: [] };
  useGroupCallStore.setState({ rollout: true, statuses: { group: status } });
  await act(async () => root.render(<Probe />));
  expect(banner.state).toBe("start");
  expect(picker.defaultSelectedUserIds).toEqual(["other"]);
  expect(picker.members.map((member) => member.stage)).toEqual(["available", "needs_update", "timed_out"]);
  await act(async () => useGroupCallStore.setState({ statuses: { group: { ...status, room } }, activeByConversation: { group: room.id } }));
  expect(activity!).toBe(room.id);
  expect(banner.state).toBe("waiting");
  expect(banner.elapsedSeconds).toBe(60);
  expect(picker.defaultSelectedUserIds).toEqual([]);
});

it("gives handoff priority over the full state and allows late join during rollout rollback", () => {
  const input = { room, accepted: true, supported: true, userId: "me", enabled: false, now, acceptedCount: 2 };
  expect(selectGroupCallBanner(input)).toBe("join_here");
  expect(selectGroupCallBanner({ ...input, deviceId: self.deviceId })).toBe("waiting");
  expect(selectGroupCallBanner({ ...input, userId: "other" })).toBe("waiting");
  expect(selectGroupCallBanner({ ...input, room: null })).toBe("hidden");
  expect(selectGroupCallBanner({ ...input, userId: "other", timedOutUntil: now + 1 })).toBe("timed_out");
  expect(selectGroupCallBanner({ ...input, localCallId: room.id })).toBe("return");
  const full = { ...room, participants: Array.from({ length: 8 }, (_, index) => ({ ...other, userId: String(index), joinedAt: now })) };
  expect(selectGroupCallBanner({ ...input, room: full })).toBe("full");
});

it("selects screen sharing before the active speaker and gives a pinned tile priority", async () => {
  let state!: ReturnType<typeof useGroupCall>;
  function Probe() { state = useGroupCall(); return null; }
  const baseTile = { stage: "live", quality: "ok", keyWaiting: false, secureMedia: true, videoPaused: false, stream: null, speaking: false,
    media: { muted: false, cameraOff: false, receivingVideo: true, sharing: false }, screen: null } as const;
  const session = { room, stage: "live", tiles: [
    { ...other, ...baseTile },
    { ...baseTile, ...self, userId: "sharer", screen: {} as MediaStream, media: { ...baseTile.media, sharing: true } },
  ], activeSpeakerId: other.userId } as unknown as NonNullable<ReturnType<typeof useGroupCall>["session"]>;
  useGroupCallStore.setState({ session, statuses: { group: { enabled: true, room, timeline: [],
    serverTime: now, members: [{ userId: "me", role: "member", capable: true, timedOutUntil: null }] } } });
  await act(async () => root.render(<Probe />));
  expect(state.canEndForEveryone).toBe(true);
  expect(state.spotlightUserId).toBe("sharer");
  await act(async () => groupCallActions.pin(other.userId));
  expect(state.spotlightUserId).toBe(other.userId);
  await act(async () => groupCallActions.setLayout("grid"));
  expect(state.layout).toBe("grid");
});

it("gates the incoming sheet on a device proof, existing direct calls, and expiry", async () => {
  let view!: ReturnType<typeof useGroupCallInvitation>;
  function Probe() { view = useGroupCallInvitation(); return null; }
  useGroupCallStore.setState({ invitations: [{ callId: room.id, conversationId: chat.id,
    initiatorId: other.userId, callType: "video", ringFrom: other, ringUntil: now + 5000 }] });
  await act(async () => root.render(<Probe />));
  expect(view.keyReady).toBe(true);
  expect(view.invitation?.callId).toBe(room.id);
  await act(async () => useCallStore.setState({ callStatus: "active" }));
  expect(view.invitation).toBeNull();
  await act(async () => useCallStore.getState().clearAllCalls());
  await act(async () => vi.advanceTimersByTimeAsync(5001));
  expect(view.invitation).toBeNull();
});
