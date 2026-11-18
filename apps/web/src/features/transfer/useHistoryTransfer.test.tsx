import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { setupDom } from "../../ui/test-utils.js";
import { api } from "../../services/api.js";
import { holdIdleLock, keysLoaded } from "../../lib/key-manager.js";
import { refreshConversationList } from "../../lib/conversation-cache.js";
import { createTransferPairing, encodeTransferWords } from "./pairing.js";
import { HISTORY_TRANSFER_VERSION, type ConversationWithMembers, type HistoryTransferCheckpoint } from "@e2ee-chat/shared";
import { getAppDB, historyRemovalKey } from "../../db/index.js";
import { claimHistoryTransferLease, loadHistoryTransferCheckpoint, releaseHistoryTransferLease, saveHistoryTransferCheckpoint } from "../../db/history-transfer-progress.js";
import { clearUnlockedSessionState } from "../../platform/session-cleanup.js";
import { TRANSFER_PROGRESS_TIMEOUT_MS, useHistoryTransfer } from "./useHistoryTransfer.js";
import { publishLocalMessageChange } from "../../lib/local-message-changes.js";
import { verifyHistoryDisclosure } from "../../lib/message-sync.js";
import { HistoryTransferStream } from "./stream.js";
import { estimateHistoryStorage } from "../../db/history-transfer.js";

vi.mock("../../lib/key-manager.js", () => ({
  keysLoaded: vi.fn(() => true), getUnlockGeneration: () => 1, lockLocalCryptoState: vi.fn(), holdIdleLock: vi.fn(() => () => {}),
  openCachedAttachment: async (_owner: string, _id: string, sealed: { ciphertext: Blob }) => sealed.ciphertext.slice(0, -16),
}));
vi.mock("../../services/webrtc.js", () => ({ fetchTurnCredentials: async () => ({ iceServers: [] }) }));
vi.mock("../../services/api.js", () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() }, resolveWsBaseUrl: () => "wss://transfer.test",
}));
vi.mock("../../lib/conversation-cache.js", () => ({ refreshConversationList: vi.fn() }));
vi.mock("../../lib/message-sync.js", () => ({ reconcileImportedHistoryDeletions: vi.fn(), reconcileLocalMessageChange: vi.fn(), verifyHistoryDisclosure: vi.fn(async () => {}) }));

const dom = setupDom();
let result: ReturnType<typeof useHistoryTransfer>;
let sockets: Socket[];
let expiresAt: number;
let pairingId: string;

class Socket {
  static OPEN = 1;
  readyState = Socket.OPEN;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  send = vi.fn<(message: string) => void>();
  close = vi.fn();
  constructor(readonly url: string, readonly protocols: string[]) { sockets.push(this); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

function Probe() { result = useHistoryTransfer(); return null; }

beforeEach(async () => {
  const db = await getAppDB();
  await Promise.all(["accountState", "displayMessages", "legacyMessages", "accountFiles"].map((store) => db.clear(store)));
  useChatStore.getState().setConversations([]);
  sockets = [];
  pairingId = crypto.randomUUID();
  expiresAt = Date.now() + 60_000;
  vi.mocked(keysLoaded).mockReturnValue(true);
  vi.mocked(api.post).mockResolvedValue({ expiresAt });
  vi.mocked(api.delete).mockResolvedValue(undefined);
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("RTCPeerConnection", class {
    localDescription = { sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
    createDataChannel() { return { readyState: "open", close() {} }; }
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    close() {}
  });
  const now = Date.now();
  useAuthStore.setState({
    user: { id: "user", username: "user", displayName: "User", avatarUrl: null, createdAt: now, updatedAt: now },
    device: { id: "new-device", userId: "user", status: "active", linkMethod: "register", identityKey: "public",
      deviceName: "New device", createdAt: now, lastSeenAt: now, activatedAt: now, revokedAt: null },
    accessToken: "jwt", sessionId: "login",
  });
});
afterEach(async () => {
  await act(async () => { result.stop(); });
  vi.restoreAllMocks();
});

it("rejects comparison on both devices and starts again with a new invitation", async () => {
  await dom.render(<Probe />);
  await act(async () => { await result.startAsReceiver(); });
  expect(result.invitation).toMatchObject({ qr: { receiverDeviceId: "new-device" }, expiresAt });
  const invitation = result.invitation!;
  const original = sockets[0];
  expect(original.protocols).toEqual(["token.jwt"]);
  expect(original.url).not.toContain(invitation.qr.secret);
  expect(original.url).toMatch(/\?role=receiver$/);
  await act(async () => {
    original.receive({ type: "room", expiresAt });
    original.onclose?.({ code: 1006 });
  });
  expect(result.phase).toBe("paused");
  await act(async () => { await result.resume(); });
  const resumed = sockets[1];
  expect(resumed.url).toBe(original.url);
  await act(async () => {
    resumed.receive({ type: "room", expiresAt });
    resumed.receive({ type: "peer", attempt: crypto.randomUUID(), pairingId: crypto.randomUUID(), deviceId: "old-device", deviceName: "Old phone" });
    await waitForHello(resumed);
  });
  expect(result).toMatchObject({ phase: "pairing", peerDeviceId: "old-device", localConfirmed: false });
  expect(result.checkCode).toBeUndefined();
  vi.spyOn(HistoryTransferStream.prototype, "checkCode", "get").mockReturnValue("123456");
  await act(async () => { result.rejectComparison(); });
  expect(result).toMatchObject({ phase: "error", error: "check-code-mismatch" });
  expect(result.invitation).toBeUndefined();
  expect(resumed.send).toHaveBeenLastCalledWith('{"type":"reject"}');
  expect(resumed.close).toHaveBeenCalled();
  await act(async () => { await result.startAsReceiver(); });
  expect(result.invitation?.qr.secret).not.toBe(invitation.qr.secret);
  const sender = await setupSender();
  await act(async () => { sender.receive({ type: "reject" }); });
  expect(result).toMatchObject({ phase: "error", error: "check-code-mismatch" });
});

it("requires an unlocked device before opening signaling", async () => {
  vi.mocked(keysLoaded).mockReturnValue(false);
  await dom.render(<Probe />);
  await act(async () => { await expect(result.startAsReceiver()).rejects.toThrow(); });
  expect(result.error).toBe("device-locked");
  expect(sockets).toHaveLength(0);
});

async function setupSender(type: ConversationWithMembers["type"] = "direct", input: Parameters<typeof result.startAsSender>[0] = createTransferPairing("peer-device")) {
  const now = Date.now();
  const conversation: ConversationWithMembers = {
    id: "chat", name: "Chat", type, avatarUrl: null, invitePolicy: "any_member", createdBy: "user",
    createdAt: now, updatedAt: now, members: [{ conversationId: "chat", userId: "user", role: "admin",
      joinedAt: now, acceptedAt: now, user: { username: "user", displayName: "User", avatarUrl: null } }],
  };
  vi.mocked(refreshConversationList).mockResolvedValue([conversation]);
  vi.spyOn(HistoryTransferStream.prototype, "ready", "get").mockReturnValue(true);
  await dom.render(<Probe />);
  await act(async () => { await result.startAsSender(input); });
  const socket = sockets.at(-1)!;
  await act(async () => {
    announcePeer(socket);
    await waitForHello(socket);
  });
  return socket;
}

function announcePeer(socket: Socket): void {
  socket.receive({ type: "peer", attempt: crypto.randomUUID(), pairingId, deviceId: "peer-device", deviceName: "Peer" });
}

async function waitForHello(socket: Socket) {
  await vi.waitFor(() => expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"hello"')), { interval: 5 });
}

it.each([[HISTORY_TRANSFER_VERSION - 1, "version"], [HISTORY_TRANSFER_VERSION + 1, "version-local"]] as const)("rejects a v%s invitation before joining a room (%s)", async (v, error) => {
  await dom.render(<Probe />);
  vi.mocked(api.get).mockClear();
  const qr = { ...createTransferPairing("peer-device"), v };
  await act(async () => { await expect(result.startAsSender(JSON.stringify(qr))).rejects.toThrow("Unsupported transfer version"); });
  expect(result).toMatchObject({ phase: "error", error });
  expect(api.get).not.toHaveBeenCalledWith(expect.stringMatching(/history-transfer/));
  expect(sockets).toHaveLength(0);
});

it.each([ ["sender", undefined, "version"], ["receiver", HISTORY_TRANSFER_VERSION - 1, "version"],
  ["receiver", HISTORY_TRANSFER_VERSION + 1, "version-local"] ] as const)("rejects an incompatible hello on the %s (v%s) before attaching a stream", async (role, v, error) => {
  const attach = vi.spyOn(HistoryTransferStream.prototype, "attach");
  let socket: Socket;
  if (role === "sender") socket = await setupSender("direct", encodeTransferWords(createTransferPairing("peer-device").secret));
  else {
    await dom.render(<Probe />);
    await act(async () => { await result.startAsReceiver(); });
    socket = sockets.at(-1)!;
    await act(async () => { announcePeer(socket); await waitForHello(socket); });
  }
  const hello = socket.send.mock.calls.map(([frame]) => JSON.parse(frame)).find(({ type }) => type === "hello");
  expect(hello.v).toBe(HISTORY_TRANSFER_VERSION);
  await act(async () => {
    socket.receive({ type: "hello", attempt: hello.attempt, publicKey: hello.publicKey, v });
    await vi.waitFor(() => expect(result.phase).toBe("error"));
  });
  expect(result).toMatchObject({ error, peerDeviceName: "Peer" });
  expect(result.checkCode).toBeUndefined();
  expect(attach).not.toHaveBeenCalled();
  expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "version-mismatch", v: HISTORY_TRANSFER_VERSION }));
});

it("shows the peer name when a version rejection arrives during pairing setup", async () => {
  await dom.render(<Probe />);
  await act(async () => { await result.startAsReceiver(); });
  const socket = sockets.at(-1)!;
  await act(async () => {
    announcePeer(socket);
    socket.receive({ type: "version-mismatch", v: HISTORY_TRANSFER_VERSION + 1 });
    socket.onclose?.({ code: 4411 });
    await vi.waitFor(() => expect(result.phase).toBe("error"));
  });
  expect(result).toMatchObject({ error: "version-local", peerDeviceName: "Peer" });
});

const completedCheckpoint: HistoryTransferCheckpoint = {
  chats: [{ id: "chat", messages: 5, bytes: 200, attachmentBytes: 0 }],
  completedChatIds: ["chat"], bytes: 200, copyDownloadedFiles: true,
};

it("closes a competing room before sending pairing material and preserves the other tab's checkpoint", async () => {
  const scope = { userId: "user", deviceId: "new-device", role: "sender" } as const;
  const lease = (await claimHistoryTransferLease(scope, "peer-device"))!;
  try {
    await saveHistoryTransferCheckpoint(scope, "peer-device", completedCheckpoint, () => true, undefined, lease);
    await dom.render(<Probe />);
    await act(async () => { await result.startAsSender(createTransferPairing("peer-device")); });
    const socket = sockets.at(-1)!;
    await act(async () => {
      socket.receive({ type: "peer", attempt: crypto.randomUUID(), pairingId: crypto.randomUUID(), deviceId: "peer-device", deviceName: "Peer" });
      await vi.waitFor(() => expect(socket.close).toHaveBeenCalledOnce(), { interval: 5 });
    });
    expect(result).toMatchObject({ phase: "error", error: "busy" });
    expect(socket.send.mock.calls).toEqual([['{"type":"cancel"}']]);
    expect(await loadHistoryTransferCheckpoint(scope, "peer-device")).toEqual(completedCheckpoint);
  } finally {
    await releaseHistoryTransferLease(lease);
    await (await getAppDB()).clear("accountState");
  }
});

it("sends an interruption for a confirmed stream failure and retains its checkpoint", async () => {
  const scope = { userId: "user", deviceId: "new-device", role: "sender" } as const;
  const socket = await setupSender();
  const prepare = vi.spyOn(HistoryTransferStream.prototype, "prepare");
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  await act(async () => { await result.prepare(); });
  await act(async () => { await result.send(); });
  const stream = prepare.mock.contexts[0] as HistoryTransferStream;
  await act(async () => { stream["onError"](new Error("Attachment failed to open")); });
  expect(socket.send).toHaveBeenLastCalledWith('{"type":"abort"}');
  expect(socket.send).not.toHaveBeenCalledWith('{"type":"reject"}');
  expect(result).toMatchObject({ phase: "error", error: "transfer-interrupted" });
  expect(await loadHistoryTransferCheckpoint(scope, "peer-device")).toBeDefined();
});

it("treats a receiver's null checkpoint as no completed chats even if the local sender remembers completion", async () => {
  await saveHistoryTransferCheckpoint({ userId: "user", deviceId: "new-device", role: "sender" },
    "peer-device", completedCheckpoint, () => true);
  await setupSender();
  const prepare = vi.spyOn(HistoryTransferStream.prototype, "prepare");
  await act(async () => { await result.prepare(); });
  const stream = prepare.mock.contexts.at(-1) as HistoryTransferStream;
  await act(async () => { await stream["checkpoint"]!.received(null); });
  expect(result).toMatchObject({ canFinalize: false, checkpoint: { chats: completedCheckpoint.chats, completedChatIds: [], bytes: 0 } });
  await act(async () => { expect((await result.prepare()).chats.map(({ id }) => id)).toEqual(["chat"]); });
  expect(result.canSend).toBe(true);
});

it("offers finalization when the receiver has already committed every selected chat", async () => {
  await setupSender();
  const prepare = vi.spyOn(HistoryTransferStream.prototype, "prepare");
  const send = vi.spyOn(HistoryTransferStream.prototype, "send");
  await act(async () => { await result.prepare(); });
  const stream = prepare.mock.contexts.at(-1) as HistoryTransferStream;
  await act(async () => { await stream["checkpoint"]!.received(completedCheckpoint); });
  await act(async () => { expect((await result.prepare()).chats).toEqual([]); });
  expect(result).toMatchObject({ canFinalize: true, canSend: true });
  await act(async () => { await result.send(); });
  expect(send).toHaveBeenCalledWith(true, expect.any(Function));
  expect(stream.started).toBe(true);
});

it("reconciles the same receipt when another chat is selected after a lost final acknowledgment", async () => {
  const sender = { userId: "user", deviceId: "new-device", role: "sender", peerDeviceId: "peer-device" } as const;
  const receiver = { ...sender, role: "receiver" } as const;
  const earlier = { ...completedCheckpoint, resumeId: crypto.randomUUID(), completedChatIds: ["already-copied"], chats: [{ ...completedCheckpoint.chats[0], id: "already-copied",
    additions: { messages: 4, attachmentBytes: 0, attachmentFiles: 0 } }] };
  await saveHistoryTransferCheckpoint(sender, sender.peerDeviceId, earlier, () => true);
  const confirmation = { ...earlier, confirmationOnly: true } as const;
  await saveHistoryTransferCheckpoint(receiver, receiver.peerDeviceId, confirmation, () => true);
  const paused = vi.spyOn(HistoryTransferStream.prototype, "setSendingPaused");
  await dom.render(<Probe />);
  await act(async () => {
    await result.startAsReceiver();
    announcePeer(sockets.at(-1)!);
    await waitForHello(sockets.at(-1)!);
  });
  const inbound = paused.mock.contexts.at(-1) as HistoryTransferStream;
  let receipt: HistoryTransferCheckpoint | undefined;
  await act(async () => {
    await inbound["checkpoint"]!.manifest({ v: HISTORY_TRANSFER_VERSION, bytes: 200, copyDownloadedFiles: false, resumeId: earlier.resumeId,
      chats: [{ ...completedCheckpoint.chats[0], name: "Additional chat" }] });
    await inbound["checkpoint"]!.chatComplete("chat", 200);
    receipt = await inbound["checkpoint"]!.receipt!() || undefined;
    result.stop();
  });
  const db = await getAppDB();
  await vi.waitFor(async () => expect(await db.get("accountState", 'history-transfer-active:["user","new-device","peer-device"]')).toBeUndefined());
  expect(receipt!).toMatchObject({ completedChatIds: ["already-copied", "chat"], chats: [{ id: "already-copied", additions: { messages: 4 } }, { id: "chat" }] });
  await setupSender();
  const prepare = vi.spyOn(HistoryTransferStream.prototype, "prepare");
  await act(async () => { await result.prepare(); });
  const outbound = prepare.mock.contexts.at(-1) as HistoryTransferStream;
  await act(async () => {
    await outbound["checkpoint"]!.received(confirmation);
    await result.prepare([{ conversationId: "chat" }]);
    await result.send();
  });
  expect(() => outbound["checkpoint"]!.receivedReceipt!(receipt!)).not.toThrow();
});

it("reports unverifiable legacy history and blocks metadata-only send until the device can verify a row", async () => {
  await setupSender();
  const db = await getAppDB();
  const time = Date.now();
  await db.put("legacyMessages", { id: "legacy-msg", conversationId: "chat", senderId: "peer", type: "text",
    status: "delivered", content: "legacy private text", timestamp: time, expiresAt: time + 60_000 });
  try {
    vi.mocked(api.post).mockResolvedValueOnce({ ids: [] }).mockResolvedValueOnce({ ids: ["legacy-msg"] });
    await act(async () => {
      expect((await result.prepare()).chats[0]).toMatchObject({ messages: 0, skippedLegacyMessages: 1 });
    });
    expect(result.canSend).toBe(false);
    await expect(result.send()).rejects.toThrow("not ready");
    expect(api.post).toHaveBeenCalledWith("/api/messages/history-ownership", { messages: [{
      id: "legacy-msg", conversationId: "chat", senderId: "peer", type: "text", timestamp: time, deletedAt: null,
    }] });
    await act(async () => {
      expect((await result.prepare()).chats[0]).toMatchObject({ messages: 1 });
    });
    expect(result.canSend).toBe(true);
  } finally {
    await db.delete("displayMessages", ["user", "legacy-msg"]);
  }
});

it("clears a terminal manifest and peer name on an in-place account switch", async () => {
  await setupSender();
  await act(async () => { await result.prepare(); result.stop(); });
  expect(result).toMatchObject({ phase: "cancelled", peerDeviceName: "Peer", manifest: { chats: [{ name: "Chat" }] } });
  await act(async () => { useAuthStore.setState({ sessionId: "another-login", user: null }); });
  expect(result).toMatchObject({ phase: "idle" });
  expect(result.manifest).toBeUndefined();
  expect(result.peerDeviceName).toBeUndefined();
});

it("refreshes the client deadline on a lease update without reverting to the invitation state", async () => {
  const socket = await setupSender();
  const extended = Date.now() + 600_000;
  await act(async () => { socket.receive({ type: "lease", expiresAt: extended }); });
  expect(result).toMatchObject({ phase: "pairing", expiresAt: extended, peerDeviceId: "peer-device" });
});

it("invalidates a previously prepared archive when the latest lookup fails", async () => {
  await setupSender();
  await act(async () => { expect((await result.prepare()).chats).toHaveLength(1); });
  vi.mocked(refreshConversationList).mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await expect(result.prepare([{ conversationId: "different-selection" }])).rejects.toThrow("offline"); });
  expect(result.manifest).toBeUndefined();
  expect(result.error).toBe("export");
  await act(async () => { await expect(result.send()).rejects.toThrow("not ready"); });
});

it("keeps a background transfer across unmount and releases transport and idle hold on completion", async () => {
  const releaseIdle = vi.fn();
  vi.mocked(holdIdleLock).mockReturnValueOnce(releaseIdle);
  const socket = await setupSender();
  const prepare = vi.spyOn(HistoryTransferStream.prototype, "prepare");
  const dispose = vi.spyOn(HistoryTransferStream.prototype, "dispose");
  await act(async () => { await result.prepare(); });
  const stream = prepare.mock.contexts.at(-1) as HistoryTransferStream;
  await act(async () => { await result.send(); expect(result.continueInBackground()).toBe(true); });
  await dom.render(null);
  expect(socket.close).not.toHaveBeenCalled();
  expect(releaseIdle).not.toHaveBeenCalled();
  await dom.render(<Probe />);
  expect(result).toMatchObject({ phase: "transferring", background: true });
  vi.spyOn(HistoryTransferStream.prototype, "checkCode", "get").mockReturnValue("123456");
  await act(async () => { stream.complete = true; stream.confirm(); });
  expect(result).toMatchObject({ phase: "complete", summary: { chats: 0, messages: 0 } });
  expect(result.manifest).toBeUndefined();
  expect(dispose).toHaveBeenCalledOnce();
  expect(socket.close).toHaveBeenCalledOnce();
  expect(releaseIdle).toHaveBeenCalledOnce();
});

it("releases idle-lock hold at the end of reconnect grace and drops the run on lock", async () => {
  const releaseIdle = vi.fn();
  vi.mocked(holdIdleLock).mockReturnValueOnce(releaseIdle);
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  const socket = await setupSender();
  await act(async () => { await result.prepare(); await result.send(); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => { socket.onclose?.({ code: 1006 }); });
  expect(result.phase).toBe("reconnecting");
  expect(releaseIdle).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(result.phase).toBe("paused");
  expect(releaseIdle).toHaveBeenCalledOnce();
  await act(async () => { clearUnlockedSessionState(); });
  expect(result).toMatchObject({ phase: "paused", requiresPairing: true, manifest: undefined });
  expect((await result.listInterrupted("sender")).some(({ peerDeviceId }) => peerDeviceId === "peer-device")).toBe(true);
  await result.discardInterrupted("sender", "peer-device");
});

it("disables Send after a selected-chat hide and requires a fresh archive", async () => {
  await setupSender();
  await act(async () => { await result.prepare(); });
  expect(result.canSend).toBe(true);
  act(() => { publishLocalMessageChange("other", "hide", "other-chat"); });
  expect(result.canSend).toBe(true);
  act(() => { publishLocalMessageChange("removed", "hide", "chat"); });
  expect(result).toMatchObject({ canSend: false, error: "archive-changed", preparing: false });
  expect(result.manifest).toBeUndefined();
  await act(async () => { await expect(result.send()).rejects.toThrow(); });
});

it("stops an active stale stream and keeps its checkpoint for a fresh pairing", async () => {
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  const socket = await setupSender();
  await act(async () => { await result.prepare(); await result.send(); });
  await act(async () => { publishLocalMessageChange("hidden", "hide", "chat"); });
  expect(socket.send).toHaveBeenLastCalledWith('{"type":"abort"}');
  expect(socket.close).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ phase: "paused", requiresPairing: true, error: "archive-changed" });
  expect(result.canSend).toBe(false);
  expect((await result.listInterrupted("sender")).find(({ peerDeviceId }) => peerDeviceId === "peer-device")).toBeDefined();
});

it("rechecks durable removals before resuming a paused stream even without the broadcast", async () => {
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  const socket = await setupSender();
  await act(async () => { await result.prepare(); await result.send(); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await act(async () => { socket.onclose?.({ code: 1006 }); vi.advanceTimersByTime(60_000); });
    expect(result.phase).toBe("paused");
    const id = historyRemovalKey("chat", "user");
    await (await getAppDB()).put("accountState", { id, revision: "remove-while-paused" });
    await act(async () => { await result.resume(); });
    const resumed = sockets[1];
    await act(async () => { announcePeer(resumed); await vi.waitFor(() => expect(resumed.close).toHaveBeenCalled()); });
    expect(result).toMatchObject({ phase: "paused", requiresPairing: true, error: "archive-changed" });
    expect(resumed.send).toHaveBeenCalledWith('{"type":"abort"}');
  } finally { vi.useRealTimers(); }
});

it("allows reconnect grace while releasing the idle hold at the original progress deadline", async () => {
  const releaseIdle = vi.fn();
  vi.mocked(holdIdleLock).mockReturnValueOnce(releaseIdle);
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  const socket = await setupSender();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    await act(async () => { await result.prepare(); await result.send(); });
    await act(async () => { vi.advanceTimersByTime(50_000); socket.onclose?.({ code: 1006 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    expect(result).toMatchObject({ phase: "reconnecting", requiresPairing: false });
    expect(releaseIdle).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(49_999); });
    expect(result).toMatchObject({ phase: "paused", requiresPairing: false });
    expect(releaseIdle).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("requires a new archive when a selected group was left while the sender was disconnected", async () => {
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  const socket = await setupSender("group");
  await act(async () => { await result.prepare(); await result.send(); });
  vi.mocked(refreshConversationList).mockResolvedValue([]);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await act(async () => { socket.onclose?.({ code: 1006 }); await vi.advanceTimersByTimeAsync(1_600); });
    const resumed = sockets[1];
    await act(async () => { announcePeer(resumed); await vi.waitFor(() => expect(resumed.close).toHaveBeenCalled()); });
    expect(result).toMatchObject({ phase: "paused", requiresPairing: true, error: "archive-changed" });
    expect(resumed.send).toHaveBeenCalledWith('{"type":"abort"}');
  } finally { vi.useRealTimers(); }
});

it("does not renew the idle deadline on repeated reconnects at the same record index", async () => {
  const releaseIdle = vi.fn();
  vi.mocked(holdIdleLock).mockReturnValueOnce(releaseIdle);
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  vi.spyOn(HistoryTransferStream.prototype, "progress", "get").mockReturnValue({ records: 1, totalRecords: 20, bytes: 20, totalBytes: 400 });
  let socket = await setupSender();
  const sending = vi.spyOn(HistoryTransferStream.prototype, "setSendingPaused");
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    await act(async () => {
      socket.receive({ type: "lease", expiresAt: Date.now() + 300_000 });
      await result.prepare(); await result.send();
    });
    const start = Date.now();
    for (const elapsed of [20_000, 40_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(start + elapsed - Date.now());
        socket.onclose?.({ code: 1006 });
        await vi.advanceTimersByTimeAsync(1_600);
        socket = sockets.at(-1)!;
        announcePeer(socket);
        await waitForHello(socket);
        await vi.waitFor(() => expect(sending).toHaveBeenLastCalledWith(false));
      });
      expect(result.phase).toBe("transferring");
      expect(releaseIdle).not.toHaveBeenCalled();
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(start + TRANSFER_PROGRESS_TIMEOUT_MS - Date.now()); });
    expect(releaseIdle).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ phase: "paused", requiresPairing: true });
  } finally { vi.useRealTimers(); }
});

it.each([true, false])("keeps the reconnect deadline active while deletion checks are pending (checks finish %s)", async (checksFinish) => {
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  const socket = await setupSender();
  const sending = vi.spyOn(HistoryTransferStream.prototype, "setSendingPaused");
  let finishChecks!: () => void;
  const checks = new Promise<void>((resolve) => { finishChecks = resolve; });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    await act(async () => { socket.receive({ type: "lease", expiresAt: Date.now() + 5 * 60_000 }); });
    await act(async () => { await result.prepare(); await result.send(); });
    vi.mocked(verifyHistoryDisclosure).mockImplementationOnce(() => checks);
    await act(async () => { socket.onclose?.({ code: 1006 }); await vi.advanceTimersByTimeAsync(1_600); });
    const resumed = sockets[1];
    await act(async () => {
      announcePeer(resumed);
      await vi.waitFor(() => expect(resumed.send).toHaveBeenCalledWith(expect.stringContaining('"kind":"offer"')));
      await vi.advanceTimersByTimeAsync(26_000);
    });
    expect(resumed.close).not.toHaveBeenCalled();
    expect(sending).toHaveBeenLastCalledWith(true);
    expect(result.phase).toBe("reconnecting");
    if (checksFinish) {
      await act(async () => { finishChecks(); await vi.waitFor(() => expect(sending).toHaveBeenLastCalledWith(false)); });
      expect(result.phase).toBe("transferring");
    } else {
      await act(async () => { await vi.advanceTimersByTimeAsync(34_000); });
      expect(result.phase).toBe("paused");
      expect(resumed.close).toHaveBeenCalled();
      await act(async () => { finishChecks(); });
      expect(sending).toHaveBeenLastCalledWith(true);
      expect(result.phase).toBe("paused");
      await act(async () => { await result.resume(); });
      expect(sockets).toHaveLength(3);
    }
  } finally { finishChecks(); vi.useRealTimers(); }
});

it("verifies quarantined messages before reporting picker totals", async () => {
  await setupSender();
  const now = Date.now();
  await (await getAppDB()).put("legacyMessages", { id: "catalog-message", conversationId: "chat", senderId: "peer",
    type: "text", content: "an earlier message", timestamp: now, expiresAt: now + 60_000, status: "delivered" });
  vi.mocked(api.post).mockResolvedValueOnce({ ids: ["catalog-message"] });
  expect(await result.listChats()).toMatchObject([{ id: "chat", messages: 1 }]);
  expect(api.post).toHaveBeenCalledWith("/api/messages/history-ownership", { messages: [expect.objectContaining({ id: "catalog-message" })] });
});

it("keeps verified history selectable and discloses quarantined rows after a lookup failure", async () => {
  await setupSender();
  const db = await getAppDB();
  const row = { id: "pending-legacy", conversationId: "chat", senderId: "peer", type: "text", content: "earlier",
    timestamp: Date.now(), expiresAt: null, status: "delivered" } as const;
  await db.put("legacyMessages", row);
  await db.put("displayMessages", { ...row, id: "verified", ownerId: "user" });
  vi.mocked(api.post).mockRejectedValueOnce(new Error("429"));
  expect(await result.listChats()).toMatchObject([{ id: "chat", messages: 1, pendingLegacyMessages: 1 }]);
  vi.mocked(api.post).mockRejectedValueOnce(new Error("429"));
  await act(async () => {
    expect(await result.prepare()).toMatchObject({ chats: [{ id: "chat", messages: 1, skippedLegacyMessages: 1 }] });
  });
  expect(await db.get("legacyMessages", row.id)).toBeDefined();
});

it("starts a fresh archive when the prior checkpoint's unfinished chat is unavailable", async () => {
  const scope = { userId: "user", deviceId: "new-device", role: "sender" } as const;
  const checkpoint = { ...completedCheckpoint, resumeId: crypto.randomUUID(),
    chats: [...completedCheckpoint.chats, { id: "no-longer-accessible", messages: 1, bytes: 20, attachmentBytes: 0 }] };
  await saveHistoryTransferCheckpoint(scope, "peer-device", checkpoint, () => true);
  await setupSender();
  const prepare = vi.spyOn(HistoryTransferStream.prototype, "prepare");
  await act(async () => { await result.prepare(); });
  const stream = prepare.mock.contexts.at(-1) as HistoryTransferStream;
  await act(async () => { await stream["checkpoint"]!.received(checkpoint); });
  expect(result.checkpoint).toMatchObject(checkpoint);
  await act(async () => { result.startFresh(); });
  expect(result.checkpoint).toBeUndefined();
  await act(async () => {
    const manifest = await result.prepare([{ conversationId: "chat" }]);
    expect(manifest.resumeId).toBeDefined();
    expect(manifest.resumeId).not.toBe(checkpoint.resumeId);
    expect(manifest.chats).toMatchObject([{ id: "chat" }]);
  });
});

it("interrupts a running archive when a membership update removes a selected chat", async () => {
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  const socket = await setupSender("group");
  const [group] = await refreshConversationList();
  await act(async () => { await result.prepare(); await result.send(); });
  await act(async () => { useChatStore.getState().setConversations([{ ...group, updatedAt: group.updatedAt + 1 }]); });
  expect(result.phase).toBe("transferring");
  await act(async () => { useChatStore.getState().setConversations([{ ...group, members: [] }]); });
  expect(result).toMatchObject({ phase: "paused", requiresPairing: true, error: "archive-changed" });
  expect(socket.send).toHaveBeenLastCalledWith('{"type":"abort"}');
  expect(socket.close).toHaveBeenCalledOnce();
});

it("keeps the checkpoint on a peer interruption without sending an interruption back", async () => {
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  const socket = await setupSender();
  await act(async () => { await result.prepare(); await result.send(); });
  await act(async () => { socket.receive({ type: "abort" }); });
  expect(result).toMatchObject({ phase: "paused", requiresPairing: true, error: "transfer-interrupted" });
  expect((await result.listInterrupted("sender")).find(({ peerDeviceId }) => peerDeviceId === "peer-device")).toBeDefined();
  expect(socket.send).not.toHaveBeenCalledWith('{"type":"abort"}');
});

it("invalidates a prepared archive when cached bytes expire before their message", async () => {
  await setupSender();
  const time = Date.now();
  const db = await getAppDB();
  const { Blob: StoredBlob } = await import("node:buffer");
  const timestamp = time - 1;
  const expiresAt = time + 10_000;
  await db.put("displayMessages", { id: "file-message", conversationId: "chat", senderId: "peer", ownerId: "user", type: "file",
    content: JSON.stringify({ fileId: "offline-file", fileName: "photo.png", mimeType: "image/png", fileKey: "A".repeat(43), iv: "A".repeat(16) }),
    timestamp, expiresAt: time + 60_000, status: "delivered" });
  await db.put("accountFiles", { id: "offline-file", ownerId: "user", expiresAt, cachedAt: timestamp,
    sealed: { iv: new Uint8Array(12), ciphertext: new StoredBlob([new Uint8Array(19)]) } });
  try {
    await act(async () => { expect((await result.prepare(undefined, { copyDownloadedFiles: true })).chats[0].attachmentBytes).toBe(3); });
    vi.spyOn(Date, "now").mockReturnValue(expiresAt);
    await act(async () => { await expect(result.send()).rejects.toThrow("History changed"); });
    expect(result).toMatchObject({ canSend: false, error: "archive-changed" });
    await act(async () => { expect((await result.prepare(undefined, { copyDownloadedFiles: true })).chats[0].attachmentBytes).toBe(0); });
  } finally {
    await db.delete("displayMessages", ["user", "file-message"]);
    await db.delete("accountFiles", "offline-file");
  }
});

it.each([false, true])("leaves the checkpoint unchanged on rejected preflight (resuming %s)", async (resuming) => {
  const scope = { userId: "user", deviceId: "new-device", role: "sender" } as const;
  if (resuming) await saveHistoryTransferCheckpoint(scope, "peer-device", completedCheckpoint, () => true);
  await setupSender();
  const send = vi.spyOn(HistoryTransferStream.prototype, "send");
  await act(async () => { await result.prepare(); });
  const id = historyRemovalKey("chat", "user");
  await (await getAppDB()).put("accountState", { id, revision: crypto.randomUUID() });
  await act(async () => { await expect(result.send()).rejects.toThrow("History changed"); });
  expect(send).not.toHaveBeenCalled();
  expect(await loadHistoryTransferCheckpoint(scope, "peer-device")).toEqual(resuming ? completedCheckpoint : undefined);
  await act(async () => { result.stop(); });
  expect(await loadHistoryTransferCheckpoint(scope, "peer-device")).toEqual(resuming ? completedCheckpoint : undefined);
  await result.discardInterrupted("sender", "peer-device");
});

it("blocks Send on an unavailable deletion lookup without writing progress or starting the stream", async () => {
  await setupSender();
  await act(async () => { await result.prepare(); });
  const send = vi.spyOn(HistoryTransferStream.prototype, "send");
  vi.mocked(verifyHistoryDisclosure).mockRejectedValueOnce(new Error("Deletion lookup unavailable"));
  await act(async () => { await expect(result.send()).rejects.toThrow("Deletion lookup unavailable"); });
  expect(send).not.toHaveBeenCalled();
  expect(await loadHistoryTransferCheckpoint({ userId: "user", deviceId: "new-device", role: "sender" }, "peer-device")).toBeUndefined();
});

it("drops the idle-lock hold when records stop moving despite a renewed room lease", async () => {
  const release = vi.fn();
  vi.mocked(holdIdleLock).mockReturnValueOnce(release);
  const socket = await setupSender();
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  vi.spyOn(HistoryTransferStream.prototype, "checkCode", "get").mockReturnValue("123456");
  await act(async () => { await result.prepare(); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const start = Date.now();
  await act(async () => {
    socket.receive({ type: "lease", expiresAt: start + 5 * 60_000 });
    await result.send();
  });
  expect(result.phase).toBe("transferring");
  expect(release).not.toHaveBeenCalled();
  await act(async () => {
    vi.advanceTimersByTime(TRANSFER_PROGRESS_TIMEOUT_MS - 1);
    socket.receive({ type: "lease", expiresAt: start + 10 * 60_000 });
  });
  expect(release).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(release).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ phase: "paused", requiresPairing: true, canSend: false });
  expect(socket.send).toHaveBeenLastCalledWith('{"type":"abort"}');
});

it.each(["sender", "receiver"] as const)("refreshes the %s inactivity timer during receipt progress without changing displayed progress", async (role) => {
  const progress = { records: 2, totalRecords: 2, bytes: 120, totalBytes: 120 };
  vi.spyOn(HistoryTransferStream.prototype, "progress", "get").mockReturnValue(progress);
  vi.spyOn(HistoryTransferStream.prototype, "ready", "get").mockReturnValue(true);
  const notify = vi.spyOn(HistoryTransferStream.prototype, "setSendingPaused");
  let socket: Socket;
  if (role === "sender") {
    socket = await setupSender();
    await act(async () => { await result.prepare(); });
  } else {
    await dom.render(<Probe />);
    await act(async () => { await result.startAsReceiver(); });
    socket = sockets.at(-1)!;
    await act(async () => { announcePeer(socket); await waitForHello(socket); });
  }
  const stream = notify.mock.contexts.at(-1) as HistoryTransferStream;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    await act(async () => {
      socket.receive({ type: "lease", expiresAt: Date.now() + 5 * 60_000 });
      if (role === "sender") await result.send();
      else { stream["receivedBegin"] = true; stream["onChange"](); }
    });
    expect(result.phase).toBe("transferring");
    for (let part = 0; part < 2; part++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TRANSFER_PROGRESS_TIMEOUT_MS * 2 / 3);
        stream["noteReceiptActivity"]();
      });
      expect(result.phase).toBe("transferring");
      expect(result.progress).toEqual(progress);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(TRANSFER_PROGRESS_TIMEOUT_MS); });
    expect(result).toMatchObject({ phase: "paused", requiresPairing: true });
  } finally { vi.useRealTimers(); }
});

it("requires receiver space for a new chat even when its conversation-only archive fits on the wire", async () => {
  await setupSender();
  const prepare = vi.spyOn(HistoryTransferStream.prototype, "prepare");
  await act(async () => { await result.prepare(); });
  const stream = prepare.mock.contexts.at(-1) as HistoryTransferStream;
  const archive = prepare.mock.calls.at(-1)?.[0];
  expect(archive?.manifest.chats[0].messages).toBe(0);
  stream.peerCapacity = { free: archive!.size, cellular: false };
  const estimate = vi.spyOn(stream, "estimateRemaining").mockImplementation((archive) => estimateHistoryStorage("user", archive.spaceItems));
  await act(async () => {
    const checked = await result.prepare();
    expect(checked.requiredBytes).toBeGreaterThan(checked.freeBytes!);
  });
  expect(estimate).toHaveBeenCalledOnce();
  expect(result.canSend).toBe(false);
  await act(async () => { await expect(result.send()).rejects.toThrow("not ready"); });
});

it("clears canSend on a dropped connection before data begins", async () => {
  const socket = await setupSender();
  await act(async () => { await result.prepare(); });
  expect(result.canSend).toBe(true);
  await act(async () => { socket.onclose?.({ code: 1006 }); });
  expect(result.canSend).toBe(false);
});

it("keeps the wake lock when the transfer screen unmounts and releases it on Stop", async () => {
  const release = vi.fn(async () => {});
  const request = vi.fn(async () => ({ release, addEventListener: vi.fn() }));
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
  try {
    await setupSender();
    await act(async () => { await result.prepare(); await result.send(); });
    expect(request).toHaveBeenCalledWith("screen");
    expect(result.screenOn).toBe(true);
    await dom.render(null);
    expect(release).not.toHaveBeenCalled();
    await dom.render(<Probe />);
    await act(async () => { result.stop(); });
    expect(release).toHaveBeenCalledOnce();
    expect(result.screenOn).toBe(false);
  } finally {
    if (descriptor) Object.defineProperty(navigator, "wakeLock", descriptor);
    else Reflect.deleteProperty(navigator, "wakeLock");
  }
});

it("does not send a prepared group after membership disappears from the current list", async () => {
  await setupSender();
  const streamSend = vi.spyOn(HistoryTransferStream.prototype, "send");
  await act(async () => { await result.prepare([{ conversationId: "chat" }]); });
  vi.mocked(refreshConversationList).mockResolvedValue([]);
  await act(async () => { await expect(result.send()).rejects.toThrow("no longer available"); });
  expect(streamSend).not.toHaveBeenCalled();
  expect(result).toMatchObject({ canSend: false, error: "archive-changed" });
});

it.each(["lock", "expiry"])("stops after %s without exposing the peer and discards only the matching checkpoint", async (interrupt) => {
  vi.spyOn(HistoryTransferStream.prototype, "confirmed", "get").mockReturnValue(true);
  const socket = await setupSender();
  await act(async () => { await result.prepare(); await result.send(); });
  const foreign = { userId: "another-user", deviceId: "new-device", role: "sender" as const };
  await saveHistoryTransferCheckpoint(foreign, "peer-device", completedCheckpoint, () => true);
  if (interrupt === "lock") await act(async () => { clearUnlockedSessionState(); });
  else {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      socket.receive({ type: "lease", expiresAt: Date.now() - 1 });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.useRealTimers();
  }
  expect(result).toMatchObject({ phase: "paused", requiresPairing: true, peerDeviceId: undefined, peerDeviceName: undefined });
  expect(socket.send).toHaveBeenLastCalledWith('{"type":"abort"}');
  expect(await result.listInterrupted("sender")).toHaveLength(1);
  await act(async () => { result.stop(); });
  expect(result.phase).toBe("idle");
  await vi.waitFor(async () => expect(await result.listInterrupted("sender")).toEqual([]));
  const { loadHistoryTransferCheckpoint } = await import("../../db/history-transfer-progress.js");
  expect(await loadHistoryTransferCheckpoint(foreign, "peer-device")).toEqual(completedCheckpoint);
});
