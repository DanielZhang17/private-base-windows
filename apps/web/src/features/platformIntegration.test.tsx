import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSettings } from "./settings/useSettings.js";
import { useLoginFlow } from "./auth/useLoginFlow.js";
import { useDevices } from "./devices/useDevices.js";
import { useAuthStore } from "../stores/authStore.js";
import { api } from "../services/api.js";
import { capabilities } from "../platform/capabilities.js";
import { clearAccountScopedState } from "../platform/session.js";
import { copyText } from "../platform/clipboard.js";
import { createPasskeyCredential, getPasskeyAssertion } from "../lib/webauthn.js";

const { order, navigate } = vi.hoisted(() => ({ order: [] as string[], navigate: vi.fn() }));
vi.mock("react-router-dom", async (original) => ({ ...await original<object>(), useNavigate: () => navigate }));
vi.mock("../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({
    user: { id: "alice" }, device: { id: "device" }, applyAuthResponse: vi.fn(), updateProfile: vi.fn(),
    logout: vi.fn(() => { order.push("logout"); }),
  })) };
});
vi.mock("../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../platform/session.js", () => ({ clearAccountScopedState: vi.fn(() => { order.push("clear"); }) }));
vi.mock("../platform/clipboard.js", () => ({ copyText: vi.fn(async () => {}) }));
vi.mock("../lib/key-manager.js", () => ({ hasLocalKeyMaterial: async () => true, lockLocalCryptoState: vi.fn(), resetLocalCryptoState: vi.fn() }));
vi.mock("../lib/device-link.js", () => ({ generateRecoveryKey: () => "recovery", buildDefaultDeviceName: () => "Browser" }));
vi.mock("../lib/webauthn.js", async (original) => ({
  ...await original<object>(),
  // The hooks must guard before calling the credential helpers, even with cached options.
  isWebAuthnSupported: () => true,
  createPasskeyCredential: vi.fn(async () => ({})), getPasskeyAssertion: vi.fn(async () => ({})),
}));

let root: Root;
let settings: ReturnType<typeof useSettings>;
let login: ReturnType<typeof useLoginFlow>;
let devices: ReturnType<typeof useDevices>;
let client: QueryClient;
function Probe() { settings = useSettings(); login = useLoginFlow(); devices = useDevices(); return null; }
beforeEach(() => {
  vi.clearAllMocks(); order.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", window.localStorage);
  window.sessionStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(false);
  navigate.mockImplementation(() => { order.push("navigate"); });
  vi.mocked(api.get).mockResolvedValue([]);
  vi.mocked(api.post).mockResolvedValue({ challengeId: "challenge", options: {} });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><Probe /></MemoryRouter></QueryClientProvider>));
}

it("clears account state before logout and navigation", async () => {
  await render();
  await act(async () => settings.handleLogout());
  expect(clearAccountScopedState).toHaveBeenCalledTimes(1);
  expect(useAuthStore.getState().logout).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith("/login");
  expect(order).toEqual(["clear", "logout", "navigate"]);
});

it("exposes the platform passkey capability and skips unsupported prefetch and WebAuthn", async () => {
  await render();
  expect(settings.capabilities.passkeys).toBe(false);
  expect(login.capabilities.passkeys).toBe(false);
  expect(settings.passkeysSupported).toBe(false);
  expect(login.passkeysSupported).toBe(false);
  await act(async () => { login.setUsername("alice"); settings.setPasskeyName("Phone"); });
  await act(async () => {
    await login.prefetchPasskeyOptions("alice");
    await login.handlePasskeyLogin();
    await settings.handleRegisterPasskey();
  });
  expect(api.post).not.toHaveBeenCalled();
  expect(getPasskeyAssertion).not.toHaveBeenCalled();
  expect(createPasskeyCredential).not.toHaveBeenCalled();
  expect(login.error).toContain("Passkeys are unavailable");
  expect(settings.passkeyError).toContain("Passkeys are unavailable");
});

it("guards cached passkey options if support becomes unavailable", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  await render();
  await act(async () => { login.setUsername("alice"); settings.setPasskeyName("Phone"); });
  await act(async () => { await login.prefetchPasskeyOptions("alice"); });
  expect(api.post).toHaveBeenCalledWith("/api/passkeys/register-options", {});
  expect(api.post).toHaveBeenCalledWith("/auth/passkey/login-options", { username: "alice", deviceId: "device" });
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(false);
  vi.mocked(api.post).mockClear();
  await act(async () => { await login.handlePasskeyLogin(); await settings.handleRegisterPasskey(); });
  expect(api.post).not.toHaveBeenCalled();
  expect(getPasskeyAssertion).not.toHaveBeenCalled();
  expect(createPasskeyCredential).not.toHaveBeenCalled();
});

it("copies settings and device recovery keys through the platform adapter", async () => {
  await render();
  await act(async () => { await settings.handleEnrollRecoveryKey(); await devices.handleEnrollRecoveryKey(); });
  await act(async () => { settings.copyRecoveryKey(); devices.copyRecoveryKey(); });
  expect(copyText).toHaveBeenCalledTimes(2);
  expect(copyText).toHaveBeenNthCalledWith(1, "recovery");
  expect(copyText).toHaveBeenNthCalledWith(2, "recovery");
});
