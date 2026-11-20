import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  fromBase64Url, fromDistribution, generateX25519KeyPair,
  initSessionAsInitiator, initSessionAsResponder, randomBytes, ratchetDecrypt, ratchetEncrypt,
  senderKeyDecrypt, toBase64Url, type RatchetSession, type SenderKeyState,
} from "@e2ee-chat/crypto";
import type { SendDirectBatchRequest, SendMessageRequest } from "@e2ee-chat/shared";
import { commitReceivedMessage, getAllOutgoing, getAppDB, getMessageById, getOutgoing, getSenderKey, saveQueuedMessage, type LocalOutgoing } from "../../db/index.js";
import { api } from "../../services/api.js";
import { encryptGroupMessage } from "../../lib/group-session.js";
import { encryptGroupText, encryptMessage } from "../../lib/message-processor.js";
import { useChatStore } from "../../stores/chatStore.js";
import { discardOutgoing, refreshOutgoingQueue, retryOutgoing, startOutgoingQueue, subscribeQueue } from "./outgoingQueue.js";

vi.mock("../../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ user: { id: "alice" }, device: { id: "local" }, accessToken: "token", sessionId: "session" }) } }));
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("../../lib/key-manager.js", () => ({ keysLoaded: () => true }));
vi.mock("../../lib/message-processor.js", () => ({ encryptMessage: vi.fn(), encryptGroupText: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ CONVERSATION_QUERY_KEY: ["conversation"], touchConversationInCache: vi.fn() }));

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
type SendBody = SendDirectBatchRequest | SendMessageRequest;
type Peer = { sender: RatchetSession; receiver: RatchetSession; groupKeys: Map<number, SenderKeyState> };
let peers: Map<string, Peer>;
const makePeer = async (): Promise<Peer> => {
  const preKey = await generateX25519KeyPair();
  const secret = randomBytes(32);
  return {
    sender: await initSessionAsInitiator(secret, preKey.publicKey),
    receiver: await initSessionAsResponder(secret, preKey),
    groupKeys: new Map(),
  };
};
let conversationType: "direct" | "group";
let members: string[];
let groupEpoch: number | undefined;
let removeOnNextMessage: boolean;
let timedOut: boolean;
let received: { id: string; content: string }[];
let receiveErrors: unknown[];
let requests: SendBody[];
let receipts: Map<string, { envelope: string; result: { id: string; serverTimestamp: number; expiresAt: number; expiryKind: "retention" } }>;
let failDistribution: boolean;
let failMessage: "before delivery" | "after delivery" | null;
let rejectUpload: boolean;
let recipientIsMember: boolean;
let recipientOnline: boolean;
let recipientJoinAdmissionId: string | undefined;
let admissionVersion: number | undefined;
let approveOnSend: boolean;

// Exercise real Double Ratchet distribution encryption, the production group-session
// preparation/persistence, and real Sender Key encryption/decryption. Only transport
// and the message-processor adapters are replaced.
beforeEach(async () => {
  vi.resetAllMocks();
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  useChatStore.setState({ messages: new Map(), outgoingRemovalNotices: new Set() });
  conversationType = "group";
  members = ["alice", "bob"];
  groupEpoch = undefined;
  removeOnNextMessage = false;
  timedOut = false;
  received = []; receiveErrors = []; requests = []; receipts = new Map();
  failDistribution = false; failMessage = null; rejectUpload = false;
  recipientIsMember = true; recipientOnline = true; recipientJoinAdmissionId = undefined;
  admissionVersion = undefined; approveOnSend = false;
  peers = new Map([["remote", await makePeer()]]);
  vi.mocked(encryptMessage).mockImplementation(async (_type, plaintext, _userId, targetDeviceId, _editKey, joinAdmissionId) => {
    const recipientDeviceId = targetDeviceId ?? "remote";
    const encrypted = await ratchetEncrypt(peers.get(recipientDeviceId)!.sender, encode(plaintext));
    return { ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv), header: JSON.stringify({ ...encrypted.header, recipientDeviceId, joinAdmissionId }) };
  });
  vi.mocked(encryptGroupText).mockImplementation(async (id, plaintext, editKey, epoch) => {
    const encrypted = await encryptGroupMessage(id, encode(plaintext), editKey, epoch);
    return { ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv), header: JSON.stringify(encrypted.header) };
  });
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === "/api/conversations/chat") return { id: "chat", type: conversationType, groupEpoch, groupAdmissionVersion: admissionVersion,
      members: members.filter((userId) => userId !== "bob" || recipientIsMember)
        .map((userId) => ({ userId, joinAdmissionId: userId === "bob" ? recipientJoinAdmissionId : undefined })) } as never;
    if (path === "/api/devices/user/alice") return [{ id: "local", userId: "alice" }] as never;
    if (path === "/api/devices/user/bob") return [{ id: "remote", userId: "bob" }] as never;
    if (path === "/api/devices/user/carol") return [{ id: "carol-device", userId: "carol" }] as never;
    throw new Error(`Unexpected lookup: ${path}`);
  });
  vi.mocked(api.put).mockResolvedValue({ success: true });
  vi.mocked(api.post).mockImplementation(async (path, payload) => {
    if (path === "/api/files/upload-url") {
      if (rejectUpload) throw Object.assign(new Error("Rejected upload"), { status: 400 });
      return { fileId: "file", uploadUrl: "/upload" } as never;
    }
    const body = structuredClone(payload) as SendBody;
    requests.push(body);
    const distribution = body.type === "sender_key_distribution";
    if (!distribution && timedOut) throw Object.assign(new Error("Timeout"), { status: 403, code: "GROUP_TIMED_OUT" });
    const id = "messages" in body ? body.messages[0].id : body.id;
    const envelope = JSON.stringify(body);
    const receipt = receipts.get(id);
    if (receipt) {
      if (receipt.envelope !== envelope) throw Object.assign(new Error("Different envelope"), { status: 409 });
      return receipt.result as never;
    }
    if (!distribution && removeOnNextMessage) {
      removeOnNextMessage = false;
      removeBob();
    }
    if (!distribution && approveOnSend) {
      approveOnSend = false;
      admissionVersion = (admissionVersion ?? 0) + 1;
      recipientIsMember = true;
      if (!members.includes("bob")) members.push("bob");
      recipientJoinAdmissionId = "approved-in-flight";
    }
    if (conversationType === "group" && (body.groupEpoch !== groupEpoch || body.groupAdmissionVersion !== admissionVersion)) {
      throw Object.assign(new Error("Group membership changed"), { status: 409, code: "GROUP_MEMBERSHIP_CHANGED" });
    }
    if (!distribution && id === "first" && failMessage === "before delivery") {
      failMessage = null;
      throw new SyntaxError("Unparseable send response");
    }
    const result = { id, serverTimestamp: Date.now(), expiresAt: Date.now() + 60000, expiryKind: "retention" as const };
    receipts.set(id, { envelope, result });
    // The server stores opaque envelopes. Recipient errors must not affect receipts.
    try { if (recipientIsMember && recipientOnline) await receive(body); } catch (error) { receiveErrors.push(error); }
    if (distribution && failDistribution) { failDistribution = false; throw new SyntaxError("Unparseable distribution response"); }
    if (!distribution && id === "first" && failMessage === "after delivery") { failMessage = null; throw new SyntaxError("Unparseable send response"); }
    return result as never;
  });
});
afterEach(() => vi.unstubAllGlobals());

function removeBob() {
  members = members.filter((userId) => userId !== "bob");
  groupEpoch = (groupEpoch ?? 0) + 1;
}

async function receive(body: SendBody) {
  if ("messages" in body) {
    for (const message of body.messages) {
      const header = JSON.parse(message.header);
      const peer = peers.get(header.recipientDeviceId)!;
      const plaintext = decode(await ratchetDecrypt(peer.receiver, header, fromBase64Url(message.ciphertext), fromBase64Url(message.iv)));
      if (body.type === "sender_key_distribution") {
        const { distribution } = JSON.parse(plaintext);
        // Production receive likewise never resets an already advanced sender chain.
        if (!peer.groupKeys.has(distribution.senderKeyId)) peer.groupKeys.set(distribution.senderKeyId, fromDistribution(distribution));
      } else received.push({ id: message.id, content: plaintext });
    }
  } else {
    const header = JSON.parse(body.header);
    const receiver = peers.get(members.includes("bob") ? "remote" : "carol-device")?.groupKeys.get(header.senderKeyId);
    if (!receiver) throw new Error("Missing sender key");
    const plaintext = await senderKeyDecrypt(receiver, header, fromBase64Url(body.ciphertext), fromBase64Url(body.iv));
    received.push({ id: body.id, content: decode(plaintext) });
  }
}

it.each(["before preparation", "after preparation"])("rotates before the next committed send when removal occurs %s", async (when) => {
  members.push("carol");
  peers.set("carol-device", await makePeer());
  groupEpoch = 0;
  await enqueue("first");
  await retryOutgoing("first");
  const bob = peers.get("remote")!;
  const [retainedKey] = bob.groupKeys.values();
  expect(retainedKey.chainIndex).toBe(1);
  if (when === "before preparation") removeBob();
  else removeOnNextMessage = true;
  await enqueue("later");
  await retryOutgoing("later");
  expect(await getAllOutgoing()).toEqual([]);
  expect(receiveErrors).toEqual([]);
  expect(received).toEqual([{ id: "first", content: "first" }, { id: "later", content: "later" }]);
  const [distribution, message] = requests.filter((body) => body.groupEpoch === 1) as [SendDirectBatchRequest, SendMessageRequest];
  expect(distribution.messages.map((entry) => JSON.parse(entry.header).recipientDeviceId)).toEqual(["carol-device"]);
  const header = JSON.parse(message.header);
  expect(header.senderKeyId).not.toBe(retainedKey.senderKeyId);
  expect(bob.groupKeys.has(header.senderKeyId)).toBe(false);
  const carol = peers.get("carol-device")!.groupKeys.get(header.senderKeyId)!;
  // Even with the new public signing key and the expected index, the retained
  // chain key cannot authenticate or decrypt the new ciphertext.
  const oldChain = { ...retainedKey, senderKeyId: header.senderKeyId, chainIndex: header.chainIndex,
    signingPublicKey: carol.signingPublicKey };
  await expect(senderKeyDecrypt(oldChain, header, fromBase64Url(message.ciphertext), fromBase64Url(message.iv))).rejects.toThrow();
});

it("makes a first timed-out POST discardable and releases later sends", async () => {
  timedOut = true;
  await enqueue("first");
  await retryOutgoing("first");
  expect(await getOutgoing("first")).toMatchObject({ status: "failed", error: "groupTimedOut", sendDispatched: false });
  await expect(discardOutgoing("first")).resolves.toBeUndefined();
  timedOut = false;
  await enqueue("later");
  await retryOutgoing("later");
  expect(received).toEqual([{ id: "later", content: "later" }]);
});

it("preserves an ambiguous earlier envelope across a timed-out retry", async () => {
  failMessage = "after delivery";
  await enqueue("first");
  await retryOutgoing("first");
  timedOut = true;
  await retryOutgoing("first");
  await expect(discardOutgoing("first")).resolves.toBe("already-sending");
  timedOut = false;
  await retryOutgoing("first");
  expect(await getAllOutgoing()).toEqual([]);
  expect(received).toEqual([{ id: "first", content: "first" }]);
  const attempts = requests.filter((body) => "id" in body && body.id === "first");
  expect(attempts).toEqual([attempts[0], attempts[0], attempts[0]]);
});

async function enqueue(id: string, content = id, upload?: LocalOutgoing["upload"]) {
  await saveQueuedMessage({ id, conversationId: "chat", senderId: "alice", type: upload ? "file" : "text", content, timestamp: Date.now(), expiresAt: null, status: "sending" }, {
    id, queuedAt: Date.now(), conversationId: "chat", conversationType, userId: "alice", deviceId: "local",
    ttlSeconds: null, attempts: 0, status: "sending", retryable: true, nextAttemptAt: null, error: null,
    steps: [], sendDispatched: false, upload,
  });
}

it("decrypts a later group text and a freshly encrypted retry after a distribution-parse failure", async () => {
  failDistribution = true;
  await enqueue("first");
  await retryOutgoing("first");
  const failed = (await getOutgoing("first"))!;
  expect.soft(failed).toMatchObject({ status: "failed", retryable: false, sendDispatched: false });
  expect.soft(failed.steps).toMatchObject([{ sendDispatched: true }, { sendDispatched: false }]);
  const original = failed.steps.find((step) => step.path === "/api/messages/send")!.body as SendMessageRequest;
  await enqueue("later");
  await retryOutgoing("later");
  expect(await getMessageById("later")).toMatchObject({ status: "sent" });
  await retryOutgoing("first");
  expect(await getAllOutgoing()).toEqual([]);
  expect(receiveErrors).toEqual([]);
  expect(received).toEqual([{ id: "later", content: "later" }, { id: "first", content: "first" }]);
  const retried = requests.find((body): body is SendMessageRequest => "id" in body && body.id === "first")!;
  expect(retried.ciphertext).not.toBe(original.ciphertext);
  expect(JSON.parse(retried.header).chainIndex).toBeGreaterThan(JSON.parse(original.header).chainIndex);
  // The distribution's idempotent envelope is still replayed verbatim.
  expect(requests[requests.length - 2]).toEqual(requests[0]);
});

it("gives a newly approved device the current sender key without exposing pre-approval text", async () => {
  recipientIsMember = false;
  await enqueue("before");
  await retryOutgoing("before");
  expect(requests.map(request => request.type)).toEqual(["text"]);
  expect(encryptMessage).not.toHaveBeenCalled();

  recipientIsMember = true;
  await enqueue("after");
  await retryOutgoing("after");
  expect(requests.map(request => request.type)).toEqual(["text", "sender_key_distribution", "text"]);
  expect(received).toEqual([{ id: "after", content: "after" }]);
  expect(receiveErrors).toEqual([]);
  const previous = requests[0] as SendMessageRequest;
  await expect(receive(previous)).rejects.toThrow("Sender key message is outdated");
});

it("rotates on removal and redistributes the new key at the readmission checkpoint", async () => {
  recipientOnline = false;
  await enqueue("old-membership");
  await retryOutgoing("old-membership");
  expect(requests.map(request => request.type)).toEqual(["sender_key_distribution", "text"]);
  expect(peers.get("remote")!.groupKeys.size).toBe(0);
  removeBob();
  recipientIsMember = false;
  await enqueue("while-removed");
  await retryOutgoing("while-removed");

  recipientIsMember = true;
  recipientOnline = true;
  members.push("bob");
  admissionVersion = 1;
  recipientJoinAdmissionId = "new-approval";
  await enqueue("after");
  await retryOutgoing("after");
  await enqueue("next");
  await retryOutgoing("next");

  expect(requests.map(request => request.type)).toEqual(["sender_key_distribution", "text", "text", "sender_key_distribution", "text", "text"]);
  const distribution = requests[3] as SendDirectBatchRequest;
  expect(distribution).toMatchObject({ groupEpoch: 1, groupAdmissionVersion: 1 });
  expect(JSON.parse((requests[2] as SendMessageRequest).header).senderKeyId)
    .not.toBe(JSON.parse((requests[1] as SendMessageRequest).header).senderKeyId);
  expect(JSON.parse(distribution.messages[0].header)).toMatchObject({ joinAdmissionId: "new-approval", recipientDeviceId: "remote" });
  expect(receiveErrors).toEqual([]);
  expect(received).toEqual([{ id: "after", content: "after" }, { id: "next", content: "next" }]);
  await expect(receive(requests[2])).rejects.toThrow("Sender key message is outdated");
});

it.each(["text", "file"])("refreshes a prepared group %s and sends its checkpoint first when approval overtakes the send", async type => {
  recipientIsMember = false;
  admissionVersion = 0;
  approveOnSend = true;
  const attachment = { fileId: "", fileName: "test.png", mimeType: "image/png", fileKey: "private", iv: "private-iv" };
  const upload = type === "file" ? { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" } : undefined;
  await enqueue("racing", upload ? JSON.stringify(attachment) : "racing text", upload);
  await retryOutgoing("racing");
  expect(await getOutgoing("racing")).toBeUndefined();
  expect(requests.map(request => [request.type, request.groupAdmissionVersion]))
    .toEqual([[type, 0], ["sender_key_distribution", 1], [type, 1]]);
  expect((requests[2] as SendMessageRequest).id).toBe("racing");
  expect((requests[2] as SendMessageRequest).ciphertext).not.toBe((requests[0] as SendMessageRequest).ciphertext);
  expect(received).toEqual([{ id: "racing", content: upload ? JSON.stringify({ ...attachment, fileId: "file" }) : "racing text" }]);
  expect(receiveErrors).toEqual([]);
  expect(api.put).toHaveBeenCalledTimes(upload ? 1 : 0);
});

it("commits an authenticated new-admission checkpoint without rewinding or skipping again", async () => {
  const senderKey = { id: "chat:alice:local:17", senderKeyId: 17, signingPublicKey: "public", signingPrivateKey: "", chainKey: "first", chainIndex: 2 };
  const session = { id: "alice:local", state: "authenticated direct ratchet", updatedAt: 1 };
  const commit = (id: string, key: typeof senderKey & { joinAdmissionId?: string }) =>
    commitReceivedMessage(id, { ownerId: "bob", deviceId: "remote", expiresAt: null, senderKey: key }, { session });
  await commit("old-distribution", senderKey);
  const fresh = { ...senderKey, joinAdmissionId: "new-approval", chainIndex: 5000, chainKey: "new" };
  await commit("fresh-distribution", fresh);
  expect(await getSenderKey(senderKey.id)).toEqual(fresh);
  await commit("duplicate-admission", { ...fresh, chainIndex: 5002 });
  await commit("late-old-admission", { ...senderKey, joinAdmissionId: "old-approval" });
  await commit("different-signing-key", { ...fresh, joinAdmissionId: "another-approval", chainIndex: 6000, signingPublicKey: "different" });
  expect(await getSenderKey(senderKey.id)).toEqual(fresh);
});
it("does not block group text after an upload-url rejection and encrypts the retried file at the current chain", async () => {
  rejectUpload = true;
  const payload = JSON.stringify({ fileId: "", fileName: "installer.dmg", mimeType: "application/x-apple-diskimage", fileKey: "private", iv: "private-iv" });
  await enqueue("first", payload, { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" });
  await retryOutgoing("first");
  expect(await getOutgoing("first")).toMatchObject({ status: "failed", retryable: false, sendDispatched: false, steps: [] });
  await enqueue("later");
  await retryOutgoing("later");
  expect(received).toEqual([{ id: "later", content: "later" }]);
  rejectUpload = false;
  await retryOutgoing("first");
  expect(await getAllOutgoing()).toEqual([]);
  expect(receiveErrors).toEqual([]);
  expect(received[1]).toEqual({ id: "first", content: JSON.stringify({ ...JSON.parse(payload), fileId: "file" }) });
  const messages = requests.filter((body): body is SendMessageRequest => "id" in body);
  expect(messages.map((body) => JSON.parse(body.header).chainIndex)).toEqual([0, 1]);
});

it.each(["before delivery", "after delivery"] as const)("holds later group ciphertext after an ambiguous failure %s until a receipt arrives", async (delivery) => {
  failMessage = delivery;
  await enqueue("first");
  await retryOutgoing("first");
  expect(await getOutgoing("first")).toMatchObject({ status: "failed", retryable: false, sendDispatched: true });
  const original = requests.find((body): body is SendMessageRequest => "id" in body && body.id === "first")!;
  await enqueue("later");
  await retryOutgoing("later");
  expect(await getMessageById("later")).toMatchObject({ status: "sending" });
  expect(encryptGroupText).toHaveBeenCalledTimes(1);
  const published = vi.fn();
  const unsubscribe = subscribeQueue(published);
  const stop = startOutgoingQueue();
  try {
    await vi.waitFor(() => expect(published).toHaveBeenCalled());
    await refreshOutgoingQueue();
    expect(encryptGroupText).toHaveBeenCalledTimes(1);
    await expect(discardOutgoing("first")).resolves.toBe("already-sending");
    expect(await getOutgoing("first")).toMatchObject({ status: "failed" });
    expect(await getMessageById("later")).toMatchObject({ status: "sending" });
    await retryOutgoing("first");
    await vi.waitFor(async () => expect(await getAllOutgoing()).toEqual([]));
    expect(receiveErrors).toEqual([]);
    expect(received).toEqual([
      { id: "first", content: "first" },
      { id: "later", content: "later" },
    ]);
    const retries = requests.filter((body): body is SendMessageRequest => "id" in body && body.id === "first");
    expect(retries).toEqual([original, original]);
    expect(encryptGroupText).toHaveBeenCalledTimes(2);
  } finally { stop(); unsubscribe(); }
});

it("keeps terminal 1:1 failures nonblocking and decrypts their identical late retry using skipped ratchet keys", async () => {
  conversationType = "direct";
  failMessage = "before delivery";
  await enqueue("first");
  await retryOutgoing("first");
  expect(await getOutgoing("first")).toMatchObject({ status: "failed", retryable: false, sendDispatched: true });
  await enqueue("later");
  await retryOutgoing("later");
  expect(received).toEqual([{ id: "later", content: "later" }]);
  await retryOutgoing("first");
  expect(await getAllOutgoing()).toEqual([]);
  expect(receiveErrors).toEqual([]);
  expect(received).toEqual([{ id: "later", content: "later" }, { id: "first", content: "first" }]);
  expect(requests[2]).toEqual(requests[0]);
  expect(encryptMessage).toHaveBeenCalledTimes(2);
});
