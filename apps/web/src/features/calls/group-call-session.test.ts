// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GroupCallPeer, GroupCallRoom } from "@e2ee-chat/shared";
import { encryptGroupCallControl } from "../../lib/message-processor.js";
import { GroupCallSession, type GroupCallSessionView } from "./group-call-session.js";

const mocks = vi.hoisted(() => ({ post: vi.fn(async () => ({})), get: vi.fn(async () => ({ groupEpoch: 0 })),
  turn: vi.fn(async (_signal?: AbortSignal): Promise<{ iceServers: RTCIceServer[] }> => ({ iceServers: [] })),
  peers: [] as Array<{ close: ReturnType<typeof vi.fn>; setEpoch: ReturnType<typeof vi.fn>; setKeys: ReturnType<typeof vi.fn>;
    config: RTCConfiguration; currentIceConfig: () => Promise<RTCConfiguration> }> }));
vi.mock("../../services/api.js", () => ({
  api: { get: mocks.get, post: mocks.post }, resolveWsBaseUrl: () => "wss://local.invalid", ApiError: class extends Error {},
}));
vi.mock("../../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ accessToken: "token" }) } }));
vi.mock("../../services/webrtc.js", () => ({ fetchTurnCredentials: mocks.turn }));
vi.mock("../../lib/message-processor.js", () => ({ encryptGroupCallControl: vi.fn(async () => ({ ciphertext: "x", iv: "y", header: "z" })) }));
vi.mock("../../lib/message-sync.js", () => ({ syncMessages: vi.fn(async () => undefined) }));
vi.mock("../../db/index.js", () => ({ getReceiveReceipt: vi.fn(async () => undefined) }));
vi.mock("../../lib/key-manager.js", () => ({ KeysLockedError: class extends Error {} }));
vi.mock("../../platform/media.js", () => ({
  captureUserMedia: async () => { throw Error("permission"); },
  captureCallCamera: vi.fn(), captureDisplayMedia: vi.fn(), listCallCameras: async () => [],
  watchCallCameras: () => () => {},
}));
vi.mock("./group-mesh-peer.js", () => ({
  GroupMeshPeer: class {
    stream = new MediaStream();
    screen = new MediaStream();
    connection = "connecting";
    secureMedia = false;
    setEpoch = vi.fn();
    setKeys = vi.fn();
    setVideoBudget = vi.fn();
    setReceivingVideo = vi.fn();
    replaceTracks = vi.fn();
    ensureOffer = vi.fn();
    receive = vi.fn();
    close = vi.fn();
    recover = () => true;
    quality = async () => "ok";
    constructor(readonly config: RTCConfiguration, _video: boolean, _offerer: boolean, _send: unknown, _changed: unknown,
      readonly currentIceConfig: () => Promise<RTCConfiguration>) { mocks.peers.push(this); }
  },
}));

class TestMediaStream {
  getTracks() { return []; }
  getAudioTracks() { return []; }
}
class TestSocket {
  static OPEN = 1;
  readyState = 1;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  send = vi.fn((_data: string) => undefined);
  close = vi.fn();
  constructor() { sockets.push(this); }
  receive(frame: object) { this.onmessage?.({ data: JSON.stringify({ ...frame, version: 2 }) }); }
}
let sockets: TestSocket[];
let session: GroupCallSession | undefined;
const peer = (userId: string): GroupCallPeer => ({ userId, deviceId: userId + "-device", sessionId: userId + "-session" });
const alice = peer("alice"), bob = peer("bob"), carol = peer("carol");
const room: GroupCallRoom = { id: "room", conversationId: "group", type: "audio", initiatorId: "alice",
  startedAt: 1, endedAt: null, epoch: 2, aloneUntil: null, participants: [{ ...alice, joinedAt: 1 }, { ...bob, joinedAt: 2 }] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(10_000);
  vi.clearAllMocks();
  mocks.peers.length = 0;
  mocks.turn.mockReset().mockResolvedValue({ iceServers: [] });
  sockets = [];
  vi.stubGlobal("MediaStream", TestMediaStream);
  vi.stubGlobal("WebSocket", TestSocket);
});
afterEach(() => {
  session?.stop();
  session = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("changes keys on join and removal and stops publishing to departed peers", async () => {
  const views: GroupCallSessionView[] = [];
  const event = vi.fn();
  session = new GroupCallSession(room, alice, false, { change: (view) => views.push(view), exit: vi.fn(), event, metric: vi.fn() });
  const socket = sockets[0];
  socket.receive({ type: "group-roster", room });
  socket.receive({ type: "group-resume-ack", epoch: 2, cursor: 0 });
  await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  expect(views.at(-1)?.tiles.map((tile) => tile.userId)).toEqual(["bob"]);
  expect(views.at(-1)?.mediaError).toBe("microphone");
  const viewKeys = () => vi.mocked(encryptGroupCallControl).mock.calls.map(([payload, user]) => ({ ...JSON.parse(payload), user }));
  const firstKey = viewKeys()[0].key;

  const joined = { ...room, epoch: 3, participants: [...room.participants, { ...carol, joinedAt: 3 }] };
  socket.receive({ type: "group-roster", room: joined });
  await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(3));
  expect(mocks.peers[0].setEpoch).toHaveBeenLastCalledWith(3);
  expect(views.at(-1)?.tiles.map((tile) => tile.userId)).toEqual(["bob", "carol"]);
  const keys = viewKeys().filter(({ epoch }) => epoch === 3);
  expect(keys.map(({ user }) => user).sort()).toEqual(["bob", "carol"]);
  expect(keys[0].key).toBe(keys[1].key);
  expect(keys[0].key).not.toBe(firstKey);

  const removed = { ...joined, epoch: 4, participants: joined.participants.filter(({ userId }) => userId !== "bob") };
  socket.receive({ type: "group-roster", room: removed, departed: [{ userId: "bob", reason: "removed" }] });
  await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(4));
  expect(mocks.peers[0].close).toHaveBeenCalledOnce();
  expect(views.at(-1)?.tiles.map((tile) => tile.userId)).toEqual(["carol"]);
  expect(viewKeys().filter(({ epoch }) => epoch === 4).map(({ user }) => user)).toEqual(["carol"]);
  expect(event).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "removed", userId: "bob" }));
});


it("gives a healthy peer its sender key even while another grant is stalled", async () => {
  const joined = { ...room, participants: [...room.participants, { ...carol, joinedAt: 3 }] };
  let unblock!: () => void;
  vi.mocked(encryptGroupCallControl).mockImplementation(async (payload, user) => {
    if (user === "alice") await new Promise<void>((resolve) => { unblock = resolve; });
    return { ciphertext: payload, iv: "test", header: "{}" };
  });
  session = new GroupCallSession(joined, carol, false, { change: vi.fn(), exit: vi.fn(), event: vi.fn(), metric: vi.fn() });
  sockets[0].receive({ type: "group-roster", room: joined });
  sockets[0].receive({ type: "group-resume-ack", epoch: 2, cursor: 0 });
  await vi.waitFor(() => expect(mocks.peers[1].setKeys).toHaveBeenLastCalledWith(expect.objectContaining({ epoch: 2 }), null));
  expect(mocks.peers[0].setKeys).toHaveBeenLastCalledWith(null, null);
  expect(mocks.post).toHaveBeenCalledTimes(1);
  unblock();
  await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
});

it("closes live RTP on signaling loss and waits for a fresh roster and matching acknowledgment before rebuilding", async () => {
  vi.mocked(encryptGroupCallControl).mockResolvedValue({ ciphertext: "x", iv: "y", header: "z" });
  const joined = { ...room, participants: [...room.participants, { ...carol, joinedAt: 3 }] };
  session = new GroupCallSession(joined, alice, false, { change: vi.fn(), exit: vi.fn(), event: vi.fn(), metric: vi.fn() });
  sockets[0].receive({ type: "group-roster", room: joined });
  sockets[0].receive({ type: "group-resume-ack", epoch: 2, cursor: 0 });
  await vi.waitFor(() => expect(mocks.peers[0].setKeys).toHaveBeenLastCalledWith(expect.objectContaining({ epoch: 2 }), null));
  const original = [...mocks.peers];
  sockets[0].onclose?.({ code: 1006, reason: "" });
  for (const connection of original) expect(connection.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(500);
  const resumed = sockets[1];
  resumed.receive({ type: "group-resume-ack", epoch: 2, cursor: 0 });
  expect(mocks.peers).toHaveLength(2);
  const removed = { ...joined, epoch: 3, participants: joined.participants.filter(({ userId }) => userId !== bob.userId) };
  resumed.receive({ type: "group-roster", room: removed, departed: [{ userId: bob.userId, reason: "removed" }] });
  resumed.receive({ type: "group-resume-ack", epoch: 2, cursor: 0 });
  expect(mocks.peers).toHaveLength(2);
  resumed.receive({ type: "group-resume-ack", epoch: 3, cursor: 0 });
  await vi.waitFor(() => expect(mocks.peers[2].setKeys).toHaveBeenLastCalledWith(expect.objectContaining({ epoch: 3 }), null));
  expect(mocks.peers).toHaveLength(3);
  const reset = resumed.send.mock.calls.map(([value]) => JSON.parse(value)).find(({ body }) => body?.reset);
  expect(reset).toMatchObject({ epoch: 3, to: carol, body: { kind: "restart", reset: true } });
});

it("expires the sender slot and closes the transport if signaling goes silent without a close event", async () => {
  vi.mocked(encryptGroupCallControl).mockResolvedValue({ ciphertext: "x", iv: "y", header: "z" });
  session = new GroupCallSession(room, alice, false, { change: vi.fn(), exit: vi.fn(), event: vi.fn(), metric: vi.fn() });
  const socket = sockets[0];
  socket.receive({ type: "group-roster", room });
  socket.receive({ type: "group-resume-ack", epoch: 2, cursor: 0 });
  await vi.waitFor(() => expect(mocks.peers[0].setKeys).toHaveBeenLastCalledWith(expect.objectContaining({ epoch: 2, validUntil: 30_000 }), null));
  await vi.advanceTimersByTimeAsync(10_000);
  socket.receive({ type: "group-heartbeat-ack", epoch: 2 });
  expect(mocks.peers[0].setKeys).toHaveBeenLastCalledWith(expect.objectContaining({ validUntil: Date.now() + 20_000 }), null);
  await vi.advanceTimersByTimeAsync(21_000);
  expect(mocks.peers[0].close).toHaveBeenCalledOnce();
  expect(socket.close).toHaveBeenCalledOnce();
});

it("refreshes TURN once before creating late-join transports after credential expiry", async () => {
  const original: RTCIceServer[] = [{ urls: "turn:relay.invalid", username: "original", credential: "test" }];
  const refreshed: RTCIceServer[] = [{ urls: "turn:relay.invalid", username: "renewed", credential: "test" }];
  mocks.turn.mockResolvedValueOnce({ iceServers: original });
  vi.mocked(encryptGroupCallControl).mockResolvedValue({ ciphertext: "x", iv: "y", header: "z" });
  session = new GroupCallSession(room, alice, false, { change: vi.fn(), exit: vi.fn(), event: vi.fn(), metric: vi.fn() });
  const socket = sockets[0];
  socket.receive({ type: "group-roster", room });
  socket.receive({ type: "group-resume-ack", epoch: 2, cursor: 0 });
  await vi.waitFor(() => expect(mocks.peers).toHaveLength(1));
  expect(mocks.peers[0].config.iceServers).toEqual(original);
  expect(mocks.turn).toHaveBeenCalledOnce();

  vi.setSystemTime(Date.now() + 60 * 60_000);
  let renew!: (value: { iceServers: RTCIceServer[] }) => void;
  mocks.turn.mockImplementationOnce(() => new Promise((resolve) => { renew = resolve; }));
  const joined: GroupCallRoom = { ...room, epoch: 3, participants: [...room.participants, { ...carol, joinedAt: 3 },
    { ...peer("dana"), joinedAt: 4 }] };
  socket.receive({ type: "group-roster", room: joined });
  expect(mocks.turn).toHaveBeenCalledTimes(2);
  expect(mocks.peers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.turn).toHaveBeenCalledTimes(2);
  expect(mocks.peers).toHaveLength(1);
  renew({ iceServers: refreshed });
  await vi.waitFor(() => expect(mocks.peers).toHaveLength(3));
  expect(mocks.peers.slice(1).map(({ config }) => config.iceServers)).toEqual([refreshed, refreshed]);
});

it("releases a stalled TURN request and retries within the peer recovery deadline", async () => {
  let resolveStalled!: (value: { iceServers: RTCIceServer[] }) => void;
  const renewed = [{ urls: "turn:renewed.invalid" }];
  mocks.turn.mockImplementationOnce(() => new Promise((resolve) => { resolveStalled = resolve; }))
    .mockResolvedValueOnce({ iceServers: renewed });
  session = new GroupCallSession(room, alice, false, { change: vi.fn(), exit: vi.fn(), event: vi.fn(), metric: vi.fn() });
  sockets[0].receive({ type: "group-roster", room });
  sockets[0].receive({ type: "group-resume-ack", epoch: 2, cursor: 0 });
  const firstSignal = mocks.turn.mock.calls[0][0]!;
  await vi.advanceTimersByTimeAsync(4999);
  expect(firstSignal.aborted).toBe(false);
  expect(mocks.peers).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(firstSignal.aborted).toBe(true);
  expect(mocks.peers[0].config.iceServers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);

  await vi.advanceTimersByTimeAsync(3000);
  const joined = { ...room, epoch: 3, participants: [...room.participants, { ...carol, joinedAt: 3 }] };
  sockets[0].receive({ type: "group-roster", room: joined });
  expect(mocks.turn).toHaveBeenCalledTimes(2);
  const retry = mocks.peers[0].currentIceConfig;
  const [first, second] = await Promise.all([retry(), retry()]);
  expect(mocks.turn).toHaveBeenCalledTimes(2);
  expect(first.iceServers).toEqual(renewed);
  expect(second).toBe(first);
  await vi.waitFor(() => expect(mocks.peers[1]?.config).toBe(first));
  resolveStalled({ iceServers: [{ urls: "turn:stale.invalid" }] });
  expect(await retry()).toBe(first);
});

it("uses still-valid TURN on renewal failure and strips expired TURN from STUN fallback", async () => {
  const original = [{ urls: ["turn:relay.invalid", "stun:stun.invalid", "turns:relay.invalid"], username: "original", credential: "test" }];
  const issuedAt = Date.now();
  mocks.turn.mockResolvedValueOnce({ iceServers: original }).mockRejectedValue(Error("TURN unavailable"));
  session = new GroupCallSession(room, alice, false, { change: vi.fn(), exit: vi.fn(), event: vi.fn(), metric: vi.fn() });
  sockets[0].receive({ type: "group-roster", room });
  sockets[0].receive({ type: "group-resume-ack", epoch: 2, cursor: 0 });
  await vi.waitFor(() => expect(mocks.peers).toHaveLength(1));
  const renew = mocks.peers[0].currentIceConfig;
  vi.setSystemTime(issuedAt + 59 * 60_000);
  expect((await renew()).iceServers).toEqual(original);
  expect(mocks.turn).toHaveBeenCalledTimes(2);
  vi.setSystemTime(issuedAt + 60 * 60_000 - 2000);
  expect((await renew()).iceServers).toEqual(original);
  vi.setSystemTime(issuedAt + 60 * 60_000);
  expect((await renew()).iceServers).toEqual([{ urls: ["stun:stun.invalid"] }]);
  expect(mocks.turn).toHaveBeenCalledTimes(3);
});
