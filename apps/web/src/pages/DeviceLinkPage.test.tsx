import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DeviceLinkPage from "./DeviceLinkPage.js";
import { useDevices } from "../features/devices/useDevices.js";
import { ToastProvider } from "../ui/index.js";
import { click, setupDom } from "../ui/test-utils.js";
import { capabilities } from "../platform/capabilities.js";
import { TRANSFER_RECEIVE_PATH, TRANSFER_SEND_PATH } from "../features/transfer/HistoryTransferScreens.js";
import * as transfer from "../features/transfer/useHistoryTransfer.js";
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
    expect(getByRole(document.body, "region", { name: "Transfer history" })).toBeTruthy();
    expect(getByRole(document.body, "button", { name: /get history on this device/i })).toBeTruthy();
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

function Location() {
  const { pathname, search } = useLocation();
  return <p data-testid="location">{pathname + search}</p>;
}
async function showTransfer(enabled: boolean, flow: Partial<ReturnType<typeof transfer.useHistoryTransfer>> = {}) {
  const previous = capabilities.historyTransfer;
  capabilities.historyTransfer = enabled;
  const dismiss = vi.fn();
  vi.spyOn(transfer, "useHistoryTransfer").mockReturnValue({ phase: "idle", dismiss, listInterrupted: async () => [], ...flow } as unknown as ReturnType<typeof transfer.useHistoryTransfer>);
  vi.mocked(useDevices).mockReturnValue({ pendingRequests: [], devices: [], hasRecoveryKey: true } as unknown as ReturnType<typeof useDevices>);
  try {
    await render(<MemoryRouter initialEntries={["/devices"]}><Routes>
      <Route path="/devices" element={<DeviceLinkPage />} />
      <Route path="*" element={<Location />} />
    </Routes></MemoryRouter>);
  } finally { capabilities.historyTransfer = previous; }
  return dismiss;
}
const location = () => document.querySelector('[data-testid="location"]')?.textContent;
it("puts both transfer directions at the top of Linked devices", async () => {
  await showTransfer(true);
  const heading = getByRole(document.body, "heading", { name: "Transfer history" });
  const devices = getByRole(document.body, "heading", { name: "Your devices" });
  expect(heading.compareDocumentPosition(devices) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(getByText(document.body, "Copy messages and files directly between your own devices, end-to-end encrypted.")).toBeTruthy();
  const rows = getByRole(document.body, "region", { name: "Transfer history" }).querySelectorAll("li button");
  expect(Array.from(rows, (row) => row.textContent)).toEqual([
    "Get history on this deviceShow a code to scan with your other device",
    "Send history from this deviceScan the code on your other device",
  ]);
});
it("hides the transfer rows when history transfer is off", async () => {
  await showTransfer(false);
  expect(queryByRole(document.body, "heading", { name: "Transfer history" })).toBeNull();
  expect(queryByRole(document.body, "button", { name: /get history on this device/i })).toBeNull();
  expect(queryByRole(document.body, "button", { name: /send history from this device/i })).toBeNull();
});
it.each([
  [/get history on this device/i, TRANSFER_RECEIVE_PATH],
  [/send history from this device/i, TRANSFER_SEND_PATH],
])("starts a fresh transfer from %s", async (name, path) => {
  const dismiss = await showTransfer(true);
  await click(getByRole(document.body, "button", { name }));
  expect(dismiss).toHaveBeenCalledOnce();
  expect(location()).toBe(path);
});
it.each([
  ["transferring", "sender", "Sending to Phone· 40%", TRANSFER_SEND_PATH],
  ["transferring", "receiver", "Receiving from Phone· 40%", TRANSFER_RECEIVE_PATH],
  ["reconnecting", "sender", "Connection lost. Reconnecting…", TRANSFER_SEND_PATH],
  ["reconnecting", "receiver", "Connection lost. Reconnecting…", TRANSFER_RECEIVE_PATH],
  ["paused", "sender", "Paused · sending to Phone", TRANSFER_SEND_PATH],
  ["paused", "receiver", "Paused · receiving from Phone", TRANSFER_RECEIVE_PATH],
] as const)("offers only View transfer while %s as %s", async (phase, role, status, path) => {
  const dismiss = await showTransfer(true, { phase, role, peerDeviceName: "Phone", progress: { records: 4, totalRecords: 10, bytes: 400, totalBytes: 1000 } });
  expect(queryByRole(document.body, "button", { name: /get history on this device/i })).toBeNull();
  expect(queryByRole(document.body, "button", { name: /send history from this device/i })).toBeNull();
  const rows = getByRole(document.body, "region", { name: "Transfer history" }).querySelectorAll("li button");
  expect(Array.from(rows, (row) => row.textContent)).toEqual([`View transfer${status}`]);
  await click(rows[0] as HTMLElement);
  expect(dismiss).not.toHaveBeenCalled();
  expect(location()).toBe(path);
});
it("keeps the percentage outside the truncated device name", async () => {
  const deviceName = "A very long laptop name that will not fit on one line in the Linked devices list";
  await showTransfer(true, { phase: "transferring", role: "sender", peerDeviceName: deviceName, progress: { records: 4, totalRecords: 10, bytes: 400, totalBytes: 1000 } });
  const name = getByText(document.body, `Sending to ${deviceName}`);
  const percent = getByText(document.body, "· 40%");
  expect(name.className).toContain("truncate");
  expect(percent.className).toContain("shrink-0");
  expect(name.contains(percent)).toBe(false);
  expect(percent.parentElement).toBe(name.parentElement);
  expect(percent.closest("button")?.textContent).toContain("· 40%");
});
