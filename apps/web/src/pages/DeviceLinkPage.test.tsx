import { MemoryRouter } from "react-router-dom";
import { getByRole } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DeviceLinkPage from "./DeviceLinkPage.js";
import { useDevices } from "../features/devices/useDevices.js";
import { ToastProvider } from "../ui/index.js";
import { click, setupDom } from "../ui/test-utils.js";
import { capabilities } from "../platform/capabilities.js";
vi.mock("../features/devices/useDevices.js", () => ({ useDevices: vi.fn() }));
vi.mock("../features/settings/SettingsFrame.js", () => ({
  SettingsFrame: ({ detail }: { detail: React.ReactNode }) => <ToastProvider>
    {detail}
  </ToastProvider>
}));
const { render } = setupDom();
const cancel = vi.fn(async () => true);
const approve = vi.fn(async () => true);
const reject = vi.fn(async () => true);
let request: ReturnType<typeof useDevices>["pendingRequests"][number];
beforeEach(() => {
  vi.clearAllMocks();
  request = { id: "request", userId: "sam", deviceName: "New phone", identityKey: "public", shortCode: "482913", status: "approved", linkMethod: "approved_link", createdAt: Date.now(), expiresAt: Date.now() + 60_000, approvedByDeviceId: "this-device", codeChunks: ["482", "913"], expired: false, expiresLabel: "10:30" };
});
afterEach(() => vi.restoreAllMocks());
async function show(devices: ReturnType<typeof useDevices>["devices"] = []) {
  vi.mocked(useDevices).mockReturnValue({ pendingRequests: [request], devices, hasRecoveryKey: true, handleCancel: cancel, handleApprove: approve, handleReject: reject, copyRecoveryKey: vi.fn(), saveRecoveryKey: vi.fn(), navigate: vi.fn() } as unknown as ReturnType<typeof useDevices>);
  await render(<MemoryRouter>
    <DeviceLinkPage />
  </MemoryRouter>);
}
it("shows the saved browser and platform label in Linked devices", async () => {
  const device = { id: "new", userId: "sam", identityKey: "public", deviceName: "Chrome on macOS", platform: "web", linkMethod: "passkey",
    status: "active", createdAt: 1, activatedAt: 2, revokedAt: null, lastSeenAt: 2,
    icon: "globe", activity: "Now", activityTitle: "Today", linkedBy: "Passkey" } as const;
  await show([device]);
  const remove = getByRole(document.body, "button", { name: /remove.*chrome on macos/i });
  expect(remove.closest("li")?.textContent).toContain(device.deviceName);
});
it("shows Transfer history alongside new sign-ins and approval requests", async () => {
  const previous = capabilities.historyTransfer;
  capabilities.historyTransfer = true;
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  vi.mocked(useDevices).mockReturnValue({
    pendingRequests: [request], devices: [], hasRecoveryKey: true,
    deviceAlerts: { alerts: [{ alertId: "alert", deviceId: "other", deviceName: "Old phone", kind: "passkey_signin", platform: "web", at: Date.now() }] },
  } as unknown as ReturnType<typeof useDevices>);
  try {
    await render(<QueryClientProvider client={client}><MemoryRouter><DeviceLinkPage /></MemoryRouter></QueryClientProvider>);
    expect(getByRole(document.body, "heading", { name: "New sign-ins" })).toBeTruthy();
    expect(getByRole(document.body, "region", { name: "Device link requests" })).toBeTruthy();
    expect(getByRole(document.body, "button", { name: /transfer history/i })).toBeTruthy();
  } finally { capabilities.historyTransfer = previous; }
});
it("shows the short code prominently and Cancel for approved incomplete links", async () => {
  await show(); const code = document.querySelector('[aria-label="Approval code"]')!;
  expect(code.className).toContain("secret-text"); expect(code.textContent).toBe("482913");
  await click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Cancel")!);
  expect(cancel).toHaveBeenCalledWith(request);
});
it.each(["approved", "pending"] as const)("gives %s recovery requests no action", async (status) => {
  request = { ...request, status, linkMethod: "recovery", shortCode: null }; await show();
  const card = document.querySelector("article")!;
  expect(card.textContent).toContain("No approval is needed here."); expect(card.querySelector("button")).toBeNull();
  expect(card.querySelector(".secret-text")).toBeNull();
});
