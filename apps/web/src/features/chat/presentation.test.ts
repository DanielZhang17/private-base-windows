import { expect, it } from "vitest";
import type { ConversationWithMembers, DecryptedMessage } from "@e2ee-chat/shared";
import { canEditMessage, chatPreview, copyableMessageText, fileTypeLabel, messageRun } from "./presentation.js";
it.each([["notes.txt", "TXT"], ["archive.longextension", "LONGE"], ["no-extension", "File"], [".hidden", "File"], ["file.", "File"]])("labels %s as %s", (name, label) => expect(fileTypeLabel(name)).toBe(label));
it("groups nearby messages by sender and calendar day, exposing only the last meta line", () => {
  const msg = (senderId: string, timestamp: number) => ({ senderId, timestamp } as DecryptedMessage);
  const messages = [msg("alice", 100), msg("alice", 200), msg("bob", 300), msg("bob", 60_300)];
  expect(messages.map((_, i) => messageRun(messages, i))).toEqual([
    { first: true, last: false }, { first: false, last: true }, { first: true, last: true }, { first: true, last: true },
  ]);
  const midnight = new Date(2026, 10, 16).getTime();
  expect(messageRun([msg("alice", midnight - 1), msg("alice", midnight)], 0).last).toBe(true);
});

it("previews pending and committed edits and only permits edits of live owned text", () => {
  const message: DecryptedMessage = { id: "mine", conversationId: "chat", senderId: "alice", type: "text", content: "old",
    editSenderDeviceId: "device", editKeyAccepted: true,
    timestamp: 1, expiresAt: Date.now() + 1000, expiryKind: "timed", status: "delivered" };
  const conversation = { type: "direct", members: [] } as unknown as ConversationWithMembers;
  expect(canEditMessage(message, "alice", "device")).toBe(true);
  expect(canEditMessage({ ...message, editKeyAccepted: undefined }, "alice", "device")).toBe(false);
  expect(canEditMessage(message, "bob", "device")).toBe(false);
  expect(canEditMessage(message, "alice", "other-device")).toBe(false);
  expect(canEditMessage({ ...message, editSenderDeviceId: undefined }, "alice", "device")).toBe(false);
  expect(canEditMessage({ ...message, type: "file" }, "alice", "device")).toBe(false);
  expect(canEditMessage({ ...message, type: "system" }, "alice", "device")).toBe(false);
  expect(canEditMessage({ ...message, deletedAt: 1 }, "alice", "device")).toBe(false);
  expect(canEditMessage({ ...message, expiresAt: 1 }, "alice", "device")).toBe(false);
  expect(chatPreview({ ...message, pendingEdit: { id: "edit", content: "pending" } }, conversation)).toBe("pending");
  expect(copyableMessageText({ ...message, pendingEdit: { id: "edit", content: "pending" } })).toBe("pending");
  expect(chatPreview({ ...message, editedAt: 3, content: "committed" }, conversation)).toBe("committed");
  expect(canEditMessage({ ...message, content: "[[sticker:genshin:genshin_hoyolab_21]]" }, "alice", "device")).toBe(false);
  expect(canEditMessage({ ...message, content: "[[sticker:genshin:genshin_hoyolab_818]]" }, "alice", "device")).toBe(true);
});

it("uses localized sticker text for previews and copy while preserving unknown tokens", () => {
  const conversation = { type: "group", members: [{ userId: "alice", user: { displayName: "Alice" } }] } as ConversationWithMembers;
  const sticker = { type: "text", senderId: "alice", status: "sent", content: "[[sticker:genshin:genshin_hoyolab_21]]" } as DecryptedMessage;
  expect(chatPreview(sticker, conversation, "bob")).toBe("Alice: Sticker");
  expect(copyableMessageText(sticker)).toBe("Sticker");
  expect(chatPreview({ ...sticker, status: "failed" }, conversation, "alice")).toBe("Not sent: Sticker");
  const unknown = { ...sticker, content: "[[sticker:genshin:genshin_hoyolab_818]]" };
  expect(copyableMessageText(unknown)).toBe(unknown.content);
});
