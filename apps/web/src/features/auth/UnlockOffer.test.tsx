import { getAllByRole, queryAllByRole } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindAccountUnlockEnrollment } from "../../lib/passkey-provision.js";
import { NativeBiometricError } from "../../platform/biometric-unlock.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { Dialog, ToastProvider } from "../../ui/index.js";
import { click, mockCloseRequests, setupDom } from "../../ui/test-utils.js";
import { useObscuringSurface } from "../calls/call-surface.js";
import { UnlockOffer } from "./UnlockOffer.js";
import { UNLOCK_OFFER_IDLE_MS, useHoldUnlockOffer } from "./unlockOfferGate.js";
import { unlockOfferFor } from "./unlockOfferState.js";

vi.mock("../../platform/biometric-unlock.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../platform/biometric-unlock.js")>(),
  canEnrollNativeUnlock: () => true,
  useNativeUnlockStatus: () => ({ available: "touchid" }),
}));
vi.mock("../../lib/passkey-provision.js", () => ({ bindAccountUnlockEnrollment: vi.fn(), removeAccountNativeUnlock: vi.fn() }));
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn(async () => []) } }));

const { render } = setupDom();
const initialAuth = useAuthStore.getState();
const initialCalls = useCallStore.getState();
let client: QueryClient;
const dialogs = () => queryAllByRole(document.body, "dialog");
const offerShown = () => dialogs().some((dialog) => dialog.textContent?.includes("Unlock with Touch ID?"));
const button = (name: string) => getAllByRole(document.body, "button").find((entry) => entry.textContent === name)!;
const show = (node: ReactNode = <UnlockOffer />, path = "/") => render(<QueryClientProvider client={client}><ToastProvider>
  <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
</ToastProvider></QueryClientProvider>);
const rest = (ms = UNLOCK_OFFER_IDLE_MS) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function Hold({ active = true }: { active?: boolean }) { useHoldUnlockOffer(active); return null; }
function CallSurface() { useObscuringSurface(true); return null; }

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient();
  useAuthStore.setState({ device: { id: "device" } as ReturnType<typeof useAuthStore.getState>["device"] });
  localStorage.removeItem("unlock-offer-seen:device");
  sessionStorage.setItem("unlock-offer:device", "new");
});
afterEach(async () => {
  sessionStorage.removeItem("unlock-offer:device");
  localStorage.removeItem("unlock-offer-seen:device");
  await act(async () => { useAuthStore.setState(initialAuth, true); useCallStore.setState(initialCalls, true); });
  client.clear();
});

it("opens only after the user has been on the chat list for a moment, and remembers Not now", async () => {
  await show();
  expect(offerShown()).toBe(false);
  await rest(UNLOCK_OFFER_IDLE_MS - 100);
  expect(offerShown()).toBe(false);
  await rest(100);
  expect(dialogs()).toHaveLength(1);
  expect(dialogs()[0].textContent).toContain("Unlock faster next time.");
  await click(button("Not now"));
  expect(dialogs()).toHaveLength(0);
  expect(unlockOfferFor("device")).toBeNull();
  expect(localStorage.getItem("unlock-offer-seen:device")).toBe("1");
});

it("turns on the offered method from the primary action", async () => {
  const enroll = vi.fn(async () => undefined);
  vi.mocked(bindAccountUnlockEnrollment).mockReturnValue(enroll as never);
  await show(<UnlockOffer />, "/chat/c1");
  await rest();
  await click(button("Turn on Touch ID"));
  await vi.waitFor(() => expect(dialogs()).toHaveLength(0));
  expect(enroll).toHaveBeenCalledExactlyOnceWith({ method: "native" });
  expect(unlockOfferFor("device")).toBeNull();
});

it("explains unsupported enrollment and keeps the offer pending", async () => {
  vi.mocked(bindAccountUnlockEnrollment).mockReturnValue(vi.fn(async () => { throw new NativeBiometricError("unsupported"); }) as never);
  await show();
  await rest();
  await click(button("Turn on Touch ID"));
  await vi.waitFor(() => expect(document.body.textContent).toContain("This device doesn't support setting up Touch ID for Private Base."));
  expect(unlockOfferFor("device")).toBe("new");
});

it("dismisses on system Back", async () => {
  const back = mockCloseRequests();
  await show();
  await rest();
  expect(offerShown()).toBe(true);
  await back();
  expect(dialogs()).toHaveLength(0);
  expect(unlockOfferFor("device")).toBeNull();
});

it.each(["/settings", "/devices", "/devices/transfer", "/setup/history-transfer", "/unlock", "/call/c1", "/verify/u1"])(
  "never opens on %s", async (path) => {
    await show(<UnlockOffer />, path);
    await rest(UNLOCK_OFFER_IDLE_MS * 4);
    expect(offerShown()).toBe(false);
    expect(unlockOfferFor("device")).toBe("new");
  });

it("waits while a security alert or setup step holds it, then restarts the idle wait", async () => {
  await show(<><Hold /><UnlockOffer /></>);
  await rest(UNLOCK_OFFER_IDLE_MS * 4);
  expect(offerShown()).toBe(false);
  await show(<><Hold active={false} /><UnlockOffer /></>);
  await rest(UNLOCK_OFFER_IDLE_MS - 100);
  expect(offerShown()).toBe(false);
  await rest(100);
  expect(offerShown()).toBe(true);
});

it("closes without dismissing when an alert appears, and comes back once it is handled", async () => {
  await show(<><Hold active={false} /><UnlockOffer /></>);
  await rest();
  expect(offerShown()).toBe(true);
  await show(<><Hold /><UnlockOffer /></>);
  expect(offerShown()).toBe(false);
  expect(unlockOfferFor("device")).toBe("new");
  await show(<><Hold active={false} /><UnlockOffer /></>);
  await rest();
  expect(offerShown()).toBe(true);
});

it("stays closed during a call or while a call surface covers the app", async () => {
  await act(async () => useCallStore.setState({ activeCallId: "call-1" }));
  await show();
  await rest(UNLOCK_OFFER_IDLE_MS * 2);
  expect(offerShown()).toBe(false);
  await act(async () => useCallStore.setState({ activeCallId: null }));
  await show(<><CallSurface /><UnlockOffer /></>);
  await rest(UNLOCK_OFFER_IDLE_MS * 2);
  expect(offerShown()).toBe(false);
});

it("shows a single dialog when two shells render the offer", async () => {
  await show(<><UnlockOffer /><UnlockOffer /></>);
  await rest();
  expect(dialogs()).toHaveLength(1);
});

it("waits for another open dialog to close before offering", async () => {
  await show(<><Dialog open title="Set up passkey" onClose={() => undefined} /><UnlockOffer /></>);
  await rest(UNLOCK_OFFER_IDLE_MS * 2);
  expect(dialogs()).toHaveLength(1);
  expect(dialogs()[0].textContent).toContain("Set up passkey");
  await show(<UnlockOffer />);
  expect(offerShown()).toBe(false); // the idle wait starts over once the other dialog is gone
  await rest();
  expect(dialogs()).toHaveLength(1);
  expect(offerShown()).toBe(true);
});
