import { setLocalEncryptionKey } from "../../lib/local-key-encryption.js";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationWithMembers } from "@e2ee-chat/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encryptFile, encryptMessageEdit, fromBase64Url } from "@e2ee-chat/crypto";
import { useSendMessage } from "./useSendMessage.js";
import { observeGroupClock } from "./group-timeout.js";
import { useChatStore } from "../../stores/chatStore.js";
import { getAllOutgoing, getAppDB, getMessageById, saveMessage as writeOwnedMessage } from "../../db/index.js";
import { api } from "../../services/api.js";
import { prepareDirectPayloadFanout } from "../../lib/direct-messages.js";
import { encryptGroupText } from "../../lib/message-processor.js";
import { stickerToken } from "../../lib/stickers.js";
import { setFilePreparing } from "./outgoingQueue.js";
import { useAuthStore } from "../../stores/authStore.js";
const saveMessage = (message: import("../../db/index.js").LocalMessage) => writeOwnedMessage(message, undefined, "alice");
const signingKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "alice" }, device: { id: "device" }, accessToken: "token" })) };
});
vi.mock("../../lib/key-manager.js", () => ({
  keysLoaded: () => true, getUnlockGeneration: () => 1,
  getIdentityKeyPair: () => ({ publicEd25519: new Uint8Array(32), privateEd25519: new Uint8Array(64) }),
}));
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(async () => ({})), post: vi.fn(), put: vi.fn() } }));
vi.mock("../../lib/direct-messages.js", () => ({ prepareDirectPayloadFanout: vi.fn(async () => ({ messages: [{ ciphertext: "opaque", iv: "iv", header: "header" }] })) }));
vi.mock("@e2ee-chat/crypto", async (original) => ({
  ...await original<typeof import("@e2ee-chat/crypto")>(),
  generateFileKey: () => ({ key: "private-key", iv: "private-iv" }), encryptFile: vi.fn(), encryptMessageEdit: vi.fn(),
}));
vi.mock("./outgoingQueue.js", async (original) => {
  const queue = await original<typeof import("./outgoingQueue.js")>();
  return { ...queue, setFilePreparing: vi.fn(queue.setFilePreparing) };
});
vi.mock("../../lib/group-session.js", () => ({ prepareSenderKeyDistribution: vi.fn(), finishSenderKeyDistribution: vi.fn() }));
vi.mock("../../lib/message-processor.js", () => ({ encryptGroupText: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ touchConversationInCache: vi.fn() }));
const receipt = { serverTimestamp: 123, expiresAt: 999999, expiryKind: "retention" };
beforeEach(async () => {
  setLocalEncryptionKey(await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
  vi.clearAllMocks();
  useAuthStore.setState({ device: { ...useAuthStore.getState().device!, identityKey: signingKey } });
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  useChatStore.setState({ messages: new Map() });
  vi.mocked(encryptFile).mockResolvedValue(new Uint8Array([9, 8, 7]));
  vi.mocked(api.put).mockResolvedValue({ success: true });
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/files/upload-url" ? { fileId: "file", uploadUrl: "/upload" } : receipt) as never);
});
afterEach(() => vi.unstubAllGlobals());
it.each([true, false])("publishes immediately, then trusts the accepted envelope's edit capability (%s)", async (editKeyAccepted) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let state!: ReturnType<typeof useSendMessage>;
  const conversation = { id: "chat", type: "direct" } as ConversationWithMembers;
  function Probe() { state = useSendMessage(conversation); return null; }
  let resolve!: (value: unknown) => void;
  vi.mocked(api.post).mockReturnValue(new Promise((r) => { resolve = r; }));
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  let sent!: Promise<void>;
  act(() => { sent = state.handleSend("hello", { ttlSeconds: null }); });
  expect(useChatStore.getState().messages.get("chat")).toMatchObject([{ content: "hello", status: "sending" }]);
  await act(async () => { await vi.waitFor(() => expect(api.post).toHaveBeenCalled()); });
  const rows = await getAllOutgoing();
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("hello");
  const local = await getMessageById(rows[0].id, "alice", undefined, true);
  expect(local).toMatchObject({ editSigningKey: signingKey, editSenderDeviceId: "device" });
  expect(local?.editKeyAccepted).toBeUndefined();
  expect(fromBase64Url(local!.editKey!)).toHaveLength(32);
  expect(JSON.stringify(rows)).not.toContain(local!.editKey!);
  const db = await getAppDB();
  const storedKey = await db.get("accountState", `message-edit-state:${JSON.stringify(["alice", rows[0].id])}`);
  expect(storedKey).toHaveProperty("wrappedKey");
  expect(JSON.stringify(storedKey)).not.toContain(local!.editKey!);
  expect(useChatStore.getState().messages.get("chat")?.[0]).not.toHaveProperty("editKey");
  expect(vi.mocked(prepareDirectPayloadFanout).mock.calls[0][4]?.editKey?.bytes).toEqual(
    new Uint8Array([...fromBase64Url(local!.editKey!), ...fromBase64Url(signingKey)]),
  );
  await act(async () => {
    resolve({ serverTimestamp: Date.now(), expiresAt: Date.now() + 60000, expiryKind: "retention", editKeyAccepted });
    await sent;
  });
  expect(useChatStore.getState().messages.get("chat")).toMatchObject([{ content: "hello", status: "sent" }]);
  const accepted = await getMessageById(rows[0].id, "alice", undefined, true);
  if (editKeyAccepted) expect(accepted).toMatchObject({ editKey: local!.editKey, editKeyAccepted: true });
  else expect(accepted?.editKey).toBeUndefined();
  expect(await getAllOutgoing()).toEqual([]);
  await act(async () => root.unmount());
});

it.each(["direct", "group"] as const)("sends a timed %s sticker without an edit key", async (type) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const conversation: ConversationWithMembers = {
    id: "chat", type, members: [], name: null, avatarUrl: null, invitePolicy: "any_member", createdBy: "alice", createdAt: 1, updatedAt: 1,
  };
  let state!: ReturnType<typeof useSendMessage>;
  function Probe() { state = useSendMessage(conversation); return null; }
  vi.mocked(encryptGroupText).mockResolvedValue({ ciphertext: "opaque", iv: "iv", header: "header" });
  vi.mocked(api.post).mockResolvedValueOnce({ serverTimestamp: Date.now(), expiresAt: Date.now() + 60_000, expiryKind: "timed" });
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  try {
    const content = stickerToken("genshin_hoyolab_21");
    await act(async () => state.handleSend(content, { ttlSeconds: 60 }));
    const [sent] = useChatStore.getState().messages.get("chat")!;
    expect(sent).toMatchObject({ content, status: "sent", expiryKind: "timed" });
    expect(await getMessageById(sent.id, "alice", undefined, true)).not.toHaveProperty("editKey");
    expect(await (await getAppDB()).get("accountState", `message-edit-state:${JSON.stringify(["alice", sent.id])}`)).toBeUndefined();
    if (type === "direct") {
      const [, , plaintext, , options] = vi.mocked(prepareDirectPayloadFanout).mock.calls[0];
      expect(plaintext).toBe(content);
      expect(options).toMatchObject({ ttlSeconds: 60 });
      expect(options).not.toHaveProperty("editKey");
    } else {
      expect(encryptGroupText).toHaveBeenCalledExactlyOnceWith("chat", content);
      expect(api.post).toHaveBeenCalledWith("/api/messages/send", expect.objectContaining({ ttlSeconds: 60 }));
    }
    expect(await getAllOutgoing()).toEqual([]);
  } finally { await act(async () => root.unmount()); }
});

it("blocks text, files and revisions before queuing while the current group timeout is active", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const serverTime = Date.now() - 3_600_000;
  const conversation = observeGroupClock({
    id: "chat", type: "group", serverTime, name: null, avatarUrl: null, invitePolicy: "any_member",
    createdAt: 1, updatedAt: 1, createdBy: "alice",
    members: [{ conversationId: "chat", userId: "alice", role: "member", joinedAt: 1, acceptedAt: 1,
      timedOutUntil: serverTime + 600_000, user: { username: "alice", displayName: "Alice", avatarUrl: null } }],
  });
  let state!: ReturnType<typeof useSendMessage>;
  function Probe() { state = useSendMessage(conversation); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  try {
    await act(async () => {
      await state.handleSend("blocked", { ttlSeconds: null });
      await state.handleSendFile(new File(["blocked"], "file.txt"), { ttlSeconds: null });
      expect(await state.handleEdit("original", "blocked", 0)).toBe(false);
    });
    expect(state.sendError).toBe("You’re timed out in this group.");
    expect(api.post).not.toHaveBeenCalled();
    expect(await getAllOutgoing()).toEqual([]);
  } finally { await act(async () => root.unmount()); }
});

it("rejects a sticker token as the replacement for an editable text message", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const conversation = { id: "chat", type: "direct", members: [{ userId: "alice", acceptedAt: 1 }] } as ConversationWithMembers;
  let state!: ReturnType<typeof useSendMessage>;
  function Probe() { state = useSendMessage(conversation); return null; }
  await saveMessage({ id: "original", conversationId: "chat", senderId: "alice", type: "text", content: "Original",
    editKey: signingKey, editSigningKey: signingKey, editSenderDeviceId: "device", editKeyAccepted: true,
    timestamp: Date.now(), expiresAt: Date.now() + 60_000, status: "sent" });
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  try {
    await act(async () => expect(await state.handleEdit("original", stickerToken("genshin_hoyolab_21"), 0)).toBe(false));
    expect(state.sendError).toBe("You can't change a message into a sticker");
    expect(encryptMessageEdit).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(await getAllOutgoing()).toEqual([]);
    expect(await getMessageById("original")).toMatchObject({ content: "Original" });
  } finally { await act(async () => root.unmount()); }
});

it("leaves no local edit key when a legacy tab sends an unprepared draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let state!: ReturnType<typeof useSendMessage>;
  const conversation = { id: "chat", type: "direct" } as ConversationWithMembers;
  function Probe() { state = useSendMessage(conversation); return null; }
  let metadata!: (value: ConversationWithMembers) => void;
  vi.mocked(api.get).mockReturnValueOnce(new Promise((resolve) => { metadata = resolve; }));
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  let sent!: Promise<void>;
  act(() => { sent = state.handleSend("legacy drain", { ttlSeconds: null }); });
  await act(async () => { await vi.waitFor(() => expect(api.get).toHaveBeenCalled()); });
  const [queued] = await getAllOutgoing();
  const db = await getAppDB();
  const draft = await db.get("displayMessages", ["alice", queued.id]);
  expect(draft.editKey).toBeUndefined();
  const tx = db.transaction(["displayMessages", "accountState"], "readwrite");
  await tx.objectStore("displayMessages").put({ ...draft, status: "sent" });
  await tx.objectStore("accountState").delete(`outgoing-account:${JSON.stringify(["alice", queued.id])}`);
  await tx.done;
  await act(async () => { metadata(conversation); await sent; });
  expect(api.post).not.toHaveBeenCalled();
  expect((await getMessageById(queued.id))?.editKey).toBeUndefined();
  expect(await db.get("accountState", `message-edit-state:${JSON.stringify(["alice", queued.id])}`)).toBeUndefined();
  await act(async () => root.unmount());
});

it.each(["before save", "during encryption"])("refuses to queue a draft whose base changed %s", async (when) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const conversation = { id: "chat", type: "direct", members: [{ userId: "alice", acceptedAt: 1 }] } as ConversationWithMembers;
  let state!: ReturnType<typeof useSendMessage>;
  function Probe() { state = useSendMessage(conversation); return null; }
  const root = createRoot(document.createElement("div"));
  const alreadyChanged = when === "before save";
  await saveMessage({ id: "original", conversationId: "chat", senderId: "alice", type: "text",
    content: alreadyChanged ? "newer" : "opened", editSequence: alreadyChanged ? 2 : 1,
    editKey: signingKey, editSigningKey: signingKey, editSenderDeviceId: "device", editKeyAccepted: true,
    timestamp: Date.now(), expiresAt: Date.now() + 60_000, status: "sent" });
  if (!alreadyChanged) vi.mocked(encryptMessageEdit).mockImplementationOnce(async () => {
    const db = await getAppDB();
    const tx = db.transaction(["displayMessages", "accountState"], "readwrite");
    const messages = tx.objectStore("displayMessages"), sync = tx.objectStore("accountState");
    await messages.put({ ...await messages.get(["alice", "original"]), content: "newer", editSequence: 2 });
    await sync.put({ ...await sync.get('message-edit-state:["alice","original"]'), editSequence: 2 });
    await tx.done;
    return { nonce: "nonce", ciphertext: "ciphertext", signature: "signature" };
  });
  await act(async () => root.render(<Probe />));
  try {
    await act(async () => expect(await state.handleEdit("original", "stale draft", 1)).toBe(false));
    expect(state.sendError).toContain("This message changed while you were editing");
    expect(encryptMessageEdit).toHaveBeenCalledTimes(alreadyChanged ? 0 : 1);
    if (!alreadyChanged) expect(vi.mocked(encryptMessageEdit).mock.calls[0][3]).toBe(2);
    expect(await getAllOutgoing()).toEqual([]);
    expect(api.post).not.toHaveBeenCalled();
    expect(await getMessageById("original")).toMatchObject({ content: "newer", editSequence: 2 });
  } finally { await act(async () => root.unmount()); }
});

it.each([
  ["installer.dmg", "application/x-apple-diskimage", "application/octet-stream"],
  ["archive.zip", "application/zip", "application/octet-stream"],
  ["document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"],
  ["photo.png", "image/png", "image/png"],
  ["photo.avif", "image/avif", "image/avif"],
  ["photo.heif", "image/heif", "image/heif"],
  ["video.mov", "video/quicktime", "video/quicktime"],
  ["vector.svg", "image/svg+xml", "application/octet-stream"],
])("uploads %s with supported media metadata and preserves its name and type for message encryption", async (fileName, mimeType, uploadType) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let state!: ReturnType<typeof useSendMessage>;
  function Probe() { state = useSendMessage({ id: "chat", type: "direct" } as ConversationWithMembers); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  try {
    const file = new File([new Uint8Array([1, 2, 3])], fileName, { type: mimeType });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3]).buffer });
    await act(async () => state.handleSendFile(file, { ttlSeconds: null }));
    expect(api.post).toHaveBeenCalledWith("/api/files/upload-url", { conversationId: "chat", mimeType: uploadType, sizeBytes: 3 });
    expect(api.put).toHaveBeenCalledWith("/upload", new Uint8Array([9, 8, 7]).buffer);
    const encryptedContent = JSON.parse(vi.mocked(prepareDirectPayloadFanout).mock.calls[0][2]);
    expect(encryptedContent).toEqual({ fileId: "file", fileName, mimeType, size: 3, fileKey: "private-key", iv: "private-iv" });
    expect(JSON.stringify(vi.mocked(api.post).mock.calls)).not.toContain(fileName);
    expect(JSON.stringify(vi.mocked(api.post).mock.calls)).not.toContain("private-key");
    expect(useChatStore.getState().messages.get("chat")).toMatchObject([{ status: "sent", content: JSON.stringify(encryptedContent) }]);
    expect(await getAllOutgoing()).toEqual([]);
  } finally { await act(async () => root.unmount()); }
});

it.each(["upload-url", "PUT", "encryption"])("clears file preparation and shows a failed file after a %s error", async (stage) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let state!: ReturnType<typeof useSendMessage>;
  function Probe() { state = useSendMessage({ id: "chat", type: "direct" } as ConversationWithMembers); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  try {
    const error = Object.assign(new Error("Invalid upload"), { status: 400 });
    if (stage === "upload-url") vi.mocked(api.post).mockRejectedValueOnce(error);
    else if (stage === "PUT") vi.mocked(api.put).mockRejectedValueOnce(error);
    else vi.mocked(encryptFile).mockRejectedValueOnce(new Error("Encryption failed"));
    const file = new File(["data"], "installer.dmg", { type: "application/x-apple-diskimage" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1]).buffer });
    await act(async () => state.handleSendFile(file, { ttlSeconds: null }));
    const [row] = await getAllOutgoing();
    expect(row).toMatchObject({ status: "failed", retryable: false, error: stage === "encryption" ? "fileEncryptionWasInterruptedAttachTheFileAgain" : "fileCouldNotBeUploaded" });
    expect(await getMessageById(row.id)).toMatchObject({ status: "failed" });
    expect(useChatStore.getState().messages.get("chat")).toMatchObject([{ status: "failed" }]);
    expect(setFilePreparing).toHaveBeenNthCalledWith(1, row.id, true);
    expect(setFilePreparing).toHaveBeenLastCalledWith(row.id, false);
    expect(state.outgoing).toMatchObject([{ status: "failed", error: stage === "encryption" ? "File encryption was interrupted. Attach the file again." : "This file couldn't be uploaded" }]);
    await act(async () => state.discard(row.id));
    expect(await getAllOutgoing()).toEqual([]);
    expect(useChatStore.getState().messages.get("chat")).toEqual([]);
  } finally { await act(async () => root.unmount()); }
});

it.each(["hidden-success", "hidden-failure", "deleted-success", "deleted-failure", "discard-success", "discard-failure"])("does not republish a file after %s during preparation", async (scenario) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let state!: ReturnType<typeof useSendMessage>;
  function Probe() { state = useSendMessage({ id: "chat", type: "direct" } as ConversationWithMembers); return null; }
  const root = createRoot(document.createElement("div"));
  let finish!: () => void;
  let reject!: () => void;
  vi.mocked(encryptFile).mockImplementationOnce(() => new Promise((resolve, fail) => {
    finish = () => resolve(new Uint8Array([9])); reject = () => fail(new Error("Encryption failed after removal"));
  }));
  await act(async () => root.render(<Probe />));
  try {
    const file = new File(["data"], "private.txt", { type: "text/plain" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1]).buffer });
    let sending!: Promise<void>;
    act(() => { sending = state.handleSendFile(file, { ttlSeconds: null }); });
    await act(async () => { await vi.waitFor(() => expect(encryptFile).toHaveBeenCalled()); });
    const message = useChatStore.getState().messages.get("chat")![0];
    const { removeLocalMessageContent } = await import("../../db/index.js");
    const { deleteMessageForLocalUserOnly } = await import("../../lib/message-sync.js");
    await act(async () => {
      if (scenario.startsWith("deleted")) {
        await removeLocalMessageContent(message.id, { ...message, content: "", deletedAt: 123, deletedByUserId: "alice" });
        useChatStore.getState().addMessage("chat", { ...message, content: "", deletedAt: 123 });
      } else {
        await state.discard(message.id);
        if (scenario.startsWith("hidden")) await deleteMessageForLocalUserOnly("chat", message.id);
      }
      if (scenario.endsWith("failure")) reject(); else finish();
      await sending;
    });
    if (scenario.startsWith("deleted")) {
      expect(await getMessageById(message.id)).toMatchObject({ content: "", deletedAt: 123 });
      expect(useChatStore.getState().messages.get("chat")![0]).toMatchObject({ content: "", deletedAt: 123 });
      await act(async () => state.discard(message.id));
    } else {
      expect(await getMessageById(message.id)).toBeUndefined();
      expect(useChatStore.getState().messages.get("chat")).toEqual([]);
    }
    expect(await getAllOutgoing()).toEqual([]);
    expect(state.sendError).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
