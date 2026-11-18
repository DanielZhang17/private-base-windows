import { expect, it } from "vitest";
import { MAX_DELETE_BATCH_SIZE, type DecryptedMessage } from "@e2ee-chat/shared";
import { formatDateTime } from "../../i18n/format.js";
import { copySelectedMessagesText, deleteSelectionUnavailable, pruneMessageSelection, toggleMessageSelection, type MessageSelection } from "./message-selection.js";

const first: DecryptedMessage = { id: "first", conversationId: "chat", senderId: "alice", type: "text", content: "Hello",
  timestamp: 1000, status: "sent", expiresAt: 5000, expiryKind: "timed" };

it("toggles up to the shared cap and removes missing or changed revisions", () => {
  const rows = Array.from({ length: MAX_DELETE_BATCH_SIZE + 1 }, (_, i) => ({ ...first, id: `message-${i}` }));
  const chosen = rows.reduce<MessageSelection>(toggleMessageSelection, new Map());
  expect(chosen.size).toBe(MAX_DELETE_BATCH_SIZE);
  expect(chosen.has(rows.at(-1)!.id)).toBe(false);
  expect(pruneMessageSelection(chosen, rows)).toBe(chosen);
  const [edited, deleted, missing, ...other] = rows;
  const fresh = pruneMessageSelection(chosen, [{ ...edited, editSequence: 1 }, { ...deleted, deletedAt: 15 }, ...other]);
  expect([...fresh.keys()]).toEqual([...chosen.keys()].filter((id) => ![edited.id, deleted.id, missing.id].includes(id)));
  expect(toggleMessageSelection(chosen, edited).has(edited.id)).toBe(false);
});

it("copies in chronological order with localized times and safe placeholders for media and tombstones", () => {
  const file = { ...first, id: "file", senderId: "bob", type: "file" as const, timestamp: 2000, content: '{"fileKey":"secret"}' };
  const sticker = { ...first, id: "sticker", timestamp: 3000, content: "[[sticker:genshin:genshin_hoyolab_21]]" };
  const deleted = { ...first, id: "deleted", timestamp: 4000, deletedAt: 4001, content: "stale plaintext" };
  expect(copySelectedMessagesText([deleted, sticker, file, first], (id) => id === "alice" ? "Alice" : "Bob")).toBe(
    `Alice · ${formatDateTime(1000)}\nHello\n\nBob · ${formatDateTime(2000)}\n[File]\n\nAlice · ${formatDateTime(3000)}\n[Sticker]\n\nAlice · ${formatDateTime(4000)}\n[This message was deleted]`,
  );
});

it("distinguishes membership, ownership, unsent and expiration eligibility", () => {
  const outgoing = new Set<string>();
  expect(deleteSelectionUnavailable([first], "alice", true, outgoing, 4999)).toBeUndefined();
  expect(deleteSelectionUnavailable([first], "alice", false, outgoing, 4999)).toBe("messageSelectionMembership");
  expect(deleteSelectionUnavailable([first, { ...first, senderId: "bob" }], "alice", true, outgoing, 4999)).toBe("messageSelectionOwnOnly");
  expect(deleteSelectionUnavailable([{ ...first, deletedAt: 1001 }], "alice", true, outgoing, 4999)).toBe("messageSelectionDeleted");
  expect(deleteSelectionUnavailable([{ ...first, status: "sending" }], "alice", true, outgoing, 4999)).toBe("messageSelectionUnsent");
  expect(deleteSelectionUnavailable([first], "alice", true, outgoing, 5000)).toBe("messageSelectionExpired");
  expect(deleteSelectionUnavailable([{ ...first, status: "failed" }], "alice", true, outgoing, 4999)).toBe("messageSelectionUnsent");
  const failedReceive = { ...first, status: "failed" as const, content: "" };
  expect(deleteSelectionUnavailable([failedReceive], "alice", true, outgoing, 4999)).toBeUndefined();
  expect(deleteSelectionUnavailable([failedReceive], "alice", true, new Set([first.id]), 4999)).toBe("messageSelectionUnsent");
});
