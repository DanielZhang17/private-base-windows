import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useIncomingCall } from "./useIncomingCall.js";
import { useCallStore } from "../../stores/callStore.js";
import { capabilities } from "../../platform/capabilities.js";
import { api } from "../../services/api.js";
vi.mock("../../services/api.js", () => ({ api: { post: vi.fn() } }));
let result: ReturnType<typeof useIncomingCall>; let root: Root;
function Probe() { result = useIncomingCall(); return null; }
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  vi.spyOn(capabilities, "e2eeCalls", "get").mockReturnValue(true);
  useCallStore.setState({ activeCallId: "incoming", direction: "incoming", callStatus: "ringing", callType: "audio", keyReady: true });
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
});
afterEach(async () => { await act(async () => root.unmount()); useCallStore.getState().clearCall(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("requires the encrypted invitation key before accepting", async () => {
  await act(async () => useCallStore.setState({ keyReady: false }));
  await act(async () => result.respond("accept"));
  expect(api.post).not.toHaveBeenCalled();
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
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  await act(async () => result.respond("accept"));
  expect(result.callUnsupported).toBe(true); expect(api.post).not.toHaveBeenCalled();
});
