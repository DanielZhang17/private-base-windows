import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationWithMembers } from "@e2ee-chat/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encryptFile } from "@e2ee-chat/crypto";
import { useSendMessage } from "./useSendMessage.js";
import { useChatStore } from "../../stores/chatStore.js";
import { getAllOutgoing, getAppDB, getMessageById } from "../../db/index.js";
import { api } from "../../services/api.js";
import { prepareDirectPayloadFanout } from "../../lib/direct-messages.js";
import { setFilePreparing } from "./outgoingQueue.js";
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "alice" }, device: { id: "device" }, accessToken: "token" })) };
});
vi.mock("../../lib/key-manager.js", () => ({ keysLoaded: () => true }));
vi.mock("../../services/api.js", () => ({ api: { get: async () => ({}), post: vi.fn(), put: vi.fn() } }));
vi.mock("../../lib/direct-messages.js", () => ({ prepareDirectPayloadFanout: vi.fn(async () => ({ messages: [{ ciphertext: "opaque", iv: "iv", header: "header" }] })) }));
vi.mock("@e2ee-chat/crypto", () => ({ generateFileKey: () => ({ key: "private-key", iv: "private-iv" }), encryptFile: vi.fn() }));
vi.mock("./outgoingQueue.js", async (original) => {
  const queue = await original<typeof import("./outgoingQueue.js")>();
  return { ...queue, setFilePreparing: vi.fn(queue.setFilePreparing) };
});
vi.mock("../../lib/group-session.js", () => ({ prepareSenderKeyDistribution: vi.fn(), finishSenderKeyDistribution: vi.fn() }));
vi.mock("../../lib/message-processor.js", () => ({ encryptGroupText: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ touchConversationInCache: vi.fn() }));
const receipt = { serverTimestamp: 123, expiresAt: 999999, expiryKind: "retention" };
beforeEach(async () => {
  vi.clearAllMocks();
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  useChatStore.setState({ messages: new Map() });
  vi.mocked(encryptFile).mockResolvedValue(new Uint8Array([9, 8, 7]));
  vi.mocked(api.put).mockResolvedValue({ success: true });
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/files/upload-url" ? { fileId: "file", uploadUrl: "/upload" } : receipt) as never);
});
afterEach(() => vi.unstubAllGlobals());
it("shows an outgoing message immediately while its ciphertext POST is pending", async () => {
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
  await act(async () => {
    resolve({ serverTimestamp: Date.now(), expiresAt: Date.now() + 60000, expiryKind: "retention" });
    await sent;
  });
  expect(useChatStore.getState().messages.get("chat")).toMatchObject([{ content: "hello", status: "sent" }]);
  expect(await getAllOutgoing()).toEqual([]);
  await act(async () => root.unmount());
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
