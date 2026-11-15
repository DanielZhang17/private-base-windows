import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {} from "vitest/jsdom";
import { api } from "../services/api.js";
import { queryClient } from "../lib/query-client.js";
import { useAuthStore } from "../stores/authStore.js";
import { useCallStore } from "../stores/callStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { usePresenceStore } from "../stores/presenceStore.js";
import { registerNavigate } from "./navigation.js";
import { clearAccountScopedState } from "./session.js";
import { registerUnlockedSessionCleanup } from "./session-cleanup.js";
import { captureDisplayMedia, captureUserMedia } from "../services/webrtc.js";
import { ensureConversationInCache, fetchConversationList } from "../lib/conversation-cache.js";

// Use jsdom storage instead of Node's optional localStorage global.
vi.hoisted(() => {
  Object.defineProperty(globalThis, "localStorage", { value: jsdom.window.localStorage, configurable: true });
});
vi.mock("../lib/key-manager.js", () => ({ lockLocalCryptoState: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function seedAccountState() {
  const tracks = [{ kind: "audio", stop: vi.fn() }, { kind: "video", stop: vi.fn() }];
  queryClient.setQueryData(["conversations"], [{ id: "c1", name: "Alice's chat" }]);
  useChatStore.setState({
    conversations: [{ id: "c1" }] as never,
    activeConversationId: "c1",
    messages: new Map([["c1", [{ id: "m1", content: "plaintext preview" }]]]) as never,
    drafts: new Map([["c1", "unsent draft"]]),
    typingUsers: new Map([["c1", new Set(["u2"])]]),
    unreadCounts: new Map([["c1", 3]]),
    outgoingRemovalNotices: new Set(["c1"]),
  });
  usePresenceStore.setState({ onlineUsers: new Set(["u2"]) });
  useCallStore.setState({
    activeCallId: "call-1",
    callStatus: "active" as never,
    localStream: { getTracks: () => tracks } as unknown as MediaStream,
  });
  return tracks;
}

function accountStateSnapshot(tracks: { stop: ReturnType<typeof vi.fn> }[]) {
  const chat = useChatStore.getState();
  return {
    queries: queryClient.getQueryCache().getAll().length,
    conversations: chat.conversations.length,
    activeConversationId: chat.activeConversationId,
    messages: chat.messages.size,
    drafts: chat.drafts.size,
    typingUsers: chat.typingUsers.size,
    unreadCounts: chat.unreadCounts.size,
    outgoingRemovalNotices: chat.outgoingRemovalNotices.size,
    onlineUsers: usePresenceStore.getState().onlineUsers.size,
    activeCallId: useCallStore.getState().activeCallId,
    localStream: useCallStore.getState().localStream,
    stoppedTracks: tracks.filter((track) => track.stop.mock.calls.length === 1).length,
  };
}

const cleared = {
  queries: 0, conversations: 0, activeConversationId: null, messages: 0, drafts: 0, typingUsers: 0,
  unreadCounts: 0, outgoingRemovalNotices: 0, onlineUsers: 0, activeCallId: null, localStream: null, stoppedTracks: 2,
};

beforeEach(() => {
  fetchMock.mockReset();
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", {});
});

afterEach(() => {
  clearAccountScopedState();
  vi.unstubAllGlobals();
});

describe("clearAccountScopedState", () => {
  it("invalidates unlocked native work during account teardown", () => {
    const stop = vi.fn();
    const unregister = registerUnlockedSessionCleanup(stop);
    clearAccountScopedState();
    expect(stop).toHaveBeenCalledTimes(1);
    unregister();
  });
  it("clears cached account data and stops local call media", () => {
    const tracks = seedAccountState();
    clearAccountScopedState();
    expect(accountStateSnapshot(tracks)).toEqual(cleared);
  });

  it("keeps clearing when one cleanup step fails", () => {
    const tracks = seedAccountState();
    tracks[0].stop.mockImplementation(() => { throw new Error("device gone"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    clearAccountScopedState();
    expect(error).toHaveBeenCalled();
    expect(accountStateSnapshot(tracks)).toMatchObject({ queries: 0, conversations: 0, messages: 0 });
    error.mockRestore();
  });
});

describe("session expiry", () => {
  it.each([
    ["the refresh token is rejected", "old-refresh", 401],
    ["the refresh token is forbidden", "old-refresh", 403],
    ["there is no refresh token", null, 401],
  ])("clears account state and call media before navigating to login when %s", async (_label, refreshToken, status) => {
    useAuthStore.setState({ accessToken: "old-access", refreshToken, user: null, device: null, sessionId: null });
    fetchMock.mockImplementation(async (path) =>
      json({ error: "Expired" }, path === "/auth/refresh" ? status : 401));
    const tracks = seedAccountState();
    const atNavigation: unknown[] = [];
    const unregister = registerNavigate(((path: string) => {
      atNavigation.push({ path, accessToken: useAuthStore.getState().accessToken, ...accountStateSnapshot(tracks) });
    }) as never);

    await expect(api.get("/api/data")).rejects.toMatchObject({ status });
    unregister();

    expect(atNavigation).toEqual([{ path: "/login", accessToken: null, ...cleared }]);
  });

  it("leaves account state alone when the refresh succeeds", async () => {
    useAuthStore.setState({ accessToken: "old-access", refreshToken: "old-refresh", user: null, device: null, sessionId: null });
    fetchMock.mockImplementation(async (path, options) => {
      if (path === "/auth/refresh") return json({ accessToken: "new-access", refreshToken: "new-refresh" });
      return new Headers(options?.headers).get("Authorization") === "Bearer new-access"
        ? json({ ok: true })
        : json({ error: "Expired" }, 401);
    });
    const tracks = seedAccountState();
    await expect(api.get("/api/data")).resolves.toEqual({ ok: true });
    expect(accountStateSnapshot(tracks)).toMatchObject({ queries: 1, conversations: 1, activeCallId: "call-1", stoppedTracks: 0 });
  });
});

describe("late responses after the session ended", () => {
  const signedIn = { accessToken: "old-access", refreshToken: "old-refresh", user: { id: "u1" } as never, device: null, sessionId: "s1" };
  const conversation = { id: "c1", updatedAt: 1, members: [] };
  const chatAndQueries = () => ({
    queries: queryClient.getQueryCache().getAll().length,
    conversations: useChatStore.getState().conversations.length,
  });
  const pendingResponse = () => {
    let respond!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { respond = resolve; }));
    return (body: unknown) => respond(json(body));
  };

  it.each([
    ["the conversation list", () => fetchConversationList(), [conversation]],
    ["a single conversation", () => ensureConversationInCache("c1"), conversation],
  ])("drops %s that resolves after the session expired", async (_label, request, body) => {
    useAuthStore.setState(signedIn);
    const respond = pendingResponse();
    const pending = request();
    clearAccountScopedState();
    useAuthStore.getState().logout();
    respond(body);
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(chatAndQueries()).toEqual({ queries: 0, conversations: 0 });
  });

  it("drops the conversation list when another account signed in meanwhile", async () => {
    useAuthStore.setState(signedIn);
    const respond = pendingResponse();
    const pending = fetchConversationList();
    clearAccountScopedState();
    useAuthStore.setState({ ...signedIn, accessToken: "other-access", user: { id: "u2" } as never, sessionId: "s2" });
    respond([conversation]);
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(chatAndQueries()).toEqual({ queries: 0, conversations: 0 });
  });

  it("still caches the conversation list for an unchanged session, across a token rotation", async () => {
    useAuthStore.setState(signedIn);
    const respond = pendingResponse();
    const pending = fetchConversationList();
    useAuthStore.getState().setTokens("rotated-access", "rotated-refresh");
    respond([conversation]);
    await expect(pending).resolves.toHaveLength(1);
    expect(chatAndQueries()).toEqual({ queries: 2, conversations: 1 });
  });
});

describe("captured media", () => {
  const track = (kind: string) => ({ kind, readyState: "live", stop: vi.fn() });
  const stream = (...tracks: unknown[]) => ({ getTracks: () => tracks }) as unknown as MediaStream;

  it("stops a camera track held outside the local stream when the session expires", async () => {
    const [microphone, camera, screen] = [track("audio"), track("video"), track("video")];
    vi.stubGlobal("navigator", { mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue(stream(microphone, camera)),
      getDisplayMedia: vi.fn().mockResolvedValue(stream(screen)),
    } });
    await captureUserMedia({ audio: true, video: true });
    await captureDisplayMedia({ video: true });
    // Screen sharing: the local stream carries the microphone and the screen; the camera is parked.
    useCallStore.setState({ activeCallId: "call-1", localStream: stream(microphone, screen) });

    useAuthStore.setState({ accessToken: "old-access", refreshToken: null, user: null, device: null, sessionId: null });
    fetchMock.mockImplementation(async () => json({ error: "Expired" }, 401));
    const cameraStopsAtNavigation: number[] = [];
    const unregister = registerNavigate((() => { cameraStopsAtNavigation.push(camera.stop.mock.calls.length); }) as never);
    await expect(api.get("/api/data")).rejects.toMatchObject({ status: 401 });
    unregister();

    expect(cameraStopsAtNavigation).toEqual([1]);
    expect(microphone.stop).toHaveBeenCalled();
    expect(screen.stop).toHaveBeenCalled();
    // The registry is emptied: a later cleanup does not touch the old tracks again.
    clearAccountScopedState();
    expect(camera.stop).toHaveBeenCalledTimes(1);
  });
});
