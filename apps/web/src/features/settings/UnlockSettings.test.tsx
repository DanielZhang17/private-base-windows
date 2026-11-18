import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../lib/passkey-provision.js", () => ({
  bindAccountUnlockEnrollment: () => async () => {
    const { biometricUnlock } = await import("../../platform/biometric-unlock.js");
    await biometricUnlock.enroll("vault-id", new Uint8Array(32));
  },
  addAccountPasswordUnlock: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;
const helloSwitch = () => container.querySelector<HTMLInputElement>('[role="switch"][aria-label="Windows Hello"]')!;
const helloOffer = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Turn on Windows Hello");

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { capabilities } = await import("../../platform/capabilities.js");
  const { ToastProvider } = await import("../../ui/index.js");
  const { UnlockSettings } = await import("./UnlockSettings.js");
  const { UnlockOffer } = await import("../auth/UnlockOffer.js");
  const { markUnlockOffer } = await import("../auth/unlockOfferState.js");
  const { useAuthStore } = await import("../../stores/authStore.js");
  vi.spyOn(capabilities, "biometricUnlock", "get").mockReturnValue("windows-hello");
  useAuthStore.setState({ device: { id: "device" } } as never);
  markUnlockOffer("device", ["password"], false);
  invoke.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(
    <MemoryRouter><QueryClientProvider client={new QueryClient()}><ToastProvider>
      <UnlockOffer />
      <UnlockSettings
        vault={{ methods: ["password"], passkeyId: undefined, nativeRemovalPending: false, refresh: vi.fn(), isLastUsable: () => true }}
        passkeys={[]} onLock={vi.fn()} addPassword={false} closePassword={vi.fn()} openPassword={vi.fn()}
      />
    </ToastProvider></QueryClientProvider></MemoryRouter>,
  ));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["unsupported", { code: "unsupported" }])("explains unsupported Hello enrollment and disables the switch (%j)", async error => {
  invoke.mockRejectedValueOnce(error);
  await act(async () => helloSwitch().click());
  expect(invoke).toHaveBeenCalledWith("biometric_unlock_enroll", expect.objectContaining({ vaultId: "vault-id" }));
  expect(container.textContent).toContain("This device doesn't support setting up Windows Hello for Private Base.");
  expect(container.textContent).not.toContain("Try again");
  expect(helloSwitch().disabled).toBe(true);
  expect(helloOffer()).toBeUndefined();
  await act(async () => helloSwitch().click());
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("allows another attempt after a retryable native failure", async () => {
  invoke.mockRejectedValueOnce("failed").mockResolvedValueOnce(undefined);
  await act(async () => helloSwitch().click());
  expect(container.textContent).toContain("Try again");
  expect(helloSwitch().disabled).toBe(false);
  expect(helloOffer()).toBeDefined();
  await act(async () => helloSwitch().click());
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Try again");
});

it("shares an unsupported result from the unlock offer with Settings", async () => {
  invoke.mockRejectedValueOnce("failed").mockRejectedValueOnce("unsupported");
  await act(async () => helloOffer()!.click());
  expect(container.textContent).toContain("Try again");
  expect(helloSwitch().disabled).toBe(false);
  await act(async () => helloOffer()!.click());
  expect(container.textContent).toContain("This device doesn't support setting up Windows Hello for Private Base.");
  expect(container.textContent).not.toContain("Try again");
  expect(helloSwitch().disabled).toBe(true);
  expect(helloOffer()).toBeUndefined();
  expect(invoke).toHaveBeenCalledTimes(2);
});
