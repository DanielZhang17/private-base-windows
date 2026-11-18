import { afterEach, expect, it, vi } from "vitest";
import { getAppDB, getCachedConversationMessagesPage, saveMessage as writeOwnedMessage } from "./index.js";

const saveMessage = (row: Parameters<typeof writeOwnedMessage>[0], current?: () => boolean, ownerId = row.ownerId ?? "alice") =>
  writeOwnedMessage(row, current, ownerId);
afterEach(() => vi.restoreAllMocks());
it("reads the page and every hidden/deleted barrier in one IDB snapshot", async () => {
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  const row = { id: "deleted", conversationId: "conv", senderId: "alice", type: "file", content: JSON.stringify({ fileId: "file", fileKey: "private-key" }), timestamp: Date.now(), expiresAt: Date.now() + 60000, status: "sent" };
  await saveMessage(row); await saveMessage({ ...row, id: "hidden" });
  // Reproduce a stale legacy cache alongside newer durable barriers.
  await db.put("accountState", { id: "deleted-message:deleted", conversationId: "conv", deletedAt: 123, deletedByUserId: "alice" });
  await db.put("accountState", { id: "hidden-message:hidden" });
  const transaction = vi.spyOn(db, "transaction");
  const page = await getCachedConversationMessagesPage("conv");
  expect(page.messages).toEqual([expect.objectContaining({ id: "deleted", content: "", deletedAt: 123 })]);
  expect(JSON.stringify(page)).not.toContain("private-key");
  expect(transaction.mock.calls).toHaveLength(1);
  expect(transaction.mock.calls[0].slice(0, 2)).toEqual([["displayMessages", "accountState", "accountConversations"], "readonly"]);
});
