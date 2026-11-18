import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCallInvitationOwner } from "./useCallInvitationOwner.js";
import { IncomingCallContext } from "./IncomingCallContext.js";
import { useIncomingCall } from "./useIncomingCall.js";
import { useCallStore } from "../../stores/callStore.js";
import { capabilities } from "../../platform/capabilities.js";
import { api } from "../../services/api.js";
import IncomingCallModal from "../../components/calls/IncomingCallModal.js";
import { getByRole } from "@testing-library/dom";
vi.mock("../../services/api.js", () => ({ api: { post: vi.fn() } }));
let result: ReturnType<typeof useIncomingCall>; let root: Root; let host: HTMLDivElement;
function Probe() { result = useIncomingCall(); return null; }
function Owner() { const owner = useCallInvitationOwner(true); return <IncomingCallContext.Provider value={owner}><Probe /><IncomingCallModal /></IncomingCallContext.Provider>; }
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  useCallStore.setState({ activeCallId: "incoming", direction: "incoming", callStatus: "ringing", callType: "audio", keyReady: true });
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(<MemoryRouter><Owner /></MemoryRouter>));
});
afterEach(async () => { await act(async () => root.unmount()); useCallStore.getState().clearAllCalls(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("requires the encrypted invitation key before accepting", async () => {
  await act(async () => useCallStore.setState({ keyReady: false }));
  await act(async () => result.respond("accept"));
  expect(api.post).not.toHaveBeenCalled();
});
it("accepts from the first click on the dialog as soon as its secure invite becomes ready", async () => {
  vi.mocked(api.post).mockResolvedValueOnce({} as never);
  await act(async () => useCallStore.getState().clearAllCalls());
  const observer = new MutationObserver(() => {
    const button = getByRole<HTMLButtonElement>(host, "button", { name: "Accept" });
    observer.disconnect();
    button.click();
  });
  observer.observe(host, { childList: true, subtree: true });
  try {
    await act(async () => useCallStore.getState().setIncomingCall({ callId: "incoming", conversationId: "chat", callType: "video",
      initiatorId: "alice", callerUserId: "alice", callerName: "Alice", keyReady: false }));
    expect(result.loadingAction).toBe("accept");
    expect(api.post).not.toHaveBeenCalled();
  } finally {
    observer.disconnect();
  }
  await act(async () => useCallStore.getState().markKeyReady("incoming"));
  expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/calls/incoming/accept");
  expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "incoming", reason: "accepted" });
});

it("drops a pre-key click if the call is accepted elsewhere before the key arrives", async () => {
  await act(async () => useCallStore.getState().markKeyReady("incoming", false));
  await act(async () => getByRole<HTMLButtonElement>(host, "button", { name: "Accept" }).click());
  await act(async () => useCallStore.getState().updateCallStatus("incoming", "active"));
  await act(async () => useCallStore.getState().markKeyReady("incoming"));
  expect(api.post).not.toHaveBeenCalled();
  expect(useCallStore.getState().localCallOwnership).toBeNull();
});
it("keeps a failed response visible and lets the user retry", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("Offline"));
  await act(async () => result.respond("accept"));
  expect(result.error).toBe("Could not respond to call\nOffline"); expect(result.visible).toBe(true);
  vi.mocked(api.post).mockResolvedValueOnce({} as never);
  await act(async () => result.respond("accept"));
  expect(useCallStore.getState().callStatus).toBe("active");
});
it("prevents acceptance on a device without encrypted calling", async () => {
  vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(false);
  await act(async () => root.render(<MemoryRouter><Owner /></MemoryRouter>));
  await act(async () => result.respond("accept"));
  expect(result.callUnsupported).toBe(true); expect(api.post).not.toHaveBeenCalled();
});

it("keeps the incoming modal's identity tied to the caller", async () => {
  await act(async () => useCallStore.setState({ callerName: "Mara", callerAvatarUrl: "/mara.png", conversationName: "Field team" }));
  expect(result.callerName).toBe("Mara");
  expect(result.callerAvatarUrl).toBe("/mara.png");
  expect(result.visible).toBe(true);
});
