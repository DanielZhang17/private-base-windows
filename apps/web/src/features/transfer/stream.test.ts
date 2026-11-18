// @vitest-environment node
import { expect, it, vi } from "vitest";
import { HISTORY_TRANSFER_SPACE_BATCH_ATTACHMENT_BYTES } from "@e2ee-chat/shared";
import { buildTransferArchive, historyStorageItemBytes } from "./archive.js";
import { createTransferPairing, encodeTransferWords, parseTransferPairing, transferRoomId } from "./pairing.js";
import { openTransferRecord, sealTransferRecord, TRANSFER_CHUNK_BYTES } from "./records.js";
import { HistoryTransferStream, TransferStorageError } from "./stream.js";

it("round-trips the QR and eight words without exposing the secret in the routing ID", async () => {
  const qr = createTransferPairing("receiver");
  const words = encodeTransferWords(qr.secret);
  expect(words.split(" ")).toHaveLength(8);
  expect(Object.keys(qr).sort()).toEqual(["receiverDeviceId", "secret", "v"]);
  expect(parseTransferPairing(JSON.stringify(qr))).toMatchObject({ qr });
  const numbered = words.split(" ").map((word, i) => `${i + 1}. ${word.toUpperCase()}`).join(",\n");
  expect(parseTransferPairing(numbered)).toEqual({ secret: qr.secret });
  expect(await transferRoomId(qr.secret)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await transferRoomId(qr.secret)).not.toContain(qr.secret);
  expect(() => parseTransferPairing("one two three")).toThrow();
});

it("authenticates record kind and index and rejects malformed frames", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const payload = new TextEncoder().encode("record");
  const wire = await sealTransferRecord(key, "data", 7, payload);
  expect(await openTransferRecord(key, wire.buffer)).toEqual({ kind: "data", index: 7, payload });
  wire[4] ^= 1;
  await expect(openTransferRecord(key, wire.buffer)).rejects.toThrow();
  await expect(openTransferRecord(key, wire.slice(0, 13).buffer)).rejects.toThrow();
  await expect(sealTransferRecord(key, "data", 0, new Uint8Array(TRANSFER_CHUNK_BYTES + 1))).rejects.toThrow();
});

class Channel {
  peer!: Channel;
  sent: Array<{ kind: number; index: number }> = [];
  readyState = "open";
  bufferedAmount = 0;
  blockAfterFirstData = false;
  dropKind?: number;
  holdKind?: number;
  pendingDelivery?: () => void;
  pausedKind?: number;
  pausedDeliveries: Array<() => void> = [];
  onmessage?: (event: { data: ArrayBuffer }) => void;

  send(record: Uint8Array<ArrayBuffer>) {
    const kind = record[0];
    const index = new DataView(record.buffer).getUint32(1);
    this.sent.push({ kind, index });
    if (kind === this.dropKind) return;
    if (kind === 1 && this.blockAfterFirstData) this.bufferedAmount = Infinity;
    const deliver = () => {
      if (this.peer.readyState === "open") this.peer.onmessage?.({ data: record.buffer });
    };
    if (kind === this.pausedKind) this.pausedDeliveries.push(deliver);
    else if (kind === this.holdKind) this.pendingDelivery = deliver;
    else setTimeout(deliver, 0);
  }
  close() { this.readyState = "closed"; }
}

function connect(sender: HistoryTransferStream, receiver: HistoryTransferStream, blockAfterFirstData = false) {
  const left = new Channel();
  const right = new Channel();
  left.peer = right;
  right.peer = left;
  left.blockAfterFirstData = blockAfterFirstData;
  const toSender = crypto.getRandomValues(new Uint8Array(32));
  const toReceiver = crypto.getRandomValues(new Uint8Array(32));
  sender.attach(left as unknown as RTCDataChannel, toSender, toReceiver, "123456");
  receiver.attach(right as unknown as RTCDataChannel, toReceiver.slice(), toSender.slice(), "123456");
  return left;
}

it("checks remaining storage after confirmation and delivers sticker preferences and receiver totals", async () => {
  const resumeId = crypto.randomUUID();
  const stickers = { favourites: [{ id: "genshin_hoyolab_21", addedAt: 1 }], recent: ["genshin_hoyolab_21"] };
  const archive = buildTransferArchive([
    { entry: { kind: "conversation", conversation: { id: "chat", name: "Test", type: "group", avatarUrl: null, invitePolicy: "any_member",
      createdBy: "alice", createdAt: 1, updatedAt: 1, members: [] } } },
    { entry: { kind: "message", message: { id: "duplicate", conversationId: "chat", senderId: "alice", type: "text",
      content: "already on the receiver", timestamp: 1, expiresAt: null, status: "sent" } } },
  ], "alice", false, undefined, undefined, resumeId, stickers);
  const checkpoint = { resumeId, chats: [{ ...archive.manifest.chats[0], additions: { messages: 0, attachmentBytes: 0, attachmentFiles: 0 } }],
    completedChatIds: ["chat"], bytes: archive.manifest.bytes, copyDownloadedFiles: false };
  const receivedReceipt = vi.fn();
  const estimateStorage = vi.fn(async () => 0);
  const manifest = vi.fn();
  const callbacks = { load: async () => null, received: vi.fn(), manifest, chatComplete: vi.fn() };
  const failure = vi.fn();
  const sender = new HistoryTransferStream("sender", vi.fn(), vi.fn(), failure, vi.fn(), { ...callbacks, receivedReceipt });
  const receiver = new HistoryTransferStream("receiver", vi.fn(), vi.fn(), failure, vi.fn(), { ...callbacks, estimateStorage, receipt: async () => checkpoint });
  let free = archive.storageBytes - 1;
  vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: free, usage: 0 }) } });
  connect(sender, receiver);
  try {
    const check = async () => true;
    await expect(sender.estimateRemaining(archive, check)).rejects.toThrow("unavailable");
    expect(estimateStorage).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sender.checkCode && receiver.checkCode).toBe("123456"));
    sender.confirm();
    receiver.confirm();
    await vi.waitFor(() => expect(sender.ready && receiver.ready).toBe(true));
    expect(await sender.estimateRemaining(archive, check)).toBeLessThan(archive.size);
    expect(estimateStorage).toHaveBeenCalledWith(archive.spaceItems);
    free = archive.storageBytes + 1;
    expect(await sender.estimateRemaining(archive, check)).toBe(archive.storageBytes);
    expect(sender.peerCapacity?.free).toBe(free);
    expect(estimateStorage).toHaveBeenCalledOnce();
    sender.prepare(archive);
    sender.send();
    await vi.waitFor(() => expect(sender.complete).toBe(true));
    expect(manifest).toHaveBeenCalledWith(expect.objectContaining({ stickers }));
    expect(receivedReceipt).toHaveBeenCalledWith(expect.objectContaining({ resumeId, chats: [expect.objectContaining({ additions: { messages: 0, attachmentBytes: 0, attachmentFiles: 0 } })] }));
    expect(failure).not.toHaveBeenCalled();
  } finally { sender.detach(); receiver.detach(); vi.unstubAllGlobals(); }
});

it("discloses no later storage batches after a removal during a prior round trip", async () => {
  const items = Array.from({ length: 33 }, (_, index) => ({ kind: "message" as const, id: `message-${index}`, conversationId: "chat",
    senderId: "alice", direct: false, bytes: 100 }));
  const archive = { size: 3500, storageBytes: 3300, spaceItems: items } as ReturnType<typeof buildTransferArchive>;
  let current = true;
  const estimateStorage = vi.fn(async () => { current = false; return 0; });
  const callbacks = { load: async () => null, received: vi.fn(), manifest: vi.fn(), chatComplete: vi.fn(), estimateStorage };
  const sender = new HistoryTransferStream("sender", vi.fn(), vi.fn(), vi.fn(), vi.fn(), callbacks);
  const receiver = new HistoryTransferStream("receiver", vi.fn(), vi.fn(), vi.fn(), vi.fn(), callbacks);
  vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: 1000, usage: 0 }) } });
  const channel = connect(sender, receiver);
  try {
    await vi.waitFor(() => expect(sender.checkCode && receiver.checkCode).toBe("123456"));
    sender.confirm();
    receiver.confirm();
    await vi.waitFor(() => expect(sender.ready).toBe(true));
    await expect(sender.estimateRemaining(archive, async () => current)).rejects.toThrow("History changed");
    expect(estimateStorage).toHaveBeenCalledExactlyOnceWith(items.slice(0, 16));
    expect(channel.sent.filter(({ kind }) => kind === 12)).toHaveLength(2); // Capacity refresh and the first batch.
  } finally { sender.detach(); receiver.detach(); vi.unstubAllGlobals(); }
});

it("keeps tombstone wire sizes advisory and bounds the attachment work of each storage request", async () => {
  const tombstones = buildTransferArchive([
    { entry: { kind: "conversation", conversation: { id: "chat", name: "Chat", type: "direct", avatarUrl: null,
      invitePolicy: "any_member", createdBy: "alice", createdAt: 1, updatedAt: 1, members: [] } } },
    { entry: { kind: "deletion", id: "deleted", conversationId: "chat", senderId: "alice", deletedAt: 3, deletedByUserId: "alice" } },
  ], "alice");
  const attachmentBytes = HISTORY_TRANSFER_SPACE_BATCH_ATTACHMENT_BYTES;
  const items = [attachmentBytes, attachmentBytes / 2, attachmentBytes / 2, attachmentBytes / 2].map((bytes, index) => ({
    kind: "message" as const, id: `message-${index}`, conversationId: "chat", senderId: "alice", direct: true, bytes: 100, attachment: { id: `file-${index}`, bytes },
  }));
  const archive = { ...tombstones, size: 3 * attachmentBytes, storageBytes: items.reduce((sum, item) => sum + historyStorageItemBytes(item), 0), spaceItems: items };
  const estimateStorage = vi.fn(async () => 0).mockResolvedValueOnce(tombstones.storageBytes);
  const failure = vi.fn();
  const callbacks = { load: async () => null, received: vi.fn(), manifest: vi.fn(), chatComplete: vi.fn(), estimateStorage };
  const sender = new HistoryTransferStream("sender", vi.fn(), vi.fn(), failure, vi.fn(), callbacks);
  const receiver = new HistoryTransferStream("receiver", vi.fn(), vi.fn(), failure, vi.fn(), callbacks);
  vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: 1, usage: 0 }) } });
  connect(sender, receiver);
  try {
    await vi.waitFor(() => expect(sender.checkCode && receiver.checkCode).toBe("123456"));
    sender.confirm();
    receiver.confirm();
    await vi.waitFor(() => expect(sender.ready).toBe(true));
    expect(tombstones.size).toBeGreaterThan(1);
    expect(tombstones.spaceItems.map(({ kind }) => kind)).toEqual(["conversation"]);
    await expect(sender.estimateRemaining(tombstones, async () => true)).resolves.toBe(tombstones.storageBytes);
    expect(estimateStorage).toHaveBeenCalledExactlyOnceWith(tombstones.spaceItems);
    estimateStorage.mockClear();
    await expect(sender.estimateRemaining(archive, async () => true)).resolves.toBe(0);
    expect(estimateStorage.mock.calls).toEqual([[items.slice(0, 1)], [items.slice(1, 3)], [items.slice(3)]]);
    expect(failure).not.toHaveBeenCalled();
  } finally { sender.detach(); receiver.detach(); vi.unstubAllGlobals(); }
});

it.each([true, false])("backpressures and revalidates the archive before resuming mid-attachment (valid %s)", async (canResume) => {
  const blob = new Blob([new Uint8Array(3 * TRANSFER_CHUNK_BYTES).fill(65)]);
  const conversation = { id: "chat", name: "Test", type: "group", avatarUrl: null, invitePolicy: "any_member",
    createdBy: "alice", createdAt: 1, updatedAt: 1, members: [] } as const;
  const archive = buildTransferArchive([
    { entry: { kind: "conversation", conversation: { ...conversation, members: [] } } },
    { entry: { kind: "message", message: { id: "id", conversationId: "chat", senderId: "alice", type: "file",
      content: "metadata", timestamp: 1, expiresAt: null, status: "sent" },
      attachment: { id: "file", mimeType: "text/plain", fileName: "memo.txt", expiresAt: 100, size: blob.size } }, blob },
  ], "alice");
  const importItem = vi.fn(async () => {});
  const failure = vi.fn();
  const sender = new HistoryTransferStream("sender", vi.fn(), vi.fn(), failure, vi.fn());
  const receiver = new HistoryTransferStream("receiver", importItem, vi.fn(), failure, vi.fn());
  const first = connect(sender, receiver, true);
  sender.prepare(archive);
  expect(() => sender.confirm()).toThrow();
  await vi.waitFor(() => expect(sender.checkCode).toBe("123456"));
  sender.confirm();
  await vi.waitFor(() => expect(receiver.peerConfirmed).toBe(true));
  expect(first.sent).toEqual([{ kind: 5, index: 0 }, { kind: 0, index: 0 }]);
  expect(() => sender.send()).toThrow();
  expect(importItem).not.toHaveBeenCalled();

  receiver.confirm();
  await vi.waitFor(() => expect(sender.ready).toBe(true));
  const checkArchive = vi.fn(async () => true);
  sender.send(false, checkArchive);
  await vi.waitFor(() => expect(sender.progress.records).toBe(1));
  expect(receiver.manifest).toEqual(archive.manifest);
  expect(importItem).toHaveBeenCalledTimes(1);
  expect(first.sent.filter(({ kind }) => kind === 1)).toEqual([{ kind: 1, index: 0 }]);

  sender.detach();
  receiver.detach();
  checkArchive.mockClear().mockResolvedValue(canResume);
  const resumed = connect(sender, receiver);
  if (!canResume) {
    await vi.waitFor(() => expect(checkArchive).toHaveBeenCalled());
    expect(resumed.sent.filter(({ kind }) => kind === 1)).toEqual([]);
    expect(importItem).toHaveBeenCalledTimes(1);
    sender.detach();
    receiver.detach();
    return;
  }
  await vi.waitFor(() => expect(sender.complete).toBe(true));
  receiver.peerDisconnected();
  expect(receiver.complete).toBe(true);
  expect(resumed.sent.filter(({ kind }) => kind === 1).map(({ index }) => index)).toEqual([1, 2, 3]);
  expect(importItem).toHaveBeenCalledTimes(2);
  expect(importItem).toHaveBeenLastCalledWith(expect.objectContaining({ blob: expect.objectContaining({ size: blob.size }) }));
  expect(receiver.progress).toMatchObject({ records: 4, bytes: archive.manifest.bytes });
  expect(failure).not.toHaveBeenCalled();
  sender.detach();
  receiver.detach();
});

it("opens cached attachments only as the stream reaches them and reopens at the resumed offset", async () => {
  const conversation = { id: "chat", name: "Test", type: "group", avatarUrl: null, invitePolicy: "any_member",
    createdBy: "alice", createdAt: 1, updatedAt: 1, members: [] } as const;
  const attachment = (id: string, byte: number) => {
    const size = 3 * TRANSFER_CHUNK_BYTES;
    const open = vi.fn(async () => new Blob([new Uint8Array(size).fill(byte)]));
    return {
      entry: { kind: "message", message: { id, conversationId: "chat", senderId: "alice", type: "file",
        content: "metadata", timestamp: 1, expiresAt: null, status: "sent" },
        attachment: { id, mimeType: "text/plain", fileName: "memo.txt", expiresAt: 100, size } },
      attachmentSource: { open, size },
    } as const;
  };
  const first = attachment("first", 65);
  const second = attachment("second", 66);
  const archive = buildTransferArchive([
    { entry: { kind: "conversation", conversation: { ...conversation, members: [] } } }, first, second,
  ], "alice", true);
  await archive.read(0, archive.manifestBytes);
  expect(first.attachmentSource.open).not.toHaveBeenCalled();
  expect(second.attachmentSource.open).not.toHaveBeenCalled();
  await archive.read(0, TRANSFER_CHUNK_BYTES);
  expect((await archive.read(TRANSFER_CHUNK_BYTES, 5)).every((byte) => byte === 65)).toBe(true);
  expect(first.attachmentSource.open).toHaveBeenCalledOnce();
  expect(second.attachmentSource.open).not.toHaveBeenCalled();
  archive.releaseAttachment();
  expect((await archive.read(2 * TRANSFER_CHUNK_BYTES, 5)).every((byte) => byte === 65)).toBe(true);
  expect(first.attachmentSource.open).toHaveBeenCalledTimes(2);
  expect((await archive.read(archive.size - second.attachmentSource.size, 5)).every((byte) => byte === 66)).toBe(true);
  expect(second.attachmentSource.open).toHaveBeenCalledOnce();
});

it("checks a sustained send again after a record read yields to a late removal", async () => {
  const conversation = { id: "chat", name: "Test", type: "group", avatarUrl: null, invitePolicy: "any_member",
    createdBy: "alice", createdAt: 1, updatedAt: 1, members: [] } as const;
  const size = 3 * TRANSFER_CHUNK_BYTES;
  const archive = buildTransferArchive([
    { entry: { kind: "conversation", conversation: { ...conversation, members: [] } } },
    { entry: { kind: "message", message: { id: "file", conversationId: "chat", senderId: "alice", type: "file", content: "metadata",
      timestamp: 1, expiresAt: null, status: "sent" }, attachment: { id: "file", fileName: "memo.txt", mimeType: "text/plain", expiresAt: 100, size } },
      blob: new Blob([new Uint8Array(size)]) },
  ], "alice");
  let current = true;
  const read = archive.read;
  archive.read = async (offset, length) => {
    const bytes = await read(offset, length);
    if (offset >= TRANSFER_CHUNK_BYTES) current = false;
    return bytes;
  };
  const denied = vi.fn();
  const check = async () => { if (!current) denied(); return current; };
  const failure = vi.fn();
  const sender = new HistoryTransferStream("sender", vi.fn(), vi.fn(), failure, vi.fn());
  const receiver = new HistoryTransferStream("receiver", vi.fn(async () => {}), vi.fn(), failure, vi.fn());
  const channel = connect(sender, receiver);
  try {
    sender.prepare(archive);
    await vi.waitFor(() => expect(sender.checkCode && receiver.checkCode).toBe("123456"));
    sender.confirm();
    receiver.confirm();
    await vi.waitFor(() => expect(sender.ready).toBe(true));
    sender.send(false, check);
    await vi.waitFor(() => expect(denied).toHaveBeenCalled());
    expect(channel.sent.filter(({ kind }) => kind === 1).map(({ index }) => index)).toEqual([0]);
    expect(failure).not.toHaveBeenCalled();
  } finally { sender.detach(); receiver.detach(); }
});

it("exchanges the receiver's checkpoint only after both freshly confirmed", async () => {
  const checkpoint = { chats: [{ id: "done", messages: 1, bytes: 5, attachmentBytes: 0 },
    { id: "next", messages: 3, bytes: 7, attachmentBytes: 0 }], completedChatIds: ["done"], bytes: 5, copyDownloadedFiles: true };
  const received = vi.fn(async () => {});
  const failures = vi.fn();
  const sender = new HistoryTransferStream("sender", vi.fn(), vi.fn(), failures, vi.fn(), {
    load: async () => null, received, manifest: vi.fn(), chatComplete: vi.fn(),
  });
  const receiver = new HistoryTransferStream("receiver", vi.fn(), vi.fn(), failures, vi.fn(), {
    load: async () => checkpoint, received: vi.fn(), manifest: vi.fn(), chatComplete: vi.fn(),
  });
  connect(sender, receiver);
  await vi.waitFor(() => { expect(sender.checkCode).toBeDefined(); expect(receiver.checkCode).toBeDefined(); });
  expect(sender.localConfirmed).toBe(false);
  expect(receiver.localConfirmed).toBe(false);
  receiver.confirm();
  await vi.waitFor(() => expect(sender.peerConfirmed).toBe(true));
  expect(received).not.toHaveBeenCalled();
  sender.confirm();
  await vi.waitFor(() => expect(received).toHaveBeenCalledWith(checkpoint));
  expect(failures).not.toHaveBeenCalled();
  sender.dispose();
  receiver.dispose();
});

it.each(["resume", "receipt"] as const)("paces a %s larger than the sender's pending-read limit", async (phase) => {
  const completedChatIds = Array.from({ length: 4500 }, (_, index) => `${index}-${"x".repeat(230)}`);
  const checkpoint = { copyDownloadedFiles: false, completedChatIds, bytes: 4500,
    chats: completedChatIds.map((id) => ({ id, messages: 1, bytes: 1, attachmentBytes: 0 })) };
  expect(JSON.stringify(checkpoint).length).toBeGreaterThan(32 * TRANSFER_CHUNK_BYTES);
  const failures = vi.fn();
  const received = vi.fn();
  const receivedReceipt = vi.fn();
  const callbacks = { load: async () => null, received, receivedReceipt, manifest: vi.fn(), chatComplete: vi.fn() };
  const sender = new HistoryTransferStream("sender", vi.fn(), vi.fn(), failures, vi.fn(), callbacks);
  const receiver = new HistoryTransferStream("receiver", vi.fn(), vi.fn(), failures, vi.fn(), {
    ...callbacks, load: async () => phase === "resume" ? checkpoint : null, receipt: async () => checkpoint,
  });
  const channel = connect(sender, receiver);
  const partKind = phase === "resume" ? 6 : 11;
  const parts = () => channel.peer.sent.filter(({ kind }) => kind === partKind);
  try {
    await vi.waitFor(() => expect(sender.checkCode && receiver.checkCode).toBe("123456"));
    if (phase === "resume") channel.pausedKind = 14;
    sender.confirm();
    receiver.confirm();
    if (phase === "receipt") {
      await vi.waitFor(() => expect(sender.ready).toBe(true));
      channel.pausedKind = 14;
      sender.prepare(buildTransferArchive([], "alice"));
      sender.send(true);
    }
    await vi.waitFor(() => expect(channel.pausedDeliveries).toHaveLength(8));
    expect(parts()).toHaveLength(8);
    expect(sender.complete).toBe(false);
    const senderProgress = sender.progress;
    const receiverProgress = receiver.progress;
    expect(sender.receiptActivity).toBe(phase === "receipt" ? 16 : 0);
    expect(receiver.receiptActivity).toBe(phase === "receipt" ? 8 : 0);
    channel.pausedKind = undefined;
    for (const deliver of channel.pausedDeliveries.splice(0)) deliver();
    const callback = phase === "resume" ? received : receivedReceipt;
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(checkpoint), { timeout: 4_000 });
    expect(parts().length).toBeGreaterThan(32);
    expect(failures).not.toHaveBeenCalled();
    if (phase === "receipt") {
      expect(sender.complete).toBe(true);
      expect(sender.receiptActivity).toBe(2 * parts().length);
      expect(receiver.receiptActivity).toBe(2 * parts().length);
      expect(sender.progress).toEqual(senderProgress);
      expect(receiver.progress).toEqual(receiverProgress);
    }
  } finally { sender.dispose(); receiver.dispose(); }
});

it("waits for the receiver to process the receipt before closing a resumed transfer", async () => {
  const checkpoint = {
    chats: [{ id: "done", messages: 1, bytes: 5, attachmentBytes: 0 }],
    completedChatIds: ["done"], bytes: 5, copyDownloadedFiles: false,
  };
  const importItem = vi.fn();
  const failure = vi.fn();
  const manifest = vi.fn();
  const sender = new HistoryTransferStream("sender", vi.fn(), vi.fn(), failure, vi.fn());
  const receiver = new HistoryTransferStream("receiver", importItem, vi.fn(), failure, vi.fn(), {
    load: async () => checkpoint, received: vi.fn(), manifest, chatComplete: vi.fn(),
  });
  const channel = connect(sender, receiver);
  channel.holdKind = channel.peer.holdKind = 4;
  await vi.waitFor(() => { expect(sender.checkCode).toBeDefined(); expect(receiver.checkCode).toBeDefined(); });
  sender.confirm();
  receiver.confirm();
  await vi.waitFor(() => expect(sender.ready).toBe(true));
  sender.prepare(buildTransferArchive([], "alice"));
  expect(() => sender.send()).toThrow("not ready");
  sender.send(true);
  await vi.waitFor(() => expect(channel.pendingDelivery).toBeDefined());
  expect(channel.bufferedAmount).toBe(0);
  expect(sender.complete).toBe(false);
  channel.pendingDelivery!();
  await vi.waitFor(() => expect(channel.peer.pendingDelivery).toBeDefined());
  expect(sender.complete).toBe(false);
  expect(receiver.complete).toBe(false);
  channel.peer.pendingDelivery!();
  await vi.waitFor(() => expect(sender.complete).toBe(true));
  receiver.peerDisconnected();
  expect(receiver.complete).toBe(true);
  expect(manifest).toHaveBeenCalledWith(expect.objectContaining({ chats: [], bytes: 0 }));
  expect(importItem).not.toHaveBeenCalled();
  expect(failure).not.toHaveBeenCalled();
  sender.dispose();
  receiver.dispose();
});

it("never reveals a check code or releases data when the peer cannot prove the session key", async () => {
  const failure = vi.fn();
  const stream = new HistoryTransferStream("receiver", vi.fn(), vi.fn(), failure, vi.fn());
  const channel = new Channel();
  channel.peer = new Channel();
  const key = crypto.getRandomValues(new Uint8Array(32));
  stream.attach(channel as unknown as RTCDataChannel, key, key.slice(), "123456");
  const wrong = await sealTransferRecord(crypto.getRandomValues(new Uint8Array(32)), "proof", 0);
  channel.onmessage?.({ data: wrong.buffer });
  await vi.waitFor(() => expect(failure).toHaveBeenCalled());
  expect(stream.checkCode).toBeUndefined();
  expect(() => stream.confirm()).toThrow();
  expect(channel.sent.every(({ kind }) => kind === 5)).toBe(true);
  stream.dispose();
});

it("does not complete a receiver when the final receipt was lost", async () => {
  const errors = vi.fn();
  const sender = new HistoryTransferStream("sender", vi.fn(), vi.fn(), errors, vi.fn());
  const receiver = new HistoryTransferStream("receiver", vi.fn(), vi.fn(), errors, vi.fn());
  const channel = connect(sender, receiver);
  channel.dropKind = 4;
  await vi.waitFor(() => { expect(sender.checkCode).toBeDefined(); expect(receiver.checkCode).toBeDefined(); });
  sender.confirm();
  receiver.confirm();
  await vi.waitFor(() => expect(sender.ready).toBe(true));
  sender.prepare(buildTransferArchive([], "alice"));
  sender.send(true);
  await vi.waitFor(() => expect(channel.sent.some(({ kind }) => kind === 4)).toBe(true));
  sender.peerDisconnected();
  receiver.peerDisconnected();
  expect(sender.complete).toBe(false);
  expect(receiver.complete).toBe(false);
  expect(errors).not.toHaveBeenCalled();
  sender.dispose();
  receiver.dispose();
});

it("persists committed chats before replying and acknowledges them after a lost final ACK and fresh pairing", async () => {
  const { saveHistoryTransferCheckpoint, loadHistoryTransferCheckpoint, listInterruptedHistoryTransfers } = await import("../../db/history-transfer-progress.js");
  const scope = { userId: "ack-owner", deviceId: "receiver-device", role: "receiver" } as const;
  const checkpoint = { chats: [{ id: "done", messages: 1, bytes: 10, attachmentBytes: 0 }],
    completedChatIds: ["done"], bytes: 10, copyDownloadedFiles: false };
  const peer = "sender-device";
  const errors = vi.fn(), received = vi.fn(), importItem = vi.fn();
  const receipt = vi.fn(async () => saveHistoryTransferCheckpoint(scope, peer, { ...checkpoint, confirmationOnly: true }, () => true));
  const newSender = () => new HistoryTransferStream("sender", vi.fn(), vi.fn(), errors, vi.fn(), {
    load: async () => null, received, manifest: vi.fn(), chatComplete: vi.fn(),
  });
  const newReceiver = () => new HistoryTransferStream("receiver", importItem, vi.fn(), errors, vi.fn(), {
    load: async () => await loadHistoryTransferCheckpoint(scope, peer) ?? null,
    received: vi.fn(), manifest: vi.fn(), chatComplete: vi.fn(), receipt,
  });
  const confirm = async (sender: HistoryTransferStream, receiver: HistoryTransferStream) => {
    await vi.waitFor(() => { expect(sender.checkCode).toBeDefined(); expect(receiver.checkCode).toBeDefined(); });
    sender.confirm(); receiver.confirm();
    await vi.waitFor(() => expect(sender.ready).toBe(true));
    sender.prepare(buildTransferArchive([], "ack-owner"));
    sender.send(true);
  };
  await saveHistoryTransferCheckpoint(scope, peer, checkpoint, () => true);
  const sender = newSender(), receiver = newReceiver();
  const channel = connect(sender, receiver);
  channel.peer.dropKind = 4;
  await confirm(sender, receiver);
  await vi.waitFor(() => expect(channel.peer.sent.some(({ kind }) => kind === 4)).toBe(true));
  expect(await loadHistoryTransferCheckpoint(scope, peer)).toEqual({ ...checkpoint, confirmationOnly: true });
  expect(await listInterruptedHistoryTransfers(scope)).toEqual([]);
  receiver.peerDisconnected();
  expect(sender.complete).toBe(false);
  sender.dispose(); receiver.dispose();

  const restartedSender = newSender(), restartedReceiver = newReceiver();
  connect(restartedSender, restartedReceiver);
  await confirm(restartedSender, restartedReceiver);
  expect(received).toHaveBeenLastCalledWith({ ...checkpoint, confirmationOnly: true });
  await vi.waitFor(() => expect(restartedSender.complete).toBe(true));
  expect(importItem).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  restartedSender.dispose(); restartedReceiver.dispose();
});

it("reports receiver storage exhaustion on both sides through the authenticated stream", async () => {
  const senderError = vi.fn();
  const receiverError = vi.fn();
  const sender = new HistoryTransferStream("sender", vi.fn(), vi.fn(), senderError, vi.fn());
  const receiver = new HistoryTransferStream("receiver", async () => { throw new DOMException("full", "QuotaExceededError"); },
    vi.fn(), receiverError, vi.fn());
  connect(sender, receiver);
  await vi.waitFor(() => { expect(sender.checkCode).toBeDefined(); expect(receiver.checkCode).toBeDefined(); });
  sender.confirm();
  receiver.confirm();
  await vi.waitFor(() => expect(sender.ready).toBe(true));
  sender.prepare(buildTransferArchive([{ entry: { kind: "conversation", conversation: {
    id: "chat", type: "direct", name: null, avatarUrl: null, invitePolicy: "any_member", createdBy: "alice",
    createdAt: 1, updatedAt: 1, members: [],
  } } }], "alice"));
  sender.send();
  await vi.waitFor(() => {
    expect(receiverError).toHaveBeenCalledWith(expect.any(TransferStorageError));
    expect(senderError).toHaveBeenCalledWith(expect.any(TransferStorageError));
  });
  expect(receiver.complete).toBe(false);
  sender.dispose();
  receiver.dispose();
});
