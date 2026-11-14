import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupExpiredMessages, getAppDB, getAllOutgoing, getMessageById, saveMessage, getOutgoing, saveQueuedMessage, updateOutgoingIfPresent, type LocalOutgoing } from "../../db/index.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { api } from "../../services/api.js";
import { prepareDirectPayloadFanout } from "../../lib/direct-messages.js";
import { prepareSenderKeyDistribution, finishSenderKeyDistribution } from "../../lib/group-session.js";
import { encryptGroupText } from "../../lib/message-processor.js";
import { discardOutgoing, getQueueSnapshot, refreshOutgoingQueue, retryOutgoing, startOutgoingQueue } from "./outgoingQueue.js";

vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: null, device: null, accessToken: null, sessionId: null })) };
});
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() }, resolveApiUrl: (path: string) => path }));
vi.mock("../../lib/key-manager.js", () => ({ keysLoaded: () => true }));
vi.mock("../../lib/direct-messages.js", () => ({ prepareDirectPayloadFanout: vi.fn() }));
vi.mock("../../lib/message-processor.js", () => ({ encryptGroupText: vi.fn() }));
vi.mock("../../lib/group-session.js", () => ({ prepareSenderKeyDistribution: vi.fn(async () => null), finishSenderKeyDistribution: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ touchConversationInCache: vi.fn() }));

const body = { conversationId: "chat", type: "text", ttlSeconds: null, fileId: null, messages: [{ id: "message", ciphertext: "ciphertext", iv: "iv", header: "header" }] };
const response = { id: "message", serverTimestamp: 123, expiresAt: 999999, expiryKind: "retention" };
const networkError = () => new TypeError("Failed to fetch");
async function seed(overrides: Partial<LocalOutgoing> = {}) {
  await saveQueuedMessage({ id: "message", conversationId: "chat", senderId: "alice", type: "text", content: "private text", timestamp: Date.now(), expiresAt: Date.now() + 60000, expiryKind: "retention", status: "sending" }, {
    id: "message", queuedAt: 1, conversationId: "chat", conversationType: "direct", userId: "alice", deviceId: "device", ttlSeconds: null, attempts: 0,
    status: "sending", retryable: true, error: null, nextAttemptAt: null, steps: [], ...overrides,
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  useAuthStore.setState({ user: { id: "alice" }, device: { id: "device" }, accessToken: "token", sessionId: "session" } as never);
  useChatStore.setState({ messages: new Map(), outgoingRemovalNotices: new Set() });
  vi.mocked(api.get).mockResolvedValue({ id: "chat", type: "direct", members: [] } as never);
  vi.mocked(prepareDirectPayloadFanout).mockResolvedValue(body as never);
  vi.mocked(prepareSenderKeyDistribution).mockResolvedValue(null);
  vi.mocked(encryptGroupText).mockResolvedValue({ ciphertext: "group-ciphertext", iv: "iv", header: "header" });
  vi.mocked(api.post).mockResolvedValue(response as never);
  vi.mocked(api.put).mockResolvedValue({ success: true } as never);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([0, 429, 503])("keeps a failed %s send durably and reuses its ciphertext on retry", async (status) => {
  await seed();
  vi.mocked(api.post).mockRejectedValueOnce(status ? Object.assign(new Error("Rate limit exceeded"), { status }) : networkError());
  await retryOutgoing("message");
  const failed = await getOutgoing("message");
  expect(failed).toMatchObject({ status: "failed", retryable: true, attempts: 1, error: status ? "errorRateLimitExceeded" : "errorFailedToFetch" });
  expect(failed!.nextAttemptAt! - Date.now()).toBeGreaterThan(1500);
  expect(await getMessageById("message")).toMatchObject({ status: "failed", content: "private text" });
  expect(JSON.stringify(failed)).not.toContain("private text");
  await retryOutgoing("message");
  expect(prepareDirectPayloadFanout).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.post).mock.calls).toEqual([["/api/messages/send-direct-batch", body], ["/api/messages/send-direct-batch", body]]);
  expect(await getAllOutgoing()).toEqual([]);
  expect(await getMessageById("message")).toMatchObject({ status: "sent", timestamp: 123 });
});

it("uses 2s, 5s, 15s, 60s backoff, and restores queued envelopes after reload", async () => {
  await seed({ steps: [{ path: "/api/messages/send-direct-batch", body: body as never }] });
  vi.mocked(api.post).mockRejectedValue(networkError());
  for (const delay of [2000, 5000, 15000, 60000, 60000]) {
    const before = Date.now();
    await retryOutgoing("message");
    expect((await getOutgoing("message"))!.nextAttemptAt).toBeGreaterThanOrEqual(before + delay);
  }
  expect(prepareDirectPayloadFanout).not.toHaveBeenCalled();
  vi.mocked(api.post).mockResolvedValue(response as never);
  const stop = startOutgoingQueue();
  window.dispatchEvent(new Event("online"));
  await vi.waitFor(async () => expect(await getOutgoing("message")).toBeUndefined());
  stop();
});

it("automatically retries at its persisted due time", async () => {
  await seed({ steps: [{ path: "/api/messages/send-direct-batch", body: body as never }], status: "failed", nextAttemptAt: Date.now() + 2000 });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const stop = startOutgoingQueue();
  await refreshOutgoingQueue();
  await vi.advanceTimersByTimeAsync(1999);
  expect(api.post).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  // IndexedDB uses real tasks; waitFor's interval remains real here.
  await vi.waitFor(async () => expect(await getOutgoing("message")).toBeUndefined());
  stop();
});

it("keeps non-retryable 4xx failures visible until manual discard", async () => {
  await seed();
  vi.mocked(api.post).mockRejectedValue(Object.assign(new Error("Not a member"), { status: 403 }));
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ retryable: false, status: "failed", nextAttemptAt: null, error: "errorNotAMember" });
  const stop = startOutgoingQueue();
  window.dispatchEvent(new Event("online"));
  await refreshOutgoingQueue();
  expect(api.post).toHaveBeenCalledTimes(1);
  await discardOutgoing("message");
  expect(await getOutgoing("message")).toBeUndefined();
  expect(await getMessageById("message")).toBeUndefined();
  stop();
});

it("F2-client: replays a group POST for a server receipt without advancing the sender key again", async () => {
  await seed({ conversationType: "group" });
  vi.mocked(api.post).mockRejectedValueOnce(networkError());
  await retryOutgoing("message");
  vi.mocked(api.get).mockResolvedValue({ messages: [{ ...response, senderDeviceId: "device" }], hasMore: false } as never);
  await retryOutgoing("message");
  expect(encryptGroupText).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(await getOutgoing("message")).toBeUndefined();
  expect(await getMessageById("message")).toMatchObject({ status: "sent" });
});

it("checks upload HTTP errors and retains encrypted upload bytes for retry", async () => {
  await seed({ upload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", uploadUrl: "/upload" } });
  vi.mocked(api.put).mockRejectedValueOnce(Object.assign(new Error("File upload failed (503)"), { status: 503 }));
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: true, error: "messageNotSent" });
  expect(api.post).not.toHaveBeenCalled();
  await retryOutgoing("message");
  expect(new Uint8Array(vi.mocked(api.put).mock.calls[1][1] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  expect(await getOutgoing("message")).toBeUndefined();
});

it("does not replay another user's pending messages or commit results after logout", async () => {
  await seed({ userId: "bob" });
  await retryOutgoing("message");
  expect(api.post).not.toHaveBeenCalled();
  await seed();
  vi.mocked(api.post).mockImplementation(async () => {
    useAuthStore.setState({ accessToken: null });
    return response as never;
  });
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toBeDefined();
  expect(await getMessageById("message")).toMatchObject({ status: "sending" });
});

it("keeps later group sends behind a failed send so Sender Keys are received in order", async () => {
  await seed({ conversationType: "group" });
  const first = (await getOutgoing("message"))!;
  const message = (await getMessageById("message"))!;
  await saveQueuedMessage({ ...message, id: "second", content: "second private text" }, { ...first, id: "second", queuedAt: 2 });
  let reject!: (reason: unknown) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  const sending = retryOutgoing("message");
  await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  await retryOutgoing("second");
  expect(encryptGroupText).toHaveBeenCalledTimes(1);
  reject(networkError());
  await sending;
  await retryOutgoing("second");
  expect(encryptGroupText).toHaveBeenCalledTimes(1);
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false } as never);
  await retryOutgoing("message");
  await retryOutgoing("second");
  expect(encryptGroupText).toHaveBeenCalledTimes(2);
  expect(await getAllOutgoing()).toEqual([]);
});

it("turns a file whose encryption was interrupted by reload into a visible failed send", async () => {
  await seed({ retryable: false, error: "File encryption was interrupted. Attach the file again." });
  const stop = startOutgoingQueue();
  await vi.waitFor(async () => expect(await getOutgoing("message")).toMatchObject({ status: "failed" }));
  expect(await getMessageById("message")).toMatchObject({ status: "failed" });
  expect(api.post).not.toHaveBeenCalled();
  stop();
});

it.each(["while waiting for the lock", "after reading the display row"])("keeps file encryption completed in another tab %s", async (interleaving) => {
  await seed({ retryable: false, error: "fileEncryptionWasInterruptedAttachTheFileAgain" });
  await saveMessage({ ...(await getMessageById("message"))!, type: "file" });
  await refreshOutgoingQueue();
  const initial = (await getOutgoing("message"))!;
  const bytes = new Uint8Array([4, 5, 6]);
  const ready = { ...initial, upload: { bytes, mimeType: "image/png" }, retryable: true, error: null, nextAttemptAt: Date.now() + 60000 };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const request = vi.fn(async (_name: string, action: () => Promise<void>) => { await held; await action(); });
  vi.stubGlobal("navigator", { locks: { request } });
  const db = await getAppDB();
  const get = db.get.bind(db);
  let updated = false;
  const read = vi.spyOn(db, "get").mockImplementation(async (store, key) => {
    const value = await get(store, key);
    if (interleaving === "after reading the display row" && store === "messages" && key === "message" && !updated) {
      updated = true;
      await updateOutgoingIfPresent(ready);
    }
    return value;
  });
  const stop = startOutgoingQueue();
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    if (interleaving === "while waiting for the lock") await updateOutgoingIfPresent(ready);
    release();
    await vi.waitFor(() => {
      const row = getQueueSnapshot().find((entry) => entry.id === "message");
      expect(row?.status === "failed" || !!row?.upload).toBe(true);
    });
    const persisted = await getOutgoing("message");
    expect(persisted).toMatchObject({ upload: { mimeType: "image/png" }, retryable: true, error: null, status: "sending" });
    expect(Array.from(persisted?.upload?.bytes ?? [])).toEqual(Array.from(bytes));
    expect(await getMessageById("message")).toMatchObject({ status: "sending" });
    expect(api.post).not.toHaveBeenCalled();
  } finally { release(); stop(); read.mockRestore(); }
});

it("does not overwrite another tab's prepared envelope after a metadata lookup fails", async () => {
  await seed();
  const newer = { ...body, messages: [{ ...body.messages[0], ciphertext: "newer-ciphertext" }] };
  vi.mocked(api.get).mockImplementationOnce(async () => {
    const current = (await getOutgoing("message"))!;
    await updateOutgoingIfPresent({ ...current, steps: [{ path: "/api/messages/send-direct-batch", body: newer as never }], nextAttemptAt: Date.now() + 60000 });
    throw networkError();
  });
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ steps: [{ body: newer }], error: null, status: "sending", retryable: true });
  expect(api.post).not.toHaveBeenCalled();
});

it("does not delete another tab's newer outbox progress after a send receipt arrives", async () => {
  await seed({ steps: [{ path: "/api/messages/send-direct-batch", body: body as never }] });
  const newer = { ...body, messages: [{ ...body.messages[0], ciphertext: "newer-ciphertext" }] };
  vi.mocked(api.post).mockImplementationOnce(async () => {
    const current = (await getOutgoing("message"))!;
    await updateOutgoingIfPresent({ ...current, steps: [{ path: "/api/messages/send-direct-batch", body: newer as never }], nextAttemptAt: Date.now() + 60000 });
    return response as never;
  });
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ steps: [{ body: newer }], retryable: true });
  expect(await getMessageById("message")).toMatchObject({ status: "sending" });
});

it("replays the same sender-key distribution before its already encrypted group message", async () => {
  await seed({ conversationType: "group" });
  const distribution = { path: "/api/messages/send-direct-batch", body: { conversationId: "chat", type: "sender_key_distribution", messages: [{ id: "distribution", ciphertext: "encrypted-distribution", iv: "iv", header: "header" }] }, distributed: { senderDeviceId: "device", senderKeyId: 1, recipientDeviceIds: ["peer"] } } as const;
  vi.mocked(prepareSenderKeyDistribution).mockResolvedValue(distribution as never);
  vi.mocked(api.post).mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { status: 503 }));
  await retryOutgoing("message");
  expect((await getOutgoing("message"))!.steps).toHaveLength(2);
  vi.mocked(api.get).mockResolvedValue({ messages: [], hasMore: false } as never);
  await retryOutgoing("message");
  expect(prepareSenderKeyDistribution).toHaveBeenCalledTimes(1);
  expect(encryptGroupText).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
  expect(vi.mocked(api.post).mock.calls[2][0]).toBe("/api/messages/send");
  expect(finishSenderKeyDistribution).toHaveBeenCalledTimes(1);
  expect(await getAllOutgoing()).toEqual([]);
});

it("keeps a queued timed message through retention cleanup until the server accepts it", async () => {
  await seed({ ttlSeconds: 30, status: "failed", nextAttemptAt: Date.now() + 60000 });
  const message = (await getMessageById("message"))!;
  // Queued offline for longer than its optimistic TTL.
  await saveQueuedMessage({ ...message, expiryKind: "timed", expiresAt: Date.now() - 1000, status: "failed" }, (await getOutgoing("message"))!);
  expect(await cleanupExpiredMessages()).toEqual([]);
  expect(await getMessageById("message")).toMatchObject({ content: "private text" });
  await retryOutgoing("message");
  expect(api.post).toHaveBeenCalledWith("/api/messages/send-direct-batch", body);
  expect(await getOutgoing("message")).toBeUndefined();
  // The server's expiry replaces the estimate; ordinary retention applies again once it is sent.
  expect(await getMessageById("message")).toMatchObject({ status: "sent", expiresAt: response.expiresAt });
  expect(await cleanupExpiredMessages(response.expiresAt + 1)).toEqual(["message"]);
});

it.each(["text", "file"])("delivers queued %s after legacy cleanup deletes only its display row", async (type) => {
  const bytes = new Uint8Array([1, 2, 3]);
  const prepared = { ...body, type, ttlSeconds: 30, ...(type === "file" ? { fileId: "file-1" } : {}) };
  await seed({
    ttlSeconds: 30, steps: [{ path: "/api/messages/send-direct-batch", body: prepared as never }],
    ...(type === "file" ? { fileId: "file-1", upload: { bytes, mimeType: "image/png", uploadUrl: "/upload" } } : {}),
  });
  // A v5 tab's cleanup does not know about syncState's outgoing: entries.
  await (await getAppDB()).delete("messages", "message");
  vi.mocked(api.post).mockRejectedValue(networkError());
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toMatchObject({ status: "failed", retryable: true, attempts: 1 });
  expect(await getMessageById("message")).toBeUndefined();
  expect(useChatStore.getState().messages.get("chat")).toBeUndefined();
  vi.mocked(api.post).mockResolvedValue(response as never);
  await retryOutgoing("message");
  expect(vi.mocked(api.post).mock.calls).toEqual([
    ["/api/messages/send-direct-batch", prepared], ["/api/messages/send-direct-batch", prepared],
  ]);
  if (type === "file") expect(api.put).toHaveBeenCalledExactlyOnceWith("/upload", bytes.buffer);
  expect(prepareDirectPayloadFanout).not.toHaveBeenCalled();
  expect(await getOutgoing("message")).toBeUndefined();
  expect(await getMessageById("message")).toBeUndefined();
  expect(useChatStore.getState().messages.get("chat")).toBeUndefined();
  expect(useChatStore.getState().outgoingRemovalNotices.size).toBe(0);
});

it.each(["needs encryption", "non-retryable", "expired PUT", "expired reservation"])("retires an orphan that is %s and delivers the next message", async (reason) => {
  const prepared = { ...body, type: "file", fileId: "expired" };
  await seed({
    fileId: "expired", upload: { bytes: new Uint8Array([1, 2]), mimeType: "image/png", uploadUrl: "/expired", uploaded: reason !== "expired PUT" },
    steps: reason === "needs encryption" ? [] : [{ path: "/api/messages/send-direct-batch", body: prepared as never }],
    retryable: reason !== "non-retryable", status: "failed",
  });
  const second = { ...body, messages: [{ ...body.messages[0], id: "second" }] };
  await saveQueuedMessage({ ...(await getMessageById("message"))!, id: "second" }, {
    ...(await getOutgoing("message"))!, id: "second", queuedAt: 2, status: "sending", retryable: true,
    fileId: undefined, upload: undefined, steps: [{ path: "/api/messages/send-direct-batch", body: second as never }],
  });
  await (await getAppDB()).delete("messages", "message");
  if (reason === "expired PUT") vi.mocked(api.put).mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
  if (reason === "expired reservation") vi.mocked(api.post).mockImplementation(async (_path, payload) => {
    if ((payload as typeof prepared).fileId) throw Object.assign(new Error("File not found"), { status: 404 });
    return response as never;
  });
  const stop = startOutgoingQueue();
  try {
    await vi.waitFor(async () => expect(await getAllOutgoing()).toEqual([]));
    expect(api.post).toHaveBeenCalledWith("/api/messages/send-direct-batch", second);
    expect(await getMessageById("message")).toBeUndefined();
    expect(await getMessageById("second")).toMatchObject({ status: "sent" });
    expect(useChatStore.getState().outgoingRemovalNotices).toEqual(new Set(["chat"]));
    expect(prepareDirectPayloadFanout).not.toHaveBeenCalled();
  } finally { stop(); }
});

it("retires a non-retryable orphan before a manual send checks conversation ordering", async () => {
  await seed({ retryable: false, status: "failed" });
  await saveQueuedMessage({ ...(await getMessageById("message"))!, id: "second" }, {
    ...(await getOutgoing("message"))!, id: "second", queuedAt: 2, retryable: true,
  });
  await (await getAppDB()).delete("messages", "message");
  await retryOutgoing("second");
  expect(await getAllOutgoing()).toEqual([]);
  expect(await getMessageById("second")).toMatchObject({ status: "sent" });
  expect(useChatStore.getState().outgoingRemovalNotices).toEqual(new Set(["chat"]));
});

it("does not retire an earlier in-flight orphan waiting on metadata without Web Locks", async () => {
  vi.stubGlobal("navigator", {});
  await seed();
  await saveQueuedMessage({ ...(await getMessageById("message"))!, id: "second" }, {
    ...(await getOutgoing("message"))!, id: "second", queuedAt: 2,
  });
  let finishLookup!: (value: never) => void;
  vi.mocked(api.get).mockReturnValueOnce(new Promise((resolve) => { finishLookup = resolve; }));
  vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (_conversation, id) => ({
    ...body, messages: [{ ...body.messages[0], id }],
  }) as never);
  const sending = retryOutgoing("message");
  try {
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    // The active attempt still holds the content needed to finish encryption.
    await (await getAppDB()).delete("messages", "message");
    await retryOutgoing("second");
    expect.soft(await getOutgoing("message")).toMatchObject({ status: "sending", steps: [] });
    expect.soft(await getOutgoing("second")).toMatchObject({ attempts: 0 });
    expect.soft(api.post).not.toHaveBeenCalled();
    expect.soft(useChatStore.getState().outgoingRemovalNotices.size).toBe(0);
  } finally {
    finishLookup({ id: "chat", type: "direct", members: [] } as never);
    await sending;
  }
  expect(await getMessageById("message")).toMatchObject({ status: "sent" });
  await retryOutgoing("second");
  expect(vi.mocked(api.post).mock.calls.map(([, payload]) => (payload as typeof body).messages[0].id)).toEqual(["message", "second"]);
  expect(await getAllOutgoing()).toEqual([]);
});

it("publishes a file id to the display record only once the upload is attached to an accepted message", async () => {
  const content = (fileId: string) => JSON.stringify({ fileId, fileName: "photo.png", mimeType: "image/png", size: 3, fileKey: "key", iv: "iv" });
  await seed({ upload: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" } });
  await saveQueuedMessage({ ...(await getMessageById("message"))!, type: "file", content: content("") }, (await getOutgoing("message"))!);
  let finishUpload!: (value: never) => void;
  vi.mocked(api.put).mockReturnValueOnce(new Promise((resolve) => { finishUpload = resolve; }));
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/files/upload-url" ? { fileId: "file-1", uploadUrl: "/upload" } : response) as never);
  const displayed = () => useChatStore.getState().messages.get("chat")?.find((entry) => entry.id === "message");
  const sending = retryOutgoing("message");
  await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  // FilePreview loads as soon as it sees a file id, and the server refuses unattached files.
  expect(displayed()).toMatchObject({ status: "sending", content: content("") });
  expect((await getMessageById("message"))!.content).toBe(content(""));
  expect(await getOutgoing("message")).toMatchObject({ fileId: "file-1" });
  finishUpload({ success: true } as never);
  await sending;
  expect(vi.mocked(prepareDirectPayloadFanout).mock.calls[0].slice(2)).toEqual([content("file-1"), "file", { ttlSeconds: null, fileId: "file-1" }]);
  expect(displayed()).toMatchObject({ status: "sent", content: content("file-1") });
  expect((await getMessageById("message"))!.content).toBe(content("file-1"));
});

it("F3: retains uploaded ciphertext through a lost send response and renews an expired reservation after reload", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  await seed({ upload: { bytes, mimeType: "image/png", uploadUrl: "/old-upload" }, fileId: "old-file" });
  await saveQueuedMessage({ ...(await getMessageById("message"))!, type: "file", content: JSON.stringify({ fileId: "", fileKey: "secret", iv: "iv" }) }, (await getOutgoing("message"))!);
  // Also supply the old raw PUT path so reverting the fix fails on lost bytes, not a mock mismatch.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  vi.mocked(api.post).mockRejectedValueOnce(networkError());
  await retryOutgoing("message");
  expect(Array.from((await getOutgoing("message"))?.upload?.bytes ?? [])).toEqual(Array.from(bytes));
  expect((await getOutgoing("message"))?.upload?.uploaded).toBe(true);
  // Simulate server cleanup of the unattached upload while the browser was closed.
  vi.mocked(api.post).mockImplementation(async (path, payload) => {
    if (path === "/api/files/upload-url") return { fileId: "new-file", uploadUrl: "/new-upload" } as never;
    if ((payload as { fileId?: string }).fileId === "old-file") throw Object.assign(new Error("File not found"), { status: 404 });
    return response as never;
  });
  vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (_conversation, id, _text, type, options) => ({ ...body, type, fileId: options?.fileId, messages: [{ ...body.messages[0], id }] }) as never);
  // The previously prepared envelope uses the old reservation, as a restored queue would.
  const restored = (await getOutgoing("message"))!;
  restored.steps[0].body.fileId = "old-file";
  const { saveOutgoing } = await import("../../db/index.js");
  await saveOutgoing(restored);
  await retryOutgoing("message");
  expect(vi.mocked(api.put).mock.calls.map(([path]) => path)).toEqual(["/old-upload", "/new-upload"]);
  for (const [, buffer] of vi.mocked(api.put).mock.calls) expect(new Uint8Array(buffer as ArrayBuffer)).toEqual(bytes);
  expect(await getOutgoing("message")).toBeUndefined();
  expect(JSON.parse((await getMessageById("message"))!.content).fileId).toBe("new-file");
});

it("F3: renews a reservation when a resumed PUT returns 404", async () => {
  await seed({ upload: { bytes: new Uint8Array([4, 5]), mimeType: "image/png", uploadUrl: "/expired" }, fileId: "expired" });
  vi.mocked(api.put).mockRejectedValueOnce(Object.assign(new Error("Not found"), { status: 404 }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/files/upload-url" ? { fileId: "renewed", uploadUrl: "/renewed" } : response) as never);
  await retryOutgoing("message");
  expect(await getOutgoing("message")).toBeUndefined();
  expect(api.put).toHaveBeenCalledWith("/renewed", new Uint8Array([4, 5]).buffer);
});

it("F4: discard waits on the same conversation lock as a retry in another tab", async () => {
  await seed();
  const tails = new Map<string, Promise<unknown>>();
  const request = vi.fn((name: string, callback: () => Promise<unknown>) => {
    const task = (tails.get(name) ?? Promise.resolve()).then(callback);
    tails.set(name, task.catch(() => undefined));
    return task;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  let reject!: (error: unknown) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  const sending = retryOutgoing("message");
  await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  vi.resetModules();
  const otherTab = await import("./outgoingQueue.js");
  const discarding = otherTab.discardOutgoing("message");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const before = await getOutgoing("message");
  reject(networkError());
  await sending;
  await discarding;
  expect(before).toBeDefined();
  expect(request.mock.calls.map(([name]) => name)).toEqual(["e2ee-outgoing:alice:device:chat", "e2ee-outgoing:alice:device:chat"]);
  expect(await getOutgoing("message")).toBeUndefined();
});

it("F4: a failed attempt cannot recreate an entry deleted by another tab without Web Locks", async () => {
  vi.stubGlobal("navigator", {});
  await seed();
  let reject!: (error: unknown) => void;
  vi.mocked(api.post).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  const sending = retryOutgoing("message");
  await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  vi.resetModules();
  const otherTab = await import("./outgoingQueue.js");
  await otherTab.discardOutgoing("message");
  reject(networkError());
  await sending;
  expect(await getOutgoing("message")).toBeUndefined();
  expect(await getMessageById("message")).toBeUndefined();
});

it("R3-F3: a pending file PUT does not block text sends in another conversation", async () => {
  await seed({ upload: { bytes: new Uint8Array([1, 2]), mimeType: "image/png", uploadUrl: "/slow-upload" }, fileId: "file" });
  let finishUpload!: (value: never) => void;
  vi.mocked(api.put).mockReturnValueOnce(new Promise((resolve) => { finishUpload = resolve; }));
  const sendingFile = retryOutgoing("message");
  await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  const first = (await getOutgoing("message"))!;
  const message = (await getMessageById("message"))!;
  await saveQueuedMessage({ ...message, id: "other-text", conversationId: "other", content: "other text" }, {
    ...first, id: "other-text", queuedAt: 2, conversationId: "other", upload: undefined, fileId: undefined,
  });
  vi.mocked(api.get).mockImplementation(async (path) => ({ id: path.endsWith("/other") ? "other" : "chat", type: "direct", members: [] }) as never);
  vi.mocked(prepareDirectPayloadFanout).mockImplementation(async (conversation, id) => ({ ...body, conversationId: conversation.id, messages: [{ ...body.messages[0], id }] }) as never);
  const sendingText = retryOutgoing("other-text");
  try {
    await vi.waitFor(async () => expect(await getOutgoing("other-text")).toBeUndefined());
    expect(await getOutgoing("message")).toBeDefined();
    expect(api.post).toHaveBeenCalledWith("/api/messages/send-direct-batch", expect.objectContaining({ conversationId: "other" }));
  } finally {
    finishUpload({ success: true } as never);
    await Promise.all([sendingFile, sendingText]);
  }
});

it("repairs a legacy localized interrupted-file error without loading its locale", async () => {
  await seed({ retryable: false, status: "failed", error: "Die Dateiverschlüsselung wurde unterbrochen. Hängen Sie die Datei erneut an." });
  const message = (await getMessageById("message"))!;
  await saveMessage({ ...message, type: "file" });
  await refreshOutgoingQueue();
  expect((await getOutgoing("message"))!.error).toBe("fileEncryptionWasInterruptedAttachTheFileAgain");
});

it("normalizes a legacy error without overwriting newer queue progress", async () => {
  await seed({ error: "old diagnostic" });
  const { updateOutgoingErrorIfUnchanged, updateOutgoingIfPresent } = await import("../../db/index.js");
  const row = (await getOutgoing("message"))!;
  await updateOutgoingIfPresent({ ...row, attempts: 3, steps: [{ path: "/api/messages/send-direct-batch", body: body as never }] });
  await updateOutgoingErrorIfUnchanged("message", "old diagnostic", "messageNotSent");
  expect(await getOutgoing("message")).toMatchObject({ attempts: 3, error: "messageNotSent", steps: [{ path: "/api/messages/send-direct-batch" }] });
  await updateOutgoingErrorIfUnchanged("message", "old diagnostic", "fileExpired");
  expect((await getOutgoing("message"))!.error).toBe("messageNotSent");
});
