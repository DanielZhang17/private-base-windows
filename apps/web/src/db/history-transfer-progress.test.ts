// @vitest-environment node
import { expect, it } from "vitest";
import { HISTORY_TRANSFER_VERSION } from "@e2ee-chat/shared";
import { getAppDB } from "./index.js";
import {
  checkpointForManifest, claimHistoryTransferLease, clearHistoryTransferCheckpoint, completeHistoryTransferChat, listInterruptedHistoryTransfers,
  loadHistoryTransferCheckpoint, recordHistoryTransferAdditions, releaseHistoryTransferLease, saveHistoryTransferCheckpoint,
} from "./history-transfer-progress.js";

it("stores only scoped progress, recovers unfinished chats after restart, and expires after seven days or Stop", async () => {
  const now = Date.now();
  const first = { id: "first", messages: 1, bytes: 200, attachmentBytes: 0, name: "Sensitive chat label", missingFiles: ["Private photo"] };
  const second = { ...first, id: "second", missingFiles: undefined };
  const scope = { userId: "alice", deviceId: "local", role: "receiver", secret: "ephemeral secret" } as const;
  const manifest = { v: HISTORY_TRANSFER_VERSION, bytes: 400, copyDownloadedFiles: true, chats: [first, second] } as const;
  const progress = checkpointForManifest({ ...manifest, chats: [...manifest.chats] });
  const checkpoint = { ...progress, completedChatIds: ["first"], bytes: 200 };
  await saveHistoryTransferCheckpoint(scope, "peer", checkpoint, () => true, now);
  const stored = await (await getAppDB()).getAll("accountState");
  expect(JSON.stringify(stored)).not.toMatch(/Sensitive chat label|Private photo|ephemeral secret/);
  expect(await loadHistoryTransferCheckpoint(scope, "peer")).toEqual(checkpoint);
  expect(await listInterruptedHistoryTransfers({ ...scope, userId: "bob" })).toEqual([]);
  expect(await listInterruptedHistoryTransfers({ ...scope, role: "sender" })).toEqual([]);
  const next = checkpointForManifest({ ...manifest, bytes: 200, chats: [second] }, checkpoint);
  expect(next).toMatchObject({ completedChatIds: ["first"], copyDownloadedFiles: true });
  expect(next.chats.find(({ id }) => id === "first")?.missingFileCount).toBe(1);
  expect(next.chats.filter(({ id }) => !next.completedChatIds.includes(id)).map(({ id }) => id)).toEqual(["second"]);
  expect(await listInterruptedHistoryTransfers(scope, now + 7 * 24 * 60 * 60_000)).toEqual([]);
  expect(await loadHistoryTransferCheckpoint(scope, "peer")).toBeUndefined();
  await saveHistoryTransferCheckpoint(scope, "peer", checkpoint, () => true);
  await clearHistoryTransferCheckpoint(scope, "peer");
  expect(await loadHistoryTransferCheckpoint(scope, "peer")).toBeUndefined();
});

it("allows one active room per account and device pair and fences a stale tab after takeover", async () => {
  const { claimHistoryTransferLease, renewHistoryTransferLease, releaseHistoryTransferLease } = await import("./history-transfer-progress.js");
  const scope = { userId: "alice", deviceId: "local", role: "sender" } as const;
  const now = Date.now();
  const first = { chats: [{ id: "one", messages: 1, bytes: 10, attachmentBytes: 0 }],
    completedChatIds: ["one"], bytes: 10, copyDownloadedFiles: false };
  const next = { ...first, completedChatIds: [], bytes: 0 };
  const [lease, concurrent] = await Promise.all([
    claimHistoryTransferLease(scope, "lease-peer", now), claimHistoryTransferLease({ ...scope, role: "receiver" }, "lease-peer", now),
  ]);
  expect(lease).toBeDefined();
  expect(concurrent).toBeUndefined();
  await saveHistoryTransferCheckpoint(scope, "lease-peer", first, () => true, now, lease);
  expect(await renewHistoryTransferLease(lease!, now + 31_000)).toBe(true);
  expect(await claimHistoryTransferLease(scope, "lease-peer", now + 60_000)).toBeUndefined();
  const nextAt = now + 61_001;
  const replacement = await claimHistoryTransferLease(scope, "lease-peer", nextAt);
  expect(replacement).toBeDefined();
  expect(await renewHistoryTransferLease(lease!, nextAt)).toBe(false);
  await saveHistoryTransferCheckpoint(scope, "lease-peer", next, () => true, nextAt, replacement);
  await expect(saveHistoryTransferCheckpoint(scope, "lease-peer", first, () => true, nextAt, lease)).rejects.toThrow("another tab");
  await releaseHistoryTransferLease(lease!);
  await clearHistoryTransferCheckpoint(scope, "lease-peer", lease, true);
  expect(await loadHistoryTransferCheckpoint(scope, "lease-peer")).toEqual(next);
  await releaseHistoryTransferLease(replacement!);
  await clearHistoryTransferCheckpoint(scope, "lease-peer", lease, true);
  expect(await loadHistoryTransferCheckpoint(scope, "lease-peer")).toEqual(next);
  await clearHistoryTransferCheckpoint(scope, "lease-peer", replacement, true);
  expect(await loadHistoryTransferCheckpoint(scope, "lease-peer")).toBeUndefined();
});

it("never carries completed chats into a different archive for the same device pair", () => {
  const finished = { id: "chat", name: "Chat", messages: 1, bytes: 10, attachmentBytes: 0 };
  const previous = { chats: [finished], completedChatIds: [finished.id], bytes: 10, copyDownloadedFiles: true, resumeId: crypto.randomUUID() };
  const next = { v: HISTORY_TRANSFER_VERSION, chats: [], bytes: 0, copyDownloadedFiles: true } as const;
  expect(checkpointForManifest({ ...next, chats: [], resumeId: previous.resumeId }, previous).completedChatIds).toEqual(["chat"]);
  expect(checkpointForManifest({ ...next, chats: [], resumeId: crypto.randomUUID() }, previous).completedChatIds).toEqual([]);
});

it("keeps chat counters separate across a crash and clears missing files that were repaired on retry", async () => {
  const scope = { userId: "alice", deviceId: "local", role: "receiver", peerDeviceId: "restarted-peer" } as const;
  const now = Date.now();
  const lease = (await claimHistoryTransferLease(scope, scope.peerDeviceId, now))!;
  const chat = { id: "first", name: null, messages: 2, bytes: 200, attachmentBytes: 0, missingFiles: ["photo"] };
  const manifest = { v: HISTORY_TRANSFER_VERSION, resumeId: crypto.randomUUID(), bytes: 400, copyDownloadedFiles: true, chats: [{ ...chat, id: "done" }, chat] } as const;
  const checkpoint = checkpointForManifest({ ...manifest, chats: [...manifest.chats] });
  await saveHistoryTransferCheckpoint(scope, scope.peerDeviceId, checkpoint, () => true, now, lease, true);
  const context = { ...scope, lease };
  await completeHistoryTransferChat(context, "done", 200, () => true);
  const add = async (lease: typeof context.lease) => {
    const tx = (await getAppDB()).transaction("accountState", "readwrite");
    await recordHistoryTransferAdditions(tx.store, { ...scope, lease }, chat.id, { messages: 1, attachmentFiles: 0, attachmentBytes: 0 });
    await tx.done;
  };
  await add(lease);
  const saved = (await loadHistoryTransferCheckpoint(scope, scope.peerDeviceId))!;
  expect(saved.chats.find(({ id }) => id === chat.id)?.additions).toBeUndefined();
  const replacement = (await claimHistoryTransferLease(scope, scope.peerDeviceId, now + 30_001))!;
  const resumed = checkpointForManifest({ ...manifest, bytes: 200, chats: [{ ...chat, missingFiles: undefined }] }, saved);
  expect(resumed.chats.map(({ missingFileCount }) => missingFileCount)).toEqual([1, undefined]);
  await saveHistoryTransferCheckpoint(scope, scope.peerDeviceId, resumed, () => true, now + 30_001, replacement, true);
  await add(replacement);
  await expect(completeHistoryTransferChat(context, chat.id, 200, () => true)).rejects.toThrow("another tab");
  const finished = await completeHistoryTransferChat({ ...scope, lease: replacement }, chat.id, 200, () => true);
  expect(finished.completedChatIds).toEqual(["done", "first"]);
  expect(finished.chats[1].additions?.messages).toBe(2);
  expect(await loadHistoryTransferCheckpoint(scope, scope.peerDeviceId)).toEqual(finished);
  await clearHistoryTransferCheckpoint(scope, scope.peerDeviceId, replacement);
  await releaseHistoryTransferLease(replacement);
});
