import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DeviceLinkPage from "./DeviceLinkPage.js";
import { useDevices } from "../features/devices/useDevices.js";
import { ToastProvider } from "../ui/index.js";
import { click, setupDom } from "../ui/test-utils.js";
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
async function show() {
  vi.mocked(useDevices).mockReturnValue({ pendingRequests: [request], devices: [], hasRecoveryKey: true, handleCancel: cancel, handleApprove: approve, handleReject: reject, copyRecoveryKey: vi.fn(), saveRecoveryKey: vi.fn(), navigate: vi.fn() } as unknown as ReturnType<typeof useDevices>);
  await render(<MemoryRouter>
    <DeviceLinkPage />
  </MemoryRouter>);
}
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
