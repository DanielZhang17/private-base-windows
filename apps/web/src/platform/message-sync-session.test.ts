import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {} from "vitest/jsdom";
import { WSFrameType, type WSMessageFrame } from "@e2ee-chat/shared";
import * as db from "../db/index.js";
import { queryClient } from "../lib/query-client.js";
import { decryptMessage } from "../lib/message-processor.js";
import {
  ingestMessageFrame,
  loadOlderPersistedConversationMessages,
  loadPersistedConversationMessages,
  resetMessageSyncState,
  syncMessages,
} from "../lib/message-sync.js";
import { useAuthStore } from "../stores/authStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { clearAccountScopedState } from "./session.js";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "localStorage", { value: jsdom.window.localStorage, configurable: true });
});
vi.mock("../lib/key-manager.js", () => ({ lockLocalCryptoState: vi.fn(), keysLoaded: () => false }));
vi.mock("../lib/message-processor.js", () => ({ decryptMessage: vi.fn(), decryptGroupText: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const signedIn = {
  accessToken: "old-access", refreshToken: null, sessionId: "old-login",
  user: { id: "old-user" } as never, device: { id: "old-device" } as never,
};
const plaintext = "old account private plaintext";
const receiveProvenSocket = (frame: WSMessageFrame) =>
  ingestMessageFrame(frame, undefined, { source: "socket", liveConfirmed: true });
const frame = (): WSMessageFrame => ({
  type: WSFrameType.Message, id: "late-message", conversationId: "conv",
  senderId: "peer", senderDeviceId: "peer-device", msgType: "text",
  ciphertext: "opaque", iv: "iv", header: "{}", timestamp: Date.now(),
  expiresAt: Date.now() + 60_000, expiryKind: "retention",
});
const localMessage = (id: string, timestamp: number): db.LocalMessage => ({
  id, ownerId: "old-user", conversationId: "conv", senderId: "peer", type: "text", content: plaintext,
  timestamp, expiresAt: Date.now() + 60_000, expiryKind: "retention", status: "delivered",
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetMessageSyncState();
  clearAccountScopedState();
  localStorage.clear();
  const database = await db.getAppDB();
  await Promise.all(Array.from(database.objectStoreNames, (name) => database.clear(name)));
  useAuthStore.setState(signedIn);
  queryClient.setQueryData(["conversations"], [{ id: "conv", type: "direct", updatedAt: 1, members: [] }]);
  useChatStore.setState({ activeConversationId: "conv" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetMessageSyncState();
  clearAccountScopedState();
});

async function completeDecrypt(content: string, receive: Parameters<typeof decryptMessage>[2]) {
  await db.commitReceivedMessage(receive.messageId, await receive.prepare(new TextEncoder().encode(content)));
  return content;
}
function changeSession(change: "expiry" | "relogin" | "other-user" | "other-device") {
  clearAccountScopedState();
  if (change === "expiry") {
    useAuthStore.getState().logout();
    resetMessageSyncState();
  } else if (change === "relogin") {
    // The same account starts a new login, without depending on an epoch reset.
    useAuthStore.setState({ sessionId: "new-login" });
  } else if (change === "other-device") {
    useAuthStore.setState({ device: { id: "other-device" } as never });
  } else {
    // Check the user ID independently, including a legacy/repaired session identity.
    useAuthStore.setState({ user: { id: "other-user" } as never });
  }
}

describe("message work surviving session expiry", () => {
  it.each(["live", "sync"])("persists an in-flight %s decrypt after expiry without restoring plaintext, then reloads it for the same user", async (source) => {
    const started = deferred<void>();
    const decrypted = deferred<string>();
    vi.mocked(decryptMessage).mockImplementation((...args) => {
      started.resolve();
      return decrypted.promise.then((content) => completeDecrypt(content, args[2]));
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [frame()], hasMore: false }))));
    const pending = source === "live" ? receiveProvenSocket(frame()) : syncMessages({ force: true });
    await started.promise;
    changeSession("expiry");
    decrypted.resolve(plaintext);
    await pending;
    expect(useChatStore.getState().messages.size).toBe(0);
    expect(useChatStore.getState().unreadCounts.size).toBe(0);
    expect(useChatStore.getState().conversations).toEqual([]);
    expect(await db.getMessageById("late-message")).toMatchObject({ content: plaintext });

    useAuthStore.setState({ ...signedIn, sessionId: "new-login" });
    await loadPersistedConversationMessages("conv");
    expect(useChatStore.getState().messages.get("conv")).toMatchObject([{ id: "late-message", content: plaintext }]);
    expect(decryptMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["relogin", "other-user", "other-device"] as const)("keeps a completed decrypt out of a changed session (%s) without needing an epoch reset", async (change) => {
    const started = deferred<void>();
    const decrypted = deferred<string>();
    vi.mocked(decryptMessage).mockImplementation((...args) => {
      started.resolve();
      return decrypted.promise.then((content) => completeDecrypt(content, args[2]));
    });
    const pending = receiveProvenSocket(frame());
    await started.promise;
    changeSession(change);
    decrypted.resolve(plaintext);
    await pending;
    expect(useChatStore.getState().messages.size).toBe(0);
    expect(await db.getMessageById("late-message")).toMatchObject({ content: plaintext });
  });

  it("keeps showing a completed decrypt across token rotation in the same login", async () => {
    const started = deferred<void>();
    const decrypted = deferred<string>();
    vi.mocked(decryptMessage).mockImplementation((...args) => {
      started.resolve();
      return decrypted.promise.then((content) => completeDecrypt(content, args[2]));
    });
    const pending = receiveProvenSocket(frame());
    await started.promise;
    useAuthStore.getState().setTokens("rotated-access", "rotated-refresh");
    decrypted.resolve(plaintext);
    await pending;
    expect(useChatStore.getState().messages.get("conv")).toMatchObject([{ id: "late-message", content: plaintext }]);
  });

  it.each(["relogin", "other-user", "other-device"] as const)("drops a sync response for a changed session (%s) before starting decryption", async (change) => {
    const started = deferred<void>();
    const response = deferred<Response>();
    vi.mocked(decryptMessage).mockResolvedValue(plaintext);
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      if (path.startsWith("/api/messages/sync?")) {
        started.resolve();
        return response.promise;
      }
      return Promise.resolve(new Response(JSON.stringify({ id: "conv", type: "direct", updatedAt: 1, members: [] })));
    }));
    const pending = syncMessages({ force: true });
    await started.promise;
    changeSession(change);
    response.resolve(new Response(JSON.stringify({ messages: [frame()], hasMore: false })));
    await pending;
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages.size).toBe(0);
    expect(await db.getMessageById("late-message")).toBeUndefined();
  });
});

describe.each(["initial", "older"])("%s persisted history", (page) => {
  it.each(["expiry", "relogin", "other-user", "other-device"] as const)("does not restore plaintext after %s while IndexedDB was being read", async (change) => {
    await db.saveMessage(localMessage("older", 100));
    if (page === "older") useChatStore.getState().addMessage("conv", localMessage("newer", 200) as never);
    const started = deferred<void>();
    const loaded = deferred<void>();
    const read = db.getCachedConversationMessagesPage;
    vi.spyOn(db, "getCachedConversationMessagesPage").mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      started.resolve();
      await loaded.promise;
      return result;
    });
    const pending = page === "initial" ? loadPersistedConversationMessages("conv") : loadOlderPersistedConversationMessages("conv");
    await started.promise;
    changeSession(change);
    loaded.resolve();
    await expect(pending).resolves.toEqual({ loadedCount: 0, hasOlder: false });
    expect(useChatStore.getState().messages.size).toBe(0);
    expect(await db.getMessageById("older")).toMatchObject({ content: plaintext });
  });
});
