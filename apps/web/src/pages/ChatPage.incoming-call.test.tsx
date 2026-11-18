import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { getByRole } from "@testing-library/dom";
import { expect, it, vi } from "vitest";
import { encryptMessageEdit, generateAESKey, generateIdentityKeyPair, toBase64Url } from "@e2ee-chat/crypto";
import { CallProvider } from "../features/calls/CallProvider.js";
import Layout from "../components/layout/Layout.js";
import { getAppDB, saveMessage } from "../db/index.js";
import { setLocalEncryptionKey } from "../lib/local-key-encryption.js";
import { resetMessageSyncState } from "../lib/message-sync.js";
import { queryClient } from "../lib/query-client.js";
import { capabilities } from "../platform/capabilities.js";
import { api } from "../services/api.js";
import { createChatWebSocket } from "../services/ws.js";
import { useCallStore } from "../stores/callStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { ToastProvider } from "../ui/index.js";
import ChatPage from "./ChatPage.js";

vi.mock("../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "bob", displayName: "Bob" }, device: { id: "bob-phone" }, accessToken: "token", sessionId: "session" })) };
});
vi.mock("../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() }, resolveApiUrl: (path: string) => path }));
vi.mock("../services/ws.js", () => ({ createChatWebSocket: vi.fn() }));
vi.mock("../lib/key-manager.js", () => ({ keysLoaded: () => true, getUnlockGeneration: () => 1 }));
vi.mock("./ChatListPage.js", () => ({ default: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("keeps the open conversation and incoming dialog mounted and focused through metadata and edit reconciliation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  vi.mocked(createChatWebSocket).mockReturnValue({ close: vi.fn() } as unknown as WebSocket);
  const conversation = { id: "chat", type: "direct", members: [
    { userId: "alice", acceptedAt: 1, user: { id: "alice", displayName: "Alice" } },
    { userId: "bob", acceptedAt: 1, user: { id: "bob", displayName: "Bob" } },
  ] };
  const details = deferred<typeof conversation>();
  const latest = deferred<{ edits: unknown[] }>();
  const accepted = deferred<object>();
  vi.mocked(api.get).mockImplementation(async (path) => (path === "/api/conversations/chat" ? details.promise
    : path.startsWith("/api/messages/sync?") ? { messages: [], hasMore: false, editStream: true } : []) as never);
  vi.mocked(api.post).mockImplementation(async (path) => (path === "/api/messages/edits/latest" ? latest.promise : accepted.promise) as never);

  const key = generateAESKey(), author = await generateIdentityKeyPair();
  const scope = { conversationId: "chat", messageId: "original", senderId: "alice", senderDeviceId: "alice-phone" };
  const now = Date.now();
  const edit = { ...scope, ...await encryptMessageEdit(key, author.privateEd25519, scope, 1, "Reconciled text"), editSeq: 1,
    mutationSeq: 1, editedAt: now, expiresAt: now + 60_000 };
  setLocalEncryptionKey(await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
  await saveMessage({ ...scope, ownerId: "bob", id: scope.messageId, type: "text", content: "Cached original", status: "delivered", timestamp: now - 1,
    expiresAt: edit.expiresAt, editKeyAccepted: true, editKey: toBase64Url(key), editSigningKey: toBase64Url(author.publicEd25519), editSenderDeviceId: scope.senderDeviceId });

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={["/chat/chat"]}>
      <QueryClientProvider client={queryClient}><ToastProvider><CallProvider enabled>
        <Routes><Route element={<Layout />}><Route path="/chat/:conversationId" element={<ChatPage />} /></Route></Routes>
      </CallProvider></ToastProvider></QueryClientProvider>
    </MemoryRouter>));
    const log = getByRole(host, "log");
    const back = getByRole(host, "button", { name: "Back to conversations" });
    const composer = getByRole(host, "textbox", { name: "Message" });
    await act(async () => useCallStore.getState().setIncomingCall({ callId: "call-1", conversationId: "chat", callType: "video",
      initiatorId: "alice", callerUserId: "alice", callerName: "Alice", keyReady: true }));
    const dialog = getByRole(host, "dialog", { name: "Incoming call" });
    const accept = getByRole(dialog, "button", { name: "Accept" });
    accept.focus();
    expect(document.activeElement).toBe(accept);

    await act(async () => details.resolve(conversation));
    await act(async () => vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/messages/edits/latest", { ids: ["original"], after: { original: 0 } })));
    expect(document.activeElement).toBe(accept);
    await act(async () => latest.resolve({ edits: [edit] }));
    await act(async () => vi.waitFor(() => expect(useChatStore.getState().messages.get("chat")?.[0]?.content).toBe("Reconciled text")));

    expect(log.textContent).toContain("Reconciled text");
    expect(getByRole(host, "log")).toBe(log);
    expect(getByRole(host, "button", { name: "Back to conversations" })).toBe(back);
    expect(getByRole(host, "textbox", { name: "Message" })).toBe(composer);
    expect(getByRole(host, "dialog", { name: "Incoming call" })).toBe(dialog);
    expect(getByRole(dialog, "button", { name: "Accept" })).toBe(accept);
    expect(createChatWebSocket).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(accept);
    await act(async () => accept.click());
    expect(api.post).toHaveBeenCalledWith("/api/calls/call-1/accept");
  } finally {
    await act(async () => { root.unmount(); accepted.resolve({}); });
    resetMessageSyncState();
    queryClient.clear();
    useCallStore.getState().clearAllCalls();
    const db = await getAppDB();
    await Promise.all([db.clear("displayMessages"), db.clear("accountState")]);
    setLocalEncryptionKey(null);
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
