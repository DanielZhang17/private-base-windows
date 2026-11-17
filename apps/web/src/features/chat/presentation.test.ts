import { expect, it } from "vitest";
import type { DecryptedMessage } from "@e2ee-chat/shared";
import { fileTypeLabel, messageRun } from "./presentation.js";
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
