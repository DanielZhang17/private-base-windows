import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationWithMembers } from "@e2ee-chat/shared";
import { getAllOutgoing, getAppDB } from "../../db/index.js";
import { useSendMessage } from "./useSendMessage.js";
import { refreshOutgoingQueue } from "./outgoingQueue.js";
import { setLocalePreference, t } from "../../i18n/index.js";
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "alice" }, device: { id: "device" }, accessToken: "token", sessionId: "session" })) };
});
vi.mock("../../lib/key-manager.js", () => ({ keysLoaded: () => true }));
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../../lib/direct-messages.js", () => ({ prepareDirectPayloadFanout: vi.fn() }));
vi.mock("../../lib/group-session.js", () => ({ prepareSenderKeyDistribution: vi.fn(), finishSenderKeyDistribution: vi.fn() }));
vi.mock("../../lib/message-processor.js", () => ({ encryptGroupText: vi.fn() }));
vi.mock("../../lib/conversation-cache.js", () => ({ touchConversationInCache: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
it("keeps an interrupted file locale-neutral in IndexedDB and displays English after remount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const db = await getAppDB();
  for (const name of Array.from(db.objectStoreNames)) await db.clear(name);
  const conversation = { id: "chat", type: "direct" } as ConversationWithMembers;
  let flow!: ReturnType<typeof useSendMessage>;
  function Probe() { flow = useSendMessage(conversation); return <p>{flow.outgoing[0]?.error}</p>; }
  const container = document.createElement("div");
  let root = createRoot(container);
  await setLocalePreference("de");
  await act(async () => root.render(<Probe />));
  const file = new File(["content"], "attachment.txt");
  // Interrupt file preparation before any encrypted upload bytes can be persisted.
  Object.defineProperty(file, "arrayBuffer", { value: async () => { throw new Error("abgebrochen"); } });
  await act(async () => { await flow.handleSendFile(file, { ttlSeconds: null }); });
  expect((await getAllOutgoing())[0].error).toBe("fileEncryptionWasInterruptedAttachTheFileAgain");
  expect(container.textContent).toBe(t("fileEncryptionWasInterruptedAttachTheFileAgain"));
  await act(async () => root.unmount());
  await setLocalePreference("en");
  root = createRoot(container);
  await act(async () => { await refreshOutgoingQueue(); root.render(<Probe />); });
  expect(container.textContent).toBe("File encryption was interrupted. Attach the file again.");
  expect((await getAllOutgoing())[0].error).toBe("fileEncryptionWasInterruptedAttachTheFileAgain");
  await act(async () => root.unmount());
});
