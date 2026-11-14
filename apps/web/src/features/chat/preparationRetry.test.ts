import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationWithMembers } from "@e2ee-chat/shared";
import { getAppDB, getOutgoing, saveQueuedMessage } from "../../db/index.js";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { retryOutgoing, startOutgoingQueue } from "./outgoingQueue.js";

vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "alice" }, device: { id: "local" }, accessToken: "token", sessionId: "session" })) };
});
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../../lib/key-manager.js", () => ({ keysLoaded: () => true }));
// Exercise both real preparation helpers, with their encryption boundary performing a key lookup.
vi.mock("../../lib/message-processor.js", () => ({
  encryptMessage: async (_type: string, _text: string, userId: string, deviceId: string) => api.get(`/api/keys/bundle/${userId}/${deviceId}`),
  encryptGroupText: async () => ({ ciphertext: "group-ciphertext", iv: "iv", header: "header" }),
}));
vi.mock("../../lib/conversation-cache.js", () => ({ touchConversationInCache: vi.fn() }));
let conversation: ConversationWithMembers;
beforeEach(async () => {
  vi.clearAllMocks();
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  useAuthStore.setState({ accessToken: "token", sessionId: "session" } as never);
  vi.mocked(api.post).mockResolvedValue({ serverTimestamp: Date.now(), expiresAt: Date.now() + 60000, expiryKind: "retention" } as never);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const failures = [
  { label: "network", error: new TypeError("Failed to fetch"), retryable: true },
  { label: "429", error: Object.assign(new Error("Rate limit exceeded"), { status: 429 }), retryable: true },
  { label: "503", error: Object.assign(new Error("Unavailable"), { status: 503 }), retryable: true },
  { label: "403", error: Object.assign(new Error("Not authorized"), { status: 403 }), retryable: false },
];
it.each(["direct", "group"] as const)("R3-F2: preserves %s key-lookup retryability through real preparation helpers", async (type) => {
  // Each class must make the same decision through both fanout and sender-key distribution.
  for (const { label, error, retryable } of failures) {
    let failing = true;
    conversation = { id: `chat-${type}-${label}`, type, members: [{ userId: "alice" }, { userId: "bob" }] } as ConversationWithMembers;
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/api/conversations/")) return conversation as never;
      if (path === "/api/devices/user/alice") return [{ id: "local", userId: "alice" }] as never;
      if (path === "/api/devices/user/bob") return [{ id: "remote", userId: "bob" }] as never;
      if (failing) throw error;
      return { ciphertext: "opaque", iv: "iv", header: "header" } as never;
    });
    const id = `send-${type}-${label}`;
    await saveQueuedMessage({ id, conversationId: conversation.id, senderId: "alice", type: "text", content: "message", timestamp: Date.now(), expiresAt: null, status: "sending" }, {
      id, queuedAt: Date.now(), userId: "alice", deviceId: "local", conversationId: conversation.id, conversationType: type,
      ttlSeconds: null, attempts: 0, status: "sending", steps: [], retryable: true, nextAttemptAt: null, error: null,
    });
    await retryOutgoing(id);
    const failed = (await getOutgoing(id))!;
    expect(failed.status, label).toBe("failed");
    expect(failed.retryable, label).toBe(retryable);
    expect(failed.nextAttemptAt, label).toEqual(retryable ? expect.any(Number) : null);
    failing = false;
    if (retryable) {
      const stop = startOutgoingQueue();
      try {
        window.dispatchEvent(new Event("online"));
        await vi.waitFor(async () => expect(await getOutgoing(id)).toBeUndefined());
      } finally { stop(); }
    }
  }
});
