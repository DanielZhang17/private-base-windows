import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {} from "vitest/jsdom";
import { getAppDB, getOutgoing, saveQueuedMessage } from "../../db/index.js";
import { useAuthStore } from "../../stores/authStore.js";
import { retryOutgoing } from "./outgoingQueue.js";
vi.hoisted(() => { Object.defineProperty(globalThis, "localStorage", { value: jsdom.window.localStorage, configurable: true }); });
vi.mock("../../lib/key-manager.js", () => ({ keysLoaded: () => true, lockLocalCryptoState: vi.fn() }));
vi.mock("../../lib/direct-messages.js", () => ({ prepareDirectPayloadFanout: vi.fn() }));
vi.mock("../../lib/group-session.js", () => ({ finishSenderKeyDistribution: vi.fn(), prepareSenderKeyDistribution: vi.fn() }));
vi.mock("../../lib/message-processor.js", () => ({ encryptGroupText: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ touchConversationInCache: vi.fn() }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(async () => {
  localStorage.clear();
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  useAuthStore.setState({ user: { id: "alice" }, device: { id: "device" }, accessToken: "expired", refreshToken: "refresh", sessionId: "session" } as never);
});
afterEach(() => vi.unstubAllGlobals());
it("F5: refreshes expired authentication before replaying a resumed encrypted file PUT", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  await saveQueuedMessage({ id: "file-message", conversationId: "chat", senderId: "alice", type: "file", content: JSON.stringify({ fileId: "", fileKey: "private", iv: "iv" }), timestamp: 1, expiresAt: null, status: "failed" }, {
    id: "file-message", queuedAt: 1, userId: "alice", deviceId: "device", conversationId: "chat", conversationType: "direct", ttlSeconds: null,
    fileId: "file", upload: { bytes, mimeType: "image/png", uploadUrl: "/api/files/upload/file" },
    steps: [{ path: "/api/messages/send-direct-batch", body: { conversationId: "chat", type: "file", fileId: "file", messages: [{ id: "file-message", ciphertext: "opaque", iv: "iv", header: "header" }] } }],
    status: "failed", attempts: 1, retryable: true, nextAttemptAt: null, error: "offline",
  });
  const fetch = vi.fn(async (path: unknown, options?: RequestInit) => {
    if (path === "/auth/refresh") return json({ accessToken: "fresh", refreshToken: "rotated" });
    const token = new Headers(options?.headers).get("Authorization");
    if (path === "/api/files/upload/file") return token === "Bearer expired" ? json({ error: "Expired" }, 401) : json({ success: true });
    return json({ serverTimestamp: 10, expiresAt: 1000, expiryKind: "retention" });
  });
  vi.stubGlobal("fetch", fetch);
  await retryOutgoing("file-message");
  expect(await getOutgoing("file-message")).toBeUndefined();
  expect(fetch.mock.calls.filter(([path]) => path === "/auth/refresh")).toHaveLength(1);
  const puts = fetch.mock.calls.filter(([path]) => path === "/api/files/upload/file");
  expect(puts.map(([, options]) => new Headers(options?.headers).get("Authorization"))).toEqual(["Bearer expired", "Bearer fresh"]);
  for (const [, options] of puts) expect(new Uint8Array(options!.body as ArrayBuffer)).toEqual(bytes);
});
