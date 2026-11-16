import { act } from "react";
import { setupDom } from "../../ui/test-utils.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
const mocks = vi.hoisted(() => ({ get: vi.fn(), sync: vi.fn(), pending: vi.fn(), native: false, navigate: vi.fn(),
  auth: { accessToken: "token", user: { id: "bob" }, device: { id: "device" }, sessionId: "session" } }));
vi.mock("../../services/api.js", () => ({ api: { get: mocks.get } }));
vi.mock("../../lib/message-sync.js", () => ({ syncMessages: mocks.sync }));
vi.mock("../../db/index.js", () => ({ getPendingCall: mocks.pending }));
vi.mock("../../stores/authStore.js", () => ({ useAuthStore: Object.assign((selector: (state: unknown) => unknown) => selector(mocks.auth), { getState: () => mocks.auth }) }));
vi.mock("../../platform/environment.js", () => ({ isNative: () => mocks.native }));
vi.mock("react-router-dom", async (original) => ({ ...await original<typeof import("react-router-dom")>(), useNavigate: () => mocks.navigate }));
import { usePushCallInvitation } from "./usePushCallInvitation.js";
import { useCallStore } from "../../stores/callStore.js";
import { clearUnlockedSessionState } from "../../platform/session-cleanup.js";

const { render } = setupDom();
function Probe({ enabled = true }: { enabled?: boolean }) { usePushCallInvitation(enabled, "call-1"); return null; }
async function show(enabled = true) {
  await render(<MemoryRouter initialEntries={["/call/call-1?push=call"]}><Probe enabled={enabled} /></MemoryRouter>);
}
beforeEach(() => {
  useCallStore.getState().clearAllCalls(); mocks.native = false;
  mocks.get.mockImplementation(async (url: string) => url.startsWith("/api/calls/")
    ? { id: "call-1", conversationId: "conv", initiatorId: "alice", type: "audio", status: "ringing" }
    : { id: "conv", members: [{ userId: "alice", user: { displayName: "Alice" } }] });
  mocks.sync.mockResolvedValue(undefined);
  mocks.pending.mockResolvedValue({ expiresAt: Date.now() + 60_000 });
});
afterEach(() => { useCallStore.getState().clearAllCalls(); vi.clearAllMocks(); });
it("restores a cold call invitation and encrypted key without accepting the call", async () => {
  await show();
  expect(useCallStore.getState().keyReady).toBe(true);
  expect(useCallStore.getState()).toMatchObject({ activeCallId: "call-1", direction: "incoming", callStatus: "ringing", callerName: "Alice", localCallOwnership: null });
  expect(mocks.sync).toHaveBeenCalledWith({ force: true });
  expect(mocks.get).toHaveBeenCalledWith("/api/calls/call-1");
});
it("opens the conversation when a stale call has ended", async () => {
  mocks.get.mockResolvedValueOnce({ id: "call-1", conversationId: "conv", initiatorId: "alice", status: "missed" });
  await show();
  expect(mocks.navigate).toHaveBeenCalledWith("/chat/conv", { replace: true });
  expect(useCallStore.getState().activeCallId).toBeNull();
});
it("does not restore an invitation after locking during a delayed fetch", async () => {
  let resolve!: (value: unknown) => void;
  mocks.get.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await show();
  clearUnlockedSessionState();
  await act(async () => { resolve({ id: "call-1", conversationId: "conv", initiatorId: "alice", type: "audio", status: "ringing" }); });
  expect(useCallStore.getState().activeCallId).toBeNull();
});
it("does not resurrect a call ended while conversation details were pending", async () => {
  let resolveConversation!: (value: unknown) => void;
  let status = "ringing";
  mocks.get.mockImplementation((url: string) => url.startsWith("/api/calls/")
    ? Promise.resolve({ id: "call-1", conversationId: "conv", initiatorId: "alice", type: "audio", status })
    : new Promise((resolve) => { resolveConversation = resolve; }));
  const incoming = vi.spyOn(useCallStore.getState(), "setIncomingCall");
  await show();
  status = "ended";
  await act(async () => { resolveConversation({ id: "conv", members: [{ userId: "alice", user: { displayName: "Alice" } }] }); });
  expect(mocks.get.mock.calls.filter(([url]) => url === "/api/calls/call-1")).toHaveLength(2);
  expect(incoming).not.toHaveBeenCalled();
  expect(useCallStore.getState().activeCallId).toBeNull();
  expect(mocks.navigate).toHaveBeenCalledWith("/chat/conv", { replace: true });
  incoming.mockRestore();
});
it("leaves native call restoration and locked sessions alone", async () => {
  mocks.native = true;
  await show();
  await show(false);
  expect(mocks.get).not.toHaveBeenCalled();
});
