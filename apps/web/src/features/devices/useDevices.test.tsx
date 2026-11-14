import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeviceLinkRequestSummary } from "@e2ee-chat/shared";
import { useDevices } from "./useDevices.js";
import { api } from "../../services/api.js";
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock("../../stores/authStore.js", () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ device: { id: "this-device" } }) }));
vi.mock("../../lib/device-link.js", () => ({ generateRecoveryKey: () => "secret", signDeviceLinkApproval: vi.fn(async () => "signature") }));
let root: Root;
let state: ReturnType<typeof useDevices>;
let client: QueryClient;
let requests: DeviceLinkRequestSummary[];
const approved: DeviceLinkRequestSummary = { id: "request", userId: "sam", deviceName: "Phone", identityKey: "public", shortCode: "482913", status: "approved", linkMethod: "approved_link", createdAt: Date.now(), expiresAt: Date.now() + 60_000, approvedByDeviceId: "this-device" };
function Probe() { state = useDevices(); return null; }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); requests = [{ ...approved }];
  vi.mocked(api.get).mockImplementation(async (path) => (path.endsWith("/pending") ? requests : path.endsWith("/recovery-key") ? { enrolled: true } : [{ id: "other", deviceName: "Old phone", lastSeenAt: Date.now(), linkMethod: "approved_link" }]) as never);
  vi.mocked(api.post).mockResolvedValue({}); vi.mocked(api.delete).mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); root = createRoot(document.createElement("div"));
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); vi.unstubAllGlobals(); });
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <MemoryRouter>
      <Probe />
    </MemoryRouter>
  </QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}
it("cancels an approved but incomplete approved_link via reject and refreshes requests", async () => {
  await render(); await act(async () => { expect(await state.handleCancel(approved)).toBe(true); });
  expect(api.post).toHaveBeenCalledWith("/api/device-links/request/reject");
  expect(vi.mocked(api.get).mock.calls.filter(([path]) => path.endsWith("/pending")).length).toBe(2);
});
it.each(["pending", "completed", "expired", "rejected"] as const)("does not cancel a %s request", async (status) => {
  await render(); await act(async () => { expect(await state.handleCancel({ ...approved, status })).toBe(false); }); expect(api.post).not.toHaveBeenCalled();
});
it.each(["approved", "pending"] as const)("keeps %s recovery requests informational for every action", async (status) => {
  const recovery = { ...approved, status, linkMethod: "recovery" as const }; requests = [recovery];
  await render(); await act(async () => { await state.handleCancel(recovery); await state.handleApprove(recovery); await state.handleReject(recovery.id); }); expect(api.post).not.toHaveBeenCalled();
});
it("reports cancellation failure and allows retry", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("Try again")); await render();
  await act(async () => { expect(await state.handleCancel(approved)).toBe(false); }); expect(state.error).toBe("Failed to reject device link\nTry again"); expect(state.pendingActionId).toBeNull();
  await act(async () => { expect(await state.handleCancel(approved)).toBe(true); }); expect(state.error).toBeUndefined();
});
it("requires removal confirmation and retains the target after failure", async () => {
  await render(); await act(async () => state.handleRemoveDevice("other")); expect(api.delete).not.toHaveBeenCalled(); expect(state.removalTarget?.deviceName).toBe("Old phone");
  vi.mocked(api.delete).mockRejectedValueOnce(new Error("Still linked")); await act(async () => { await state.confirmRemoveDevice(); });
  expect(state.removeError).toBe("Failed to remove device\nStill linked"); expect(state.removalTarget?.id).toBe("other");
  await act(async () => { await state.confirmRemoveDevice(); }); expect(state.removalTarget).toBeNull();
});
