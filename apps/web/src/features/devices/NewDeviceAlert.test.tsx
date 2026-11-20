import { act } from "react";
import { getByRole, queryByRole } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { DeviceAlert } from "@e2ee-chat/shared";
import { NewDeviceAlerts } from "./NewDeviceAlert.js";
import { useUnlockOfferHeld } from "../auth/unlockOfferGate.js";
import { publishDeviceAlertsChanged } from "../../services/device-alerts.js";
import { api } from "../../services/api.js";
import { isOnlyLocalPasskeyUnlock, signWithIdentityKey } from "../../lib/key-manager.js";
import { addAccountPasswordUnlock } from "../../lib/passkey-provision.js";
import { ToastProvider } from "../../ui/index.js";
import { click, setupDom } from "../../ui/test-utils.js";

vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ device: { id: "current" }, user: { id: "owner" } })) };
});
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock("../../lib/key-manager.js", () => ({
  isOnlyLocalPasskeyUnlock: vi.fn(), localPasskeyUnlockId: vi.fn(async () => undefined), removeLocalUnlockMethod: vi.fn(),
  signWithIdentityKey: vi.fn(async () => "device-signature"),
}));
vi.mock("../../lib/passkey-provision.js", () => ({ addAccountPasswordUnlock: vi.fn() }));
const { render, container } = setupDom();
let alerts: DeviceAlert[];
const alert: DeviceAlert = { alertId: "first", kind: "passkey_signin", deviceId: "removed", deviceName: "Chrome on macOS",
  platform: "web", at: Date.now(), credentialName: "Shared name" };
beforeEach(() => {
  vi.clearAllMocks();
  alerts = [];
  vi.mocked(api.get).mockImplementation(async path => path.endsWith("/privacy") ? { requireDeviceApproval: true } as never
    : path.endsWith("/alerts") ? alerts as never : [] as never);
  vi.mocked(api.post).mockImplementation(async path => path.endsWith("/options") ? { challengeId: "challenge" } as never : { success: true } as never);
  vi.mocked(isOnlyLocalPasskeyUnlock).mockResolvedValue(false);
  vi.mocked(addAccountPasswordUnlock).mockResolvedValue(undefined);
});
async function show(placement: "banner" | "devices" = "banner", compact = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(<QueryClientProvider client={client}><MemoryRouter><ToastProvider>
    <NewDeviceAlerts placement={placement} compact={compact} />
  </ToastProvider></MemoryRouter></QueryClientProvider>);
  await flushQuery();
}

function flushQuery() {
  return act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
}

it("surfaces an arriving browser alert in the app banner and rolls back a failed acknowledgement", async () => {
  await show();
  expect(queryByRole(container(), "region", { name: "Security alerts" })).toBeNull();
  alerts = [alert];
  await act(async () => publishDeviceAlertsChanged("current"));
  await flushQuery();
  expect(getByRole(container(), "alert").textContent).toContain("This device can already receive new messages");
  expect(container().querySelector("article")?.className).toContain("bg-warn-soft");
  const acknowledge = getByRole(container(), "button", { name: "It was me, keep Chrome on macOS" });
  vi.mocked(api.post).mockResolvedValueOnce({ challengeId: "challenge" }).mockRejectedValueOnce(new Error("offline"));
  await click(acknowledge);
  expect(getByRole(container(), "region", { name: "Security alerts" }).textContent).toContain("Couldn't save. Try again.");
  expect(api.post).toHaveBeenNthCalledWith(1, "/api/devices/alerts/first/ack/options");
  expect(signWithIdentityKey).toHaveBeenCalledWith(JSON.stringify([
    "privatebase-device-action-v1", "ack_device_alert", JSON.stringify(["current", "first"]), "challenge",
  ]));
  expect(api.post).toHaveBeenNthCalledWith(2, "/api/devices/alerts/first/ack", { challengeId: "challenge", signature: "device-signature" });
});

it("holds the unlock offer while a security alert is on screen", async () => {
  let held: boolean | undefined;
  function Probe() { held = useUnlockOfferHeld(); return null; }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(<QueryClientProvider client={client}><MemoryRouter><ToastProvider>
    <NewDeviceAlerts /><Probe />
  </ToastProvider></MemoryRouter></QueryClientProvider>);
  await flushQuery();
  expect(held).toBe(false);
  alerts = [alert];
  await act(async () => publishDeviceAlertsChanged("current"));
  await flushQuery();
  expect(held).toBe(true);
  alerts = [];
  await act(async () => publishDeviceAlertsChanged("current"));
  await flushQuery();
  expect(held).toBe(false);
});

it("uses the amber warning surface and the same device name in the compact alert", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  alerts = [alert];
  await show("banner", true);
  const region = getByRole(container(), "region", { name: "Security alerts" });
  const review = getByRole(region, "button", { name: "Review" });
  expect(review.parentElement?.className).toContain("bg-warn-soft");
  await click(review);
  const sheet = getByRole(document.body, "dialog", { name: "Security alerts" });
  expect(sheet.querySelector("article")?.textContent).toContain("Chrome on macOS");
});

it("confirms removal, retains the exact credential and subsequent device, and offers backup unlock", async () => {
  alerts = [alert];
  vi.mocked(isOnlyLocalPasskeyUnlock).mockResolvedValueOnce(true).mockResolvedValue(false);
  vi.mocked(api.post).mockImplementation(async path => {
    if (path.endsWith("/options")) return { challengeId: "challenge" } as never;
    alerts = [];
    return { success: true, credential: { id: "exact", credentialId: "local-credential", name: "Shared name", createdAt: 1 },
      devicesAddedSince: [{ id: "later", name: "Later laptop", platform: "windows", createdAt: 1,
        activatedAt: Date.now(), linkMethod: "passkey" }] } as never;
  });
  await show("devices");
  await click(getByRole(container(), "button", { name: "Not me, remove Chrome on macOS" }));
  const confirm = getByRole(document.body, "alertdialog", { name: "Remove Chrome on macOS?" });
  expect(document.activeElement).toBe(getByRole(confirm, "button", { name: "Cancel" }));
  expect(api.post).not.toHaveBeenCalled();
  await click(getByRole(confirm, "button", { name: "Remove device" }));
  expect(signWithIdentityKey).toHaveBeenCalledWith(JSON.stringify([
    "privatebase-device-action-v1", "revoke_alert_device", JSON.stringify(["current", "first"]), "challenge",
  ]));
  expect(api.post).toHaveBeenCalledWith("/api/devices/alerts/first/not-me", { challengeId: "challenge", signature: "device-signature" });
  await flushQuery();
  const result = getByRole(document.body, "dialog", { name: "Device removed" });
  expect(document.activeElement?.textContent).toBe("Device removed");
  expect(result.textContent).toContain("Also added since then");
  expect(result.textContent).toContain("Later laptop");
  expect(isOnlyLocalPasskeyUnlock).toHaveBeenCalledWith("local-credential");
  await click(getByRole(result, "button", { name: "Add password unlock" }));
  const backup = getByRole(document.body, "dialog", { name: "Add password unlock" });
  const password = backup.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "account password");
    password.dispatchEvent(new Event("input", { bubbles: true }));
    backup.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(addAccountPasswordUnlock).toHaveBeenCalledWith("account password");
  await click(getByRole(result, "button", { name: "Remove passkey" }));
  expect(api.delete).toHaveBeenCalledWith("/api/passkeys/exact");
});

it.each([true, false])("shows recovery guidance and exposes a replacement's passkey when present (%s)", async replaced => {
  alerts = [{ ...alert, kind: "recovery_signin", ...(replaced ? { replacedDeviceName: "Old laptop" } : {}) }];
  vi.mocked(api.post).mockImplementation(async path => path.endsWith("/options") ? { challengeId: "challenge" } as never
    : { success: true, credential: replaced ? { id: "exact", credentialId: "key", name: "Replacement passkey", createdAt: 1 } : null } as never);
  await show("devices");
  await click(getByRole(container(), "button", { name: "Not me, remove Chrome on macOS" }));
  await click(getByRole(getByRole(document.body, "alertdialog"), "button", { name: "Remove device" }));
  const review = getByRole(document.body, "dialog", { name: "Device removed" });
  expect(review.textContent).toContain("someone else may have that key");
  const remove = queryByRole(review, "button", { name: "Remove passkey" });
  if (replaced) {
    expect(review.textContent).toContain("Replacement passkey");
    await click(remove!);
    expect(api.delete).toHaveBeenCalledWith("/api/passkeys/exact");
  } else expect(remove).toBeNull();
});
