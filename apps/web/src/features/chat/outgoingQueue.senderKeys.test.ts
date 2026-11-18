import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  fromBase64Url, fromDistribution, generateX25519KeyPair,
  initSessionAsInitiator, initSessionAsResponder, randomBytes, ratchetDecrypt, ratchetEncrypt,
  senderKeyDecrypt, toBase64Url, type RatchetSession, type SenderKeyState,
} from "@e2ee-chat/crypto";
import type { SendDirectBatchRequest, SendMessageRequest } from "@e2ee-chat/shared";
import { getAllOutgoing, getAppDB, getMessageById, getOutgoing, saveQueuedMessage, type LocalOutgoing } from "../../db/index.js";
import { api } from "../../services/api.js";
import { encryptGroupMessage } from "../../lib/group-session.js";
import { encryptGroupText, encryptMessage } from "../../lib/message-processor.js";
import { useChatStore } from "../../stores/chatStore.js";
import { discardOutgoing, refreshOutgoingQueue, retryOutgoing, startOutgoingQueue, subscribeQueue } from "./outgoingQueue.js";

vi.mock("../../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ user: { id: "alice" }, device: { id: "local" }, accessToken: "token", sessionId: "session" }) } }));
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("../../lib/key-manager.js", () => ({ keysLoaded: () => true }));
vi.mock("../../lib/message-processor.js", () => ({ encryptMessage: vi.fn(), encryptGroupText: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ touchConversationInCache: vi.fn() }));

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
type SendBody = SendDirectBatchRequest | SendMessageRequest;
let directSender: RatchetSession;
let directReceiver: RatchetSession;
let conversationType: "direct" | "group";
let groupReceivers: Map<number, SenderKeyState>;
let received: { id: string; content: string }[];
let receiveErrors: unknown[];
let requests: SendBody[];
let receipts: Map<string, { envelope: string; result: { id: string; serverTimestamp: number; expiresAt: number; expiryKind: "retention" } }>;
let failDistribution: boolean;
let failMessage: "before delivery" | "after delivery" | null;
let rejectUpload: boolean;

// Exercise real Double Ratchet distribution encryption, the production group-session
// preparation/persistence, and real Sender Key encryption/decryption. Only transport
// and the message-processor adapters are replaced.
beforeEach(async () => {
  vi.resetAllMocks();
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  useChatStore.setState({ messages: new Map(), outgoingRemovalNotices: new Set() });
  conversationType = "group";
  groupReceivers = new Map(); received = []; receiveErrors = []; requests = []; receipts = new Map();
  failDistribution = false; failMessage = null; rejectUpload = false;
  const preKey = await generateX25519KeyPair();
  const secret = randomBytes(32);
  directSender = await initSessionAsInitiator(secret, preKey.publicKey);
  directReceiver = await initSessionAsResponder(secret, preKey);
  vi.mocked(encryptMessage).mockImplementation(async (_type, plaintext) => {
    const encrypted = await ratchetEncrypt(directSender, encode(plaintext));
    return { ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv), header: JSON.stringify({ ...encrypted.header, recipientDeviceId: "remote" }) };
  });
  vi.mocked(encryptGroupText).mockImplementation(async (id, plaintext) => {
    const encrypted = await encryptGroupMessage(id, encode(plaintext));
    return { ciphertext: toBase64Url(encrypted.ciphertext), iv: toBase64Url(encrypted.iv), header: JSON.stringify(encrypted.header) };
  });
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === "/api/conversations/chat") return { id: "chat", type: conversationType, members: [{ userId: "alice" }, { userId: "bob" }] } as never;
    if (path === "/api/devices/user/alice") return [{ id: "local", userId: "alice" }] as never;
    if (path === "/api/devices/user/bob") return [{ id: "remote", userId: "bob" }] as never;
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
    const id = "messages" in body ? body.messages[0].id : body.id;
    const envelope = JSON.stringify(body);
    const receipt = receipts.get(id);
    if (receipt) {
      if (receipt.envelope !== envelope) throw Object.assign(new Error("Different envelope"), { status: 409 });
      return receipt.result as never;
    }
    const distribution = body.type === "sender_key_distribution";
    if (!distribution && id === "first" && failMessage === "before delivery") {
      failMessage = null;
      throw new SyntaxError("Unparseable send response");
    }
    const result = { id, serverTimestamp: Date.now(), expiresAt: Date.now() + 60000, expiryKind: "retention" as const };
    receipts.set(id, { envelope, result });
    // The server stores opaque envelopes. Recipient errors must not affect receipts.
    try { await receive(body); } catch (error) { receiveErrors.push(error); }
    if (distribution && failDistribution) { failDistribution = false; throw new SyntaxError("Unparseable distribution response"); }
    if (!distribution && id === "first" && failMessage === "after delivery") { failMessage = null; throw new SyntaxError("Unparseable send response"); }
    return result as never;
  });
});
afterEach(() => vi.unstubAllGlobals());

async function receive(body: SendBody) {
  if ("messages" in body) {
    for (const message of body.messages) {
      const plaintext = decode(await ratchetDecrypt(directReceiver, JSON.parse(message.header), fromBase64Url(message.ciphertext), fromBase64Url(message.iv)));
      if (body.type === "sender_key_distribution") {
        const { distribution } = JSON.parse(plaintext);
        // Production receive likewise never resets an already advanced sender chain.
        if (!groupReceivers.has(distribution.senderKeyId)) groupReceivers.set(distribution.senderKeyId, fromDistribution(distribution));
      } else received.push({ id: message.id, content: plaintext });
    }
  } else {
    const header = JSON.parse(body.header);
    const receiver = groupReceivers.get(header.senderKeyId);
    if (!receiver) throw new Error("Missing sender key");
    const plaintext = await senderKeyDecrypt(receiver, header, fromBase64Url(body.ciphertext), fromBase64Url(body.iv));
    received.push({ id: body.id, content: decode(plaintext) });
  }
}

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

it.each([
  { delivery: "before delivery", resolution: "retry" }, { delivery: "after delivery", resolution: "retry" },
  { delivery: "before delivery", resolution: "discard" }, { delivery: "after delivery", resolution: "discard" },
] as const)("holds later group ciphertext after failure $delivery until $resolution", async ({ delivery, resolution }) => {
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
    if (resolution === "retry") await retryOutgoing("first");
    else await discardOutgoing("first");
    await vi.waitFor(async () => expect(await getAllOutgoing()).toEqual([]));
    expect(receiveErrors).toEqual([]);
    expect(received).toEqual([
      ...(resolution === "retry" || delivery === "after delivery" ? [{ id: "first", content: "first" }] : []),
      { id: "later", content: "later" },
    ]);
    const retries = requests.filter((body): body is SendMessageRequest => "id" in body && body.id === "first");
    expect(retries).toEqual(resolution === "retry" ? [original, original] : [original]);
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
