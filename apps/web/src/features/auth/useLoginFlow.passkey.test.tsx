import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupDom } from "../../ui/test-utils.js";
import { capabilities } from "../../platform/capabilities.js";
import { useAuthStore } from "../../stores/authStore.js";
import { listLocalUnlockMethods } from "../../lib/key-manager.js";
import {
  beginPasskeyDeviceSetup, DeviceApprovalRequiredError, forgetSavedPasskeySetup, preparePasskeyDeviceSetup, readPendingPasskeySetup, resumePasskeyDeviceSetup,
} from "../../lib/passkey-provision.js";
import { useLoginFlow } from "./useLoginFlow.js";

vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ device: null, applyAuthResponse: vi.fn(), logout: vi.fn() })) };
});
vi.mock("../../lib/key-manager.js", () => ({
  getLocalKeyOwner: vi.fn(async () => null), hasLocalKeyMaterial: vi.fn(async () => false),
  listLocalUnlockMethods: vi.fn(async () => ["password"]),
}));
vi.mock("../../lib/passkey-provision.js", async (original) => ({
  ...await original<object>(), beginPasskeyDeviceSetup: vi.fn(), preparePasskeyDeviceSetup: vi.fn(),
  clearPendingPasskeySetup: vi.fn(), forgetSavedPasskeySetup: vi.fn(), readPendingPasskeySetup: vi.fn(),
  resumePasskeyDeviceSetup: vi.fn(),
}));
const { render } = setupDom();
let login: ReturnType<typeof useLoginFlow>;
function Probe() { login = useLoginFlow(); return null; }
const setupId = "00000000-0000-4000-8000-000000000001";
const saved = { id: "setup:pending" as const, setupId, bundleHash: "hash", deviceId: "device",
  stage: "unlockReady" as const, createdAt: 1 };
const auth = { user: { id: "user", username: "alice" }, device: { id: "device" }, accessToken: "a", refreshToken: "r" };
const capacity = { error: "device_limit" as const, limit: 10, slotsToFree: 1, devices: [], hasRecoveryKey: true, limitTicket: "ticket" };
function attempt(overrides: Record<string, unknown> = {}) {
  return {
    setupId, method: "password", pending: { setupId, deviceName: "Laptop" }, complete: vi.fn(async () => auth), replace: vi.fn(async () => undefined),
    persistUnlock: vi.fn(async () => undefined), chooseBackupPassword: vi.fn(async () => undefined),
    discard: vi.fn(), abandon: vi.fn(), canUsePasswordFallback: vi.fn(() => true), ...overrides,
  } as unknown as Awaited<ReturnType<typeof beginPasskeyDeviceSetup>>;
}

async function show() {
  await render(<MemoryRouter><Probe /></MemoryRouter>);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readPendingPasskeySetup).mockResolvedValue(undefined);
  vi.mocked(preparePasskeyDeviceSetup).mockResolvedValue({
    setupId, requestAutofill: vi.fn(), discard: vi.fn(async () => undefined),
    authorize: () => beginPasskeyDeviceSetup("Laptop"),
  });
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  vi.mocked(listLocalUnlockMethods).mockResolvedValue(["password"]);
});
afterEach(() => vi.restoreAllMocks());

it("releases a durable controller on Cancel and returns to the saved checkpoint", async () => {
  const controller = attempt();
  vi.mocked(beginPasskeyDeviceSetup).mockResolvedValue(controller);
  vi.mocked(controller.complete).mockImplementationOnce(async () => {
    vi.mocked(controller.canUsePasswordFallback).mockReturnValue(false);
    vi.mocked(readPendingPasskeySetup).mockResolvedValue(saved);
    throw new Error("Network error");
  });
  await show();
  await act(async () => login.handlePasskeyLogin());
  await act(async () => login.beginUnlockSetup());
  expect(login.passkeyPasswordRequired).toBe(true);
  await act(async () => login.setPassword("valid-password"));
  await act(async () => { await login.completePasskeySetupWithPassword({ preventDefault() {} } as React.FormEvent); });
  await act(async () => login.cancelPasskeySetup());
  expect(controller.abandon).not.toHaveBeenCalled();
  expect(controller.discard).toHaveBeenCalledOnce();
  expect(login.savedPasskeySetupId).toBe(setupId);
  expect(login.resumeMethods).toEqual(["password"]);
  expect(login.passkeyPasswordRequired).toBe(false);
});

it.each(["authorization", "completion"])("exposes choices when %s hits the device cap", async (phase) => {
  const capError = Object.assign(new Error("At capacity"), { status: 409, body: capacity });
  const controller = phase === "authorization"
    ? attempt({ deviceLimit: capacity, authorizationError: capError })
    : attempt({ method: "passkey", complete: vi.fn().mockRejectedValueOnce(capError).mockResolvedValueOnce(auth) });
  vi.mocked(controller.replace).mockImplementationOnce(async () => {
    Object.assign(controller, { deviceLimit: undefined, authorizationError: undefined });
  });
  vi.mocked(beginPasskeyDeviceSetup).mockResolvedValue(controller);
  await show();
  await act(async () => login.handlePasskeyLogin());
  if (phase === "completion") await act(async () => login.finishWithBackupPassword());
  expect(login.passkeyDeviceLimit).toEqual(capacity);
  expect(login.error).toBe("");
  await act(async () => login.replacePasskeyDevice("old-device", "recovery-proof"));
  expect(controller.replace).toHaveBeenCalledWith("old-device", "recovery-proof");
  expect(login.passkeyDeviceLimit).toBeUndefined();
  if (phase === "authorization") expect(login.setupScreen).toBe("progress");
  else {
    await act(async () => login.finishWithBackupPassword());
    expect(useAuthStore.getState().applyAuthResponse).toHaveBeenCalledWith(auth);
  }
});

it.each(["unavailable slot", "unreadable slots"])("offers confirmed forgetting with %s", async (reason) => {
  vi.mocked(readPendingPasskeySetup).mockResolvedValue(saved);
  if (reason === "unreadable slots") vi.mocked(listLocalUnlockMethods).mockRejectedValue(new Error("Cannot read slots"));
  else vi.mocked(listLocalUnlockMethods).mockResolvedValue(["native"]);
  vi.spyOn(capabilities, "biometricUnlock", "get").mockReturnValue(undefined);
  vi.mocked(forgetSavedPasskeySetup).mockImplementation(async () => {
    vi.mocked(readPendingPasskeySetup).mockResolvedValue(undefined);
    return true;
  });
  await show();
  expect(login.savedPasskeySetupId).toBe(setupId);
  expect(login.resumeMethods).toEqual([]);
  await act(async () => login.confirmForgetSavedPasskeySetup());
  expect(forgetSavedPasskeySetup).not.toHaveBeenCalled();
  await act(async () => login.requestForgetSavedPasskeySetup());
  expect(login.confirmingForgetSavedPasskeySetup).toBe(true);
  await act(async () => login.cancelForgetSavedPasskeySetup());
  await act(async () => login.confirmForgetSavedPasskeySetup());
  expect(forgetSavedPasskeySetup).not.toHaveBeenCalled();
  await act(async () => login.requestForgetSavedPasskeySetup());
  await act(async () => login.confirmForgetSavedPasskeySetup());
  expect(forgetSavedPasskeySetup).toHaveBeenCalledExactlyOnceWith(setupId);
  expect(login.savedPasskeySetupId).toBeUndefined();
});

it("prepares options separately and calls the prepared ceremony directly from the tap", async () => {
  const authorize = vi.fn(async () => attempt());
  vi.mocked(preparePasskeyDeviceSetup).mockResolvedValue({ setupId, authorize, requestAutofill: vi.fn(), discard: vi.fn() });
  await show();
  await act(async () => login.prepareFreshPasskeySetup());
  expect(login.passkeySetupPrepared).toBe(true);
  expect(authorize).not.toHaveBeenCalled();
  await act(async () => login.authorizePreparedPasskeySetup());
  expect(authorize).toHaveBeenCalledOnce();
  expect(beginPasskeyDeviceSetup).not.toHaveBeenCalled();
  expect(login.setupScreen).toBe("progress");
});

it("uses a saved unlock method to resume replacement after a restart", async () => {
  vi.mocked(readPendingPasskeySetup).mockResolvedValue(saved);
  vi.mocked(resumePasskeyDeviceSetup).mockRejectedValueOnce(Object.assign(new Error(), { status: 409, body: capacity }))
    .mockResolvedValueOnce(auth as never);
  await show();
  await act(async () => { await login.resumePasskeyUnlock("password", "valid-password"); });
  expect(login.passkeyDeviceLimit).toEqual(capacity);
  await act(async () => login.replacePasskeyDevice("old", "proof", { method: "password", password: "valid-password" }));
  expect(resumePasskeyDeviceSetup).toHaveBeenLastCalledWith("password", "valid-password", {
    limitTicket: "ticket", revokeDeviceId: "old", recoveryKeyProof: "proof",
  });
  expect(useAuthStore.getState().applyAuthResponse).toHaveBeenCalledWith(auth);
});

it("retires an expired replacement ticket on a saved setup and completes it when space is freed", async () => {
  vi.mocked(readPendingPasskeySetup).mockResolvedValue(saved);
  vi.mocked(resumePasskeyDeviceSetup)
    .mockRejectedValueOnce({ status: 409, body: capacity })
    .mockRejectedValueOnce({ status: 401, body: { error: "limit_ticket_expired" } })
    .mockResolvedValueOnce(auth as never);
  await show();
  await act(async () => { await login.resumePasskeyUnlock("password", "valid-password"); });
  await act(async () => login.replacePasskeyDevice("old", "proof", { method: "password", password: "valid-password" }));
  expect(login.passkeyDeviceLimit).toMatchObject({ limitTicket: null });
  expect(login.savedPasskeySetupId).toBe(setupId);
  await act(async () => { await login.resumePasskeyUnlock("password", "valid-password"); });
  expect(resumePasskeyDeviceSetup).toHaveBeenLastCalledWith("password", "valid-password", undefined);
  expect(useAuthStore.getState().applyAuthResponse).toHaveBeenCalledWith(auth);
});

it("retries saving an accepted PRF assertion without switching to password unlock", async () => {
  const persistUnlock = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("Could not save the slot"));
  const controller = attempt({ method: "passkey", persistUnlock });
  vi.mocked(beginPasskeyDeviceSetup).mockResolvedValue(controller);
  await show();
  await act(async () => login.handlePasskeyLogin());
  expect(login.setupScreen).toBe("progress");
  expect(login.passwordOnly).toBe(false);
  expect(login.error).toBeTruthy();
  await act(async () => login.retryPasskeySetup());
  expect(login.setupScreen).toBe("unlock");
  expect(persistUnlock).toHaveBeenCalledTimes(2);
  expect(beginPasskeyDeviceSetup).toHaveBeenCalledTimes(1);
  expect(controller.complete).not.toHaveBeenCalled();
});

it.each(["add backup", "skip backup"])("returns to possession-checked resume when an expired token blocks %s", async action => {
  const expired = Object.assign(new Error(), { status: 401, body: {
    error: action === "add backup" ? "Invalid token" : "Invalid setup token",
  } });
  const controller = attempt({ method: "passkey", persistUnlock: vi.fn(async () => {
    vi.mocked(readPendingPasskeySetup).mockResolvedValue(saved);
  }), chooseBackupPassword: action === "add backup" ? vi.fn().mockRejectedValue(expired) : vi.fn(), complete: vi.fn().mockRejectedValue(expired) });
  vi.mocked(beginPasskeyDeviceSetup).mockResolvedValue(controller);
  await show();
  await act(async () => login.handlePasskeyLogin());
  vi.mocked(controller.canUsePasswordFallback).mockReturnValue(false);
  expect(controller.persistUnlock).toHaveBeenCalledOnce();
  expect(login.setupScreen).toBe("unlock");
  await act(async () => login.enrollPasskeySetupUnlock());
  expect(controller.persistUnlock).toHaveBeenCalledOnce();
  expect(login.setupScreen).toBe("backup");
  await act(async () => login.finishWithBackupPassword(action === "add backup" ? "password" : undefined));
  expect(controller.discard).toHaveBeenCalledOnce();
  expect(login.setupScreen).toBeNull();
  expect(login.savedPasskeySetupId).toBe(setupId);
  vi.mocked(resumePasskeyDeviceSetup).mockResolvedValue(auth as never);
  await act(async () => login.resumePasskeyUnlock("password", "password"));
  expect(resumePasskeyDeviceSetup).toHaveBeenCalledWith("password", "password", undefined);
});

it.each(["add backup", "skip backup"])("releases the durable setup when its credential is revoked during %s", async action => {
  const revoked = { status: 401, body: { error: "unknown_credential" } };
  const controller = attempt({ method: "passkey", persistUnlock: vi.fn(async () => {
    vi.mocked(readPendingPasskeySetup).mockResolvedValue(saved);
  }), chooseBackupPassword: action === "add backup" ? vi.fn().mockRejectedValue(revoked) : vi.fn(), complete: vi.fn().mockRejectedValue(revoked) });
  vi.mocked(beginPasskeyDeviceSetup).mockResolvedValue(controller);
  await show();
  await act(async () => login.handlePasskeyLogin());
  vi.mocked(controller.canUsePasswordFallback).mockReturnValue(false);
  expect(controller.persistUnlock).toHaveBeenCalledOnce();
  await act(async () => login.enrollPasskeySetupUnlock());
  await act(async () => login.finishWithBackupPassword(action === "add backup" ? "password" : undefined));
  expect(controller.discard).toHaveBeenCalledOnce();
  expect(controller.abandon).not.toHaveBeenCalled();
  expect(login.setupScreen).toBeNull();
  expect(login.savedPasskeySetupId).toBe(setupId);
  expect(login.passkeySetupProblem?.error).toBe("unknown_credential");
  expect(forgetSavedPasskeySetup).not.toHaveBeenCalled();
  await act(async () => login.requestForgetSavedPasskeySetup());
  expect(login.confirmingForgetSavedPasskeySetup).toBe(true);
});

it("leaves progress and permits a fresh ceremony after a terminal authorization retry", async () => {
  const controller = attempt({ pending: undefined, authorizationError: new Error("network"), closed: false,
    retryAuthorization: vi.fn(async () => {
      Object.assign(controller, { closed: true });
      throw Object.assign(new Error(), { status: 401, body: { error: "unknown_credential" } });
    }),
  });
  vi.mocked(beginPasskeyDeviceSetup).mockResolvedValueOnce(controller).mockResolvedValueOnce(attempt());
  await show();
  await act(async () => login.handlePasskeyLogin());
  expect(login.setupScreen).toBe("progress");
  await act(async () => login.retryPasskeySetup());
  expect(login.setupScreen).toBeNull();
  await act(async () => login.handlePasskeyLogin());
  expect(beginPasskeyDeviceSetup).toHaveBeenCalledTimes(2);
});

it("keeps the method choice after the native enrollment prompt is cancelled", async () => {
  const { NativeBiometricError } = await import("../../platform/biometric-unlock.js");
  const controller = attempt({ method: "native", persistUnlock: vi.fn().mockRejectedValue(new NativeBiometricError("cancelled")) });
  vi.mocked(beginPasskeyDeviceSetup).mockResolvedValue(controller);
  await show();
  await act(async () => login.handlePasskeyLogin());
  await act(async () => login.beginUnlockSetup());
  await act(async () => login.enrollPasskeySetupUnlock());
  expect(login.setupScreen).toBe("unlock");
  expect(login.error).toBe("");
});

it.each(["back to sign-in", "cancel"])("clears account-scoped approval fallback on %s", async action => {
  vi.mocked(beginPasskeyDeviceSetup).mockRejectedValueOnce(new DeviceApprovalRequiredError("alice"));
  await show();
  await act(async () => login.handlePasskeyLogin());
  expect(login.passkeyApproval).toBe(true);
  if (action === "cancel") await act(async () => login.cancelPasskeySetup());
  else await act(async () => login.backToSignIn());
  expect(login.passkeyApproval).toBe(false);
});

it.each(["free-preparation", "durable-checkpoint"])("reconciles a setup in a waiting tab when the owner leaves (%s)", async kind => {
  const { PasskeySetupBusyError } = await import("../../lib/passkey-provision.js");
  class SilentChannel {
    postMessage() {}
    close() {}
  }
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  vi.mocked(preparePasskeyDeviceSetup).mockRejectedValueOnce(new PasskeySetupBusyError());
  await show();
  await act(async () => { await login.preparePasskeyEntry(); });
  expect(login.entryState).toBe("other-tab");
  if (kind === "durable-checkpoint") vi.mocked(readPendingPasskeySetup).mockResolvedValue(saved);
  await act(async () => login.requestSetupTakeover());
  if (kind === "durable-checkpoint") {
    expect(login.savedPasskeySetupId).toBe(setupId);
    expect(login.resumeMethods).toEqual(["password"]);
  } else {
    expect(preparePasskeyDeviceSetup).toHaveBeenCalledTimes(2);
    expect(login.entryState).toBe("ready");
  }
});
