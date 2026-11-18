import { beforeEach, expect, it, vi } from "vitest";
import { deleteOutgoing, getAppDB, getCachedConversationMessagesPage, getMessageById, guardMessageForPublish, saveMessage as writeOwnedMessage, saveQueuedMessage, type LocalMessage } from "../../db/index.js";
import { loadOlderPersistedConversationMessages, loadPersistedConversationMessages, resetMessageSyncState } from "../../lib/message-sync.js";
import { useChatStore } from "../../stores/chatStore.js";

const saveMessage = (row: Parameters<typeof writeOwnedMessage>[0], current?: () => boolean, ownerId = row.ownerId ?? "alice") =>
  writeOwnedMessage(row, current, ownerId);
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn() } }));
vi.mock("../../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ user: { id: "alice" }, device: { id: "device" } }) } }));
vi.mock("../../lib/message-processor.js", () => ({ decryptMessage: vi.fn(), decryptGroupText: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ getCachedConversation: vi.fn(), ensureConversationInCache: vi.fn(), touchConversationInCache: vi.fn() }));
beforeEach(async () => {
  resetMessageSyncState();
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  useChatStore.setState({ messages: new Map() });
});
async function queue(status: "sending" | "failed") {
  const message: LocalMessage = {
    id: "queued", conversationId: "chat", senderId: "alice", type: "text", content: "Pending timed message",
    timestamp: Date.now() - 120000, expiresAt: Date.now() - 60000, expiryKind: "timed", status,
  };
  await saveQueuedMessage(message, {
    id: message.id, queuedAt: message.timestamp, conversationId: "chat", conversationType: "direct", userId: "alice", deviceId: "device", ttlSeconds: 60,
    attempts: 1, status, retryable: status === "sending", nextAttemptAt: status === "sending" ? Date.now() + 60000 : null, error: status === "failed" ? "Not a member" : null, steps: [],
  });
  // An expired failed row without an outbox entry must not get the same exception, even if it
  // was previously saved with a stale read-time annotation.
  await saveMessage({ ...message, id: "not-queued", hasOutgoingEntry: true, status: "failed" });
  return message;
}
it.each(["sending", "failed"] as const)("R3-F4: restores an overdue queued timed message as %s after reload", async (status) => {
  const message = await queue(status);
  expect(await getMessageById(message.id)).toMatchObject({ expiresAt: message.expiresAt, status });
  await loadPersistedConversationMessages("chat");
  expect(useChatStore.getState().messages.get("chat")).toMatchObject([{ id: "queued", content: "Pending timed message", status }]);
  expect(useChatStore.getState().messages.get("chat")).toHaveLength(1);
});
it("R3-F4: keeps the queued-expiry exception when loading older cached history", async () => {
  await queue("failed");
  const recent = { id: "recent", conversationId: "chat", senderId: "alice", type: "text" as const, content: "recent", timestamp: Date.now(), expiresAt: Date.now() + 60000, expiryKind: "timed" as const, status: "sent" as const };
  const recentIds = Array.from({ length: 100 }, (_, index) => `recent-${String(index).padStart(3, "0")}`);
  await Promise.all(recentIds.map((id, index) => saveMessage({ ...recent, id, timestamp: recent.timestamp + index })));
  await loadPersistedConversationMessages("chat");
  const page = await loadOlderPersistedConversationMessages("chat");
  expect(page.loadedCount).toBe(1);
  expect(useChatStore.getState().messages.get("chat")?.map((message) => message.id)).toEqual(["queued", ...recentIds]);
});
it("rechecks expiry eligibility if a queued entry was removed after reading the preview", async () => {
  await queue("failed");
  const { messages: [preview] } = await getCachedConversationMessagesPage("chat", { limit: 1, ownerId: "alice" });
  expect(preview).toMatchObject({ id: "queued", hasOutgoingEntry: true });
  await deleteOutgoing(preview.id);
  expect(await guardMessageForPublish(preview)).toMatchObject({ id: "queued", hasOutgoingEntry: false });
});
