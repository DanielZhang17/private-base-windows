import { act } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { waitFor } from "@testing-library/dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { DecryptedMessage } from "@e2ee-chat/shared";
import { createLocalMessageChannel, connectLocalMessageChannel } from "./local-message-changes.js";
import { hideMessageWithUndo, reconcileLocalMessageChange, startLocalHiddenMessageSync, resetMessageSyncState, loadPersistedConversationMessages, loadOlderPersistedConversationMessages } from "./message-sync.js";
import { getAppDB, messageHideKey, saveMessage as writeOwnedMessage, finishMessageHide } from "../db/index.js";
import { importHistoryTransferItem } from "../db/history-transfer.js";
import { useChatStore } from "../stores/chatStore.js";
import FilePreview from "../components/chat/FilePreview.js";
import { ToastProvider } from "../ui/index.js";
import { setupDom } from "../ui/test-utils.js";

const saveMessage = (row: Parameters<typeof writeOwnedMessage>[0], current?: () => boolean, ownerId = row.ownerId ?? "alice") =>
  writeOwnedMessage(row, current, ownerId);
vi.mock("../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ user: { id: "alice" }, device: { id: "device" }, accessToken: "token" }) } }));
vi.mock("../services/api.js", () => ({ ApiError: class extends Error {}, api: { get: vi.fn() }, resolveApiUrl: (url: string) => url }));
vi.mock("./file-url-resolver.js", () => ({ fileUrlResolver: { resolve: async () => ({ downloadUrl: "/encrypted", expiresAt: Date.now() + 60000 }) } }));
vi.mock("./message-processor.js", () => ({ decryptMessage: vi.fn(), decryptGroupText: vi.fn() }));
vi.mock("@e2ee-chat/crypto", () => ({ decryptFile: vi.fn(async () => new Uint8Array([1, 2, 3])) }));
const scope = { userId: "alice", deviceId: "device" };
class Channel {
  static peers = new Set<Channel>();
  onmessage?: (event: { data: unknown }) => void;
  constructor(readonly name: string) { Channel.peers.add(this); }
  postMessage(data: unknown) { for (const peer of Channel.peers) if (peer !== this && peer.name === this.name) queueMicrotask(() => peer.onmessage?.({ data })); }
  close() { Channel.peers.delete(this); }
}
const dom = setupDom();
beforeEach(async () => {
  resetMessageSyncState();
  vi.stubGlobal("BroadcastChannel", Channel);
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => `blob:${crypto.randomUUID()}`); static revokeObjectURL = vi.fn(); });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([99]).buffer })));
  const db = await getAppDB();
  await Promise.all(Array.from(db.objectStoreNames, (name) => db.clear(name)));
  useChatStore.setState({ messages: new Map() });
});
afterEach(() => { Channel.peers.clear(); vi.restoreAllMocks(); });
it("reconciles hide, Undo and commit across two tabs sharing IndexedDB and revokes both attachment URLs", async () => {
  const message: DecryptedMessage = { id: "private-message", conversationId: "conv", senderId: "alice", type: "file", content: JSON.stringify({ fileId: "file", fileName: "private.png", fileKey: "secret", iv: "secret-iv", mimeType: "image/png" }), timestamp: Date.now(), expiresAt: Date.now() + 60000, expiryKind: "retention", status: "sent" };
  await saveMessage(message);
  useChatStore.getState().addMessage("conv", message);
  const tabB = createStore<{ message: DecryptedMessage | null }>(() => ({ message }));
  const targetB = { addMessage: (_: string, row: DecryptedMessage) => tabB.setState({ message: row }), removeMessages: () => tabB.setState({ message: null }) };
  const changes: string[] = [];
  const a = connectLocalMessageChannel(scope, () => {});
  const b = createLocalMessageChannel(scope, (event) => { changes.push(event.kind); void reconcileLocalMessageChange(event.id, targetB); });
  function Preview({ message: row }: { message: DecryptedMessage | null }) { return row ? <FilePreview fileId="file" fileName="private.png" fileKey="secret" fileIv="secret-iv" mimeType="image/png" sizeBytes={3} /> : <span>Hidden</span>; }
  function A() { const row = useChatStore((state) => state.messages.get("conv")?.[0] ?? null); return <Preview message={row} />; }
  function B() { const row = useStore(tabB, (state) => state.message); return <Preview message={row} />; }
  try {
    await dom.render(<ToastProvider><A /><B /></ToastProvider>);
    expect(dom.container().querySelectorAll("img")).toHaveLength(2);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    let undo!: () => Promise<boolean>;
    await act(async () => { undo = (await hideMessageWithUndo("conv", message.id))!; await waitFor(() => expect(tabB.getState().message).toBeNull()); });
    expect(dom.container().querySelectorAll("img")).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    await act(async () => { expect(await undo()).toBe(true); await waitFor(() => expect(tabB.getState().message?.content).toBe(message.content)); });
    expect(dom.container().querySelectorAll("img")).toHaveLength(2);
    await act(async () => {
      await hideMessageWithUndo("conv", message.id);
      await waitFor(() => expect(tabB.getState().message).toBeNull());
      const db = await getAppDB();
      const hidden = await db.get("accountState", messageHideKey(message.id, "alice"));
      await finishMessageHide(message.id, hidden.undoToken, false, undefined, "alice");
      await waitFor(() => expect(changes).toContain("commit"));
      expect(await db.get("displayMessages", ["alice", message.id])).toBeUndefined();
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(4);
    expect(changes).toEqual(["hide", "undo", "hide", "commit"]);
  } finally { a(); b.close(); }
});
it("supports storage-event fallback without sending plaintext and isolates account/device scopes", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const received = vi.fn(), otherAccount = vi.fn(), otherDevice = vi.fn();
  const a = createLocalMessageChannel(scope, vi.fn()), b = createLocalMessageChannel(scope, received);
  const c = createLocalMessageChannel({ ...scope, userId: "other" }, otherAccount), d = createLocalMessageChannel({ ...scope, deviceId: "other" }, otherDevice);
  const set = vi.spyOn(Storage.prototype, "setItem");
  try {
    a.publish({ id: "opaque-id", kind: "hide" });
    const [key, newValue] = set.mock.calls.at(-1)!;
    expect(Object.keys(JSON.parse(newValue)).sort()).toEqual(["id", "kind", "nonce"]);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    expect(received).toHaveBeenCalledExactlyOnceWith({ id: "opaque-id", kind: "hide" });
    expect(otherAccount).not.toHaveBeenCalled(); expect(otherDevice).not.toHaveBeenCalled();
    b.close();
    a.publish({ id: "opaque-id", kind: "undo" });
    const [key2, value2] = set.mock.calls.at(-1)!;
    window.dispatchEvent(new StorageEvent("storage", { key: key2, newValue: value2 }));
    expect(received).toHaveBeenCalledTimes(1);
  } finally { a.close(); b.close(); c.close(); d.close(); }
});

it("refreshes another tab already showing a failed-decryption placeholder when import repairs it", async () => {
  const row = { ownerId: "alice", id: "failed", conversationId: "conv", senderId: "peer", type: "text", content: "",
    timestamp: Date.now(), expiresAt: Date.now() + 60_000, expiryKind: "retention", status: "failed" } as const;
  await saveMessage(row);
  const tab = createStore<{ row: DecryptedMessage }>(() => ({ row }));
  const target = { addMessage: (_conversation: string, received: DecryptedMessage) => tab.setState({ row: received }), removeMessages: vi.fn() };
  const local = connectLocalMessageChannel(scope, () => {});
  const other = createLocalMessageChannel(scope, ({ id, kind }) => {
    if (kind === "commit") void reconcileLocalMessageChange(id, target);
  });
  try {
    await importHistoryTransferItem("alice", { entry: { kind: "message", message: { ...row, content: "Recovered text", status: "delivered" } } });
    await vi.waitFor(() => expect(tab.getState().row).toMatchObject({ content: "Recovered text", status: "delivered" }));
  } finally { other.close(); local(); }
});

it.each([
  ["initial", "peer"], ["older", "peer"], ["initial", "local"], ["older", "local"],
])("never republishes hidden attachment keys when a %s page races a %s hide during validation", async (page, origin) => {
  const { openDB } = await import("idb");
  const database = await import("../db/index.js");
  const db = await getAppDB(), tabB = await openDB(db.name);
  const attachment = { ownerId: "alice", id: "hidden-attachment", conversationId: "conv", senderId: "alice", type: "file", content: JSON.stringify({ fileId: "private-file", fileKey: "secret-file-key", iv: "secret-iv" }), timestamp: page === "older" ? 1 : 200, expiresAt: Date.now() + 60000, status: "sent" };
  await saveMessage(attachment);
  if (page === "older") {
    const tx = db.transaction("displayMessages", "readwrite");
    await Promise.all(Array.from({ length: 100 }, (_, index) => tx.store.put({ ...attachment, id: `recent-${index}`, type: "text", content: "recent", timestamp: index + 2 })));
    await tx.done;
    await loadPersistedConversationMessages("conv");
  }
  const stop = startLocalHiddenMessageSync(), peer = createLocalMessageChannel(scope, () => {});
  const original = database.getCachedConversationMessagesPage;
  const read = vi.spyOn(database, "getCachedConversationMessagesPage").mockImplementationOnce(async (...args) => {
    const snapshot = await original(...args);
    if (origin === "peer") {
      // Another tab commits the durable hide after A validated its snapshot.
      await tabB.put("accountState", { id: messageHideKey(attachment.id, "alice"), ownerId: "alice", undoToken: "peer-undo", undoDeadline: Date.now() + 5000 });
      peer.publish({ id: attachment.id, kind: "hide", conversationId: "conv" });
      await Promise.resolve(); // Deliver the cross-tab event before A resumes publication.
    } else await database.beginMessageHide(attachment.id, undefined, "alice");
    return snapshot;
  });
  const publish = vi.spyOn(useChatStore.getState(), "prependMessages");
  try {
    await (page === "older" ? loadOlderPersistedConversationMessages("conv") : loadPersistedConversationMessages("conv"));
    expect(read).toHaveBeenCalledTimes(2); // the invalidated snapshot is re-read
    expect(publish.mock.calls.flatMap(([, rows]) => rows).some((message) => message.id === attachment.id || message.content.includes("secret-file-key"))).toBe(false);
    expect(useChatStore.getState().messages.get("conv")?.some((message) => message.id === attachment.id)).toBe(false);
  } finally { stop(); peer.close(); tabB.close(); }
});
