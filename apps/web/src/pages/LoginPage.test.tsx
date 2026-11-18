import { getPasskeyAssertion } from "../lib/webauthn.js";
import { getByRole, queryByRole } from "@testing-library/dom";
import { DeviceApprovalRequiredError, forgetSavedPasskeySetup, preparePasskeyDeviceSetup, readPendingPasskeySetup, resumePasskeyDeviceSetup } from "../lib/passkey-provision.js";
import { signInWithNativePasskey } from "../lib/native-passkeys.js";
import { capabilities } from "../platform/capabilities.js";
import { biometricUnlock, canEnrollNativeUnlock, refreshNativeUnlockCapability } from "../platform/biometric-unlock.js";
import * as passkeyHandoff from "../platform/passkeyHandoff.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage.js";
import { useAuthStore } from "../stores/authStore.js";
import { api } from "../services/api.js";
import * as keyManager from "../lib/key-manager.js";

vi.mock("../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ device: null, applyAuthResponse: vi.fn(), logout: vi.fn() })) };
});
vi.mock("../services/api.js", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../lib/key-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/key-manager.js")>("../lib/key-manager.js");
  return {
    decideLocalKeyAction: actual.decideLocalKeyAction,
    resolveLocalKeyDeviceId: actual.resolveLocalKeyDeviceId,
    buildDeviceLinkPublicBundle: vi.fn(),
    getLocalKeyOwner: vi.fn(),
    getLocalVaultKey: vi.fn(),
    hasLocalKeyMaterial: vi.fn(),
    initializeKeys: vi.fn(),
    keysLoaded: vi.fn(),
    lockLocalCryptoState: vi.fn(),
    loadKeys: vi.fn(),
    resetLocalCryptoState: vi.fn(),
    resetLocalDevice: vi.fn(),
    listLocalUnlockMethods: vi.fn(async () => ["password"]),
    setLocalKeyOwner: vi.fn(),
  };
});
vi.mock("../lib/device-link.js", () => ({
  buildDefaultDeviceName: () => "Test browser",
  signDeviceLinkCompletion: vi.fn(async () => "signature"),
}));
vi.mock("../lib/passkey-provision.js", async original => ({
  ...await original<object>(),
  readPendingPasskeySetup: vi.fn(async () => undefined),
  forgetSavedPasskeySetup: vi.fn(async () => true),
  preparePasskeyDeviceSetup: vi.fn(async () => { throw new Error("Test has not configured passkey setup"); }),
  resumePasskeyDeviceSetup: vi.fn(),
}));
vi.mock("../lib/native-passkeys.js", () => ({ signInWithNativePasskey: vi.fn() }));
vi.mock("../lib/webauthn.js", () => ({ isWebAuthnSupported: () => false, getPasskeyAssertion: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
const applyAuthResponse = vi.fn();
const logout = vi.fn();
const auth = { user: { id: "alice-id", username: "alice" }, device: { id: "new-device" }, accessToken: "a", refreshToken: "r" };
const linkedAuth = { ...auth, device: { id: "existing-device" } };
const vaultKey = { id: "identity", type: "identity", data: "original encrypted identity" };

function type(placeholder: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="${placeholder}"]`)!;
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function signIn(recoveryKey = "") {
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await act(async () => {
    type("Username", "alice");
    type("Password", "password");
  });
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
  });
  if (recoveryKey && container.textContent?.includes("Set up this device")) {
    await click("Use my recovery key");
    await act(async () => type("Recovery key", recoveryKey));
    await submit();
  }
}

async function click(label: string) {
  await act(async () => { Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(label))!.click(); });
}
async function submit() {
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

const posts = (path: string) => vi.mocked(api.post).mock.calls.filter(([called]) => called === path);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.removeItem("e2ee-auth");
  vi.clearAllMocks();
  vi.mocked(signInWithNativePasskey).mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  useAuthStore.setState({ device: null, applyAuthResponse, logout } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(false);
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue(null);
  vi.mocked(keyManager.getLocalVaultKey).mockResolvedValue(vaultKey);
  vi.mocked(readPendingPasskeySetup).mockResolvedValue(undefined);
  vi.mocked(keyManager.listLocalUnlockMethods).mockResolvedValue(["password"]);
  vi.mocked(keyManager.keysLoaded).mockReturnValue(true);
  vi.mocked(keyManager.resetLocalCryptoState).mockResolvedValue(true);
  vi.mocked(keyManager.setLocalKeyOwner).mockResolvedValue();
  vi.mocked(keyManager.buildDeviceLinkPublicBundle).mockReturnValue({ deviceName: "Test browser" } as never);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps an approved recovery request and its keys, and retries the same completion", async () => {
  let completions = 0;
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path === "/api/device-links/recover") {
      return { linkRequestId: "req-1", challengeNonce: "nonce", expiresAt: Date.now() + 60_000 } as never;
    }
    if (path === "/api/device-links/req-1/complete") {
      completions += 1;
      if (completions === 1) throw Object.assign(new Error("Failed to fetch"), { status: 0 });
      return auth as never;
    }
    throw new Error(`unexpected ${path}`);
  });
  vi.mocked(api.get).mockResolvedValue({ status: "approved", challengeNonce: "nonce" } as never);

  await signIn("recovery-key");
  expect(posts("/api/device-links/req-1/complete")).toHaveLength(1);
  expect(container.textContent).toContain("Failed to fetch");
  expect(container.textContent).toContain("Finishing Recovery");
  expect(applyAuthResponse).not.toHaveBeenCalled();

  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

  expect(api.get).toHaveBeenCalledWith("/api/device-links/req-1/status");
  expect(posts("/api/device-links/req-1/complete")).toHaveLength(2);
  expect(posts("/api/device-links/recover")).toHaveLength(1);
  // Recovery resumes the original vault without wiping or regenerating keys.
  expect(keyManager.initializeKeys).toHaveBeenCalledTimes(1);
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();

  expect(applyAuthResponse).toHaveBeenCalledWith(auth);
  expect(keyManager.setLocalKeyOwner).toHaveBeenCalledWith({ userId: "alice-id", username: "alice", deviceId: "new-device" });
});

it("signs in with the device recorded for the local keys, not a stale auth-store device", async () => {
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "alice-id", username: "alice", deviceId: "keys-device" });
  useAuthStore.setState({ device: { id: "stale-device", userId: "bob-id" } } as never);
  vi.mocked(api.post).mockResolvedValue(auth as never);

  await signIn();

  expect(api.post).toHaveBeenCalledWith("/auth/login", { username: "alice", password: "password", deviceId: "keys-device" });
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
});

it("asks before forgetting keys whose device is unknown instead of wiping them", async () => {
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "alice-id", username: "alice" });

  await signIn();

  expect(api.post).not.toHaveBeenCalled();
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
  expect(keyManager.initializeKeys).not.toHaveBeenCalled();
  expect(container.textContent).toContain("no longer knows which device they belong to");
});

it("signs in to the created device when the completion committed but its response was lost", async () => {
  let completions = 0;
  vi.mocked(api.post).mockImplementation(async (path, body) => {
    if (path === "/api/device-links/recover") {
      return { linkRequestId: "req-1", challengeNonce: "nonce", expiresAt: Date.now() + 60_000 } as never;
    }
    if (path === "/api/device-links/req-1/complete") {
      completions += 1;
      if (completions === 1) throw Object.assign(new Error("Failed to fetch"), { status: 0 });
      throw Object.assign(new Error("Link request already completed"), {
        status: 409, body: { error: "Link request already completed", deviceId: "new-device" },
      });
    }
    if (path === "/auth/login") {
      expect(body).toEqual({ username: "alice", password: "password", deviceId: "new-device" });
      return auth as never;
    }
    throw new Error(`unexpected ${path}`);
  });
  // A completed request no longer returns its nonce; the client must have kept it.
  vi.mocked(api.get).mockResolvedValue({ status: "completed", challengeNonce: null } as never);

  await signIn("recovery-key");
  expect(applyAuthResponse).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

  expect(posts("/api/device-links/req-1/complete")).toHaveLength(2);
  expect(posts("/auth/login")).toHaveLength(1);
  expect(applyAuthResponse).toHaveBeenCalledWith(auth);
  expect(keyManager.setLocalKeyOwner).toHaveBeenCalledWith({ userId: "alice-id", username: "alice", deviceId: "new-device" });
  expect(keyManager.initializeKeys).toHaveBeenCalledTimes(1);
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
});

it("persists an approved recovery without the password and finishes it after a page reload", async () => {
  const { RECOVERY_RETRY_KEY } = await import("../features/auth/recoveryRetry.js");
  let completions = 0;
  vi.mocked(api.post).mockImplementation(async (path, body) => {
    if (path === "/api/device-links/recover") return { linkRequestId: "reload-request", challengeNonce: "nonce", expiresAt: Date.now() + 60000 } as never;
    if (path === "/api/device-links/reload-request/complete") {
      if (++completions === 1) throw Object.assign(new Error("Failed to fetch"), { status: 0 });
      throw Object.assign(new Error("Link request already completed"), { status: 409, body: { deviceId: "new-device" } });
    }
    if (path === "/auth/login") {
      expect(body).toEqual({ username: "alice", password: "password", deviceId: "new-device" });
      return auth as never;
    }
    throw new Error(`unexpected ${path}`);
  });
  vi.mocked(api.get).mockResolvedValue({ status: "completed", challengeNonce: null } as never);
  await signIn("recovery-key");
  const saved = JSON.parse(sessionStorage.getItem(RECOVERY_RETRY_KEY)!);
  expect(saved).toEqual({ linkRequestId: "reload-request", challengeNonce: "nonce", mode: "recovery", deviceName: "Test browser", expiresAt: expect.any(Number), username: "alice" });
  expect(sessionStorage.getItem(RECOVERY_RETRY_KEY)).not.toContain("password");
  await act(async () => root.unmount());
  root = createRoot(container);
  vi.mocked(keyManager.keysLoaded).mockReturnValue(false);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(container.textContent).toContain("Finish recovery");
  expect(container.querySelector<HTMLInputElement>('input[placeholder="Password"]')!.value).toBe("");
  expect(posts("/api/device-links/reload-request/complete")).toHaveLength(1);
  await act(async () => type("Password", "password"));
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(keyManager.loadKeys).toHaveBeenCalledWith("password");
  expect(keyManager.initializeKeys).toHaveBeenCalledTimes(1);
  expect(posts("/api/device-links/recover")).toHaveLength(1);
  expect(applyAuthResponse).toHaveBeenCalledWith(auth);
  expect(sessionStorage.getItem(RECOVERY_RETRY_KEY)).toBeNull();
});

it("clears persisted recovery on expiry or rejection without generating new keys", async () => {
  const { RECOVERY_RETRY_KEY } = await import("../features/auth/recoveryRetry.js");
  const saved = { linkRequestId: "rejected", challengeNonce: "nonce", mode: "recovery", deviceName: "Test browser", expiresAt: Date.now() + 60000, username: "alice" };
  sessionStorage.setItem(RECOVERY_RETRY_KEY, JSON.stringify(saved));
  vi.mocked(api.get).mockResolvedValue({ status: "rejected" } as never);
  await signIn();
  expect(container.textContent).toContain("Device link request was rejected");
  expect(sessionStorage.getItem(RECOVERY_RETRY_KEY)).toBeNull();
  expect(keyManager.initializeKeys).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  root = createRoot(container);
  sessionStorage.setItem(RECOVERY_RETRY_KEY, JSON.stringify({ ...saved, expiresAt: Date.now() - 1 }));
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(container.textContent).not.toContain("Finish recovery");
  expect(sessionStorage.getItem(RECOVERY_RETRY_KEY)).toBeNull();
});

it("coalesces duplicate password submissions before key generation", async () => {
  vi.mocked(api.post).mockResolvedValue({ linkRequestId: "pending", shortCode: "123456", expiresAt: Date.now() + 60000 } as never);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await act(async () => { type("Username", "alice"); type("Password", "password"); });
  await act(async () => {
    const form = container.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(container.textContent).toContain("Set up this device");
  expect(keyManager.initializeKeys).not.toHaveBeenCalled();
  await act(async () => {
    const approve = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Approve from another device"))!;
    approve.click();
    approve.click();
  });
  expect(keyManager.initializeKeys).toHaveBeenCalledTimes(1);
  expect(posts("/api/device-links/start")).toHaveLength(1);
});

it("preserves the local key owner guard when resuming saved recovery", async () => {
  const { RECOVERY_RETRY_KEY } = await import("../features/auth/recoveryRetry.js");
  sessionStorage.setItem(RECOVERY_RETRY_KEY, JSON.stringify({ linkRequestId: "saved", challengeNonce: "nonce", mode: "recovery", deviceName: "Test browser", expiresAt: Date.now() + 60000, username: "alice" }));
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "bob-id", username: "bob", deviceId: "bob-device" });
  await signIn();
  expect(container.textContent).toContain("This browser already holds encryption keys");
  expect(keyManager.loadKeys).not.toHaveBeenCalled();
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

it("blocks Cancel while a resumed recovery is completing, so the keys of the returned session survive", async () => {
  const { RECOVERY_RETRY_KEY } = await import("../features/auth/recoveryRetry.js");
  sessionStorage.setItem(RECOVERY_RETRY_KEY, JSON.stringify({ linkRequestId: "saved", challengeNonce: "nonce", mode: "recovery", deviceName: "Test browser", expiresAt: Date.now() + 60000, username: "alice" }));
  vi.mocked(api.get).mockResolvedValue({ status: "approved", challengeNonce: "nonce" } as never);
  let complete!: (value: never) => void;
  vi.mocked(api.post).mockImplementation((path) => {
    if (path === "/api/device-links/saved/complete") return new Promise((resolve) => { complete = resolve; });
    throw new Error(`unexpected ${path}`);
  });
  await signIn();
  expect(container.textContent).toContain("Finishing Recovery");
  expect(posts("/api/device-links/saved/complete")).toHaveLength(1);
  const cancel = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Cancel")!;
  expect(cancel().disabled).toBe(true);
  await act(async () => {
    cancel().click();
    // The status poll must not start a second run alongside the pending completion either.
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Finishing Recovery");
  await act(async () => {
    complete(auth as never);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
  expect(applyAuthResponse).toHaveBeenCalledTimes(1);
  expect(applyAuthResponse).toHaveBeenCalledWith(auth);
  expect(sessionStorage.getItem(RECOVERY_RETRY_KEY)).toBeNull();
});

it("shows only credentials first, then offers device setup without generating or wiping keys", async () => {
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(container.querySelector('[placeholder="Recovery key"]')).toBeNull();
  expect(container.textContent).not.toContain("Approve from another device");
  await signIn();
  expect(container.textContent).toContain("Set up this device");
  expect(keyManager.initializeKeys).not.toHaveBeenCalled();
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
  await click("Use my recovery key");
  expect(container.querySelector('textarea[placeholder="Recovery key"]')).not.toBeNull();
  await act(async () => type("Recovery key", "secret"));
  await click("Back to sign in");
  expect(container.querySelector<HTMLInputElement>('[placeholder="Username"]')!.value).toBe("alice");
  expect(container.querySelector('[placeholder="Recovery key"]')).toBeNull();
  await submit();
  await click("Use my recovery key");
  expect(container.querySelector<HTMLTextAreaElement>('[placeholder="Recovery key"]')!.value).toBe("");
});

it("offers setup after the server rejects the keys' device, and replaces keys only after a choice", async () => {
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "alice-id", username: "alice", deviceId: "old-device" });
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path === "/auth/login") throw new Error("Unknown device");
    if (path === "/api/device-links/start") return { linkRequestId: "link", shortCode: "123456", expiresAt: Date.now() + 60000 } as never;
    throw new Error(`unexpected ${path}`);
  });
  await signIn();
  expect(container.textContent).toContain("Set up this device");
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
  await click("Approve from another device");
  expect(container.textContent).toContain("123 456");
  expect(container.textContent).toContain("Waiting for approval…");
  expect(keyManager.resetLocalCryptoState).toHaveBeenCalledTimes(1);
  expect(keyManager.initializeKeys).toHaveBeenCalledTimes(1);
  expect(posts("/api/device-links/start")).toHaveLength(1);
  await click("Cancel");
  expect(container.textContent).toContain("Set up this device");
  expect(posts("/api/device-links/start")).toHaveLength(1);
});

it("keeps invalid credentials on sign in and blocks a different local owner before setup", async () => {
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "alice-id", username: "alice", deviceId: "device" });
  vi.mocked(api.post).mockRejectedValue(new Error("Invalid credentials"));
  await signIn();
  expect(container.textContent).toContain("Invalid credentials");
  expect(container.textContent).not.toContain("Set up this device");
  expect(container.querySelector<HTMLInputElement>('[placeholder="Password"]')!.value).toBe("password");
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "bob-id", username: "bob", deviceId: "bob-device" });
  await submit();
  expect(container.textContent).toContain("This browser already holds encryption keys");
  expect(posts("/auth/login")).toHaveLength(1);
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
});

it("manually retries the approved request without restarting recovery or replacing its keys", async () => {
  let completions = 0;
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path === "/api/device-links/recover") return { linkRequestId: "retry", challengeNonce: "nonce", expiresAt: Date.now() + 60000 } as never;
    if (path === "/api/device-links/retry/complete") {
      if (++completions === 1) throw new Error("Connection lost");
      return auth as never;
    }
    throw new Error(`unexpected ${path}`);
  });
  vi.mocked(api.get).mockResolvedValue({ status: "approved", challengeNonce: "nonce" } as never);
  await signIn("recovery-key");
  expect(container.textContent).toContain("Still working…");
  await click("Retry");
  expect(posts("/api/device-links/recover")).toHaveLength(1);
  expect(posts("/api/device-links/retry/complete")).toHaveLength(2);
  expect(keyManager.initializeKeys).toHaveBeenCalledTimes(1);
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
  expect(applyAuthResponse).toHaveBeenCalledWith(auth);
});

it("does not resume a saved recovery until its existing keys unlock successfully", async () => {
  const { RECOVERY_RETRY_KEY } = await import("../features/auth/recoveryRetry.js");
  const saved = { linkRequestId: "saved", challengeNonce: "nonce", mode: "recovery", deviceName: "Test browser", expiresAt: Date.now() + 60000, username: "alice" };
  sessionStorage.setItem(RECOVERY_RETRY_KEY, JSON.stringify(saved));
  vi.mocked(keyManager.loadKeys).mockRejectedValueOnce(new Error("Wrong password"));
  await signIn();
  expect(container.textContent).toContain("Wrong password");
  expect(container.querySelector<HTMLInputElement>('[placeholder="Username"]')!.readOnly).toBe(true);
  expect(api.get).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
  expect(keyManager.initializeKeys).not.toHaveBeenCalled();
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem(RECOVERY_RETRY_KEY)!)).toEqual(saved);
});

it("shows the passkey action only when the platform supports it", async () => {
  const { capabilities } = await import("../platform/capabilities.js");
  const passkeys = vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(false);
  try {
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    expect(container.textContent).not.toContain("Sign in with a passkey");
    passkeys.mockReturnValue(true);
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    expect(container.textContent).toContain("Sign in with a passkey");
  } finally { passkeys.mockRestore(); }
});

it("shows native passkey login and preserves the local-key password unlock step", async () => {
  const { capabilities } = await import("../platform/capabilities.js");
  const { signInWithNativePasskey } = await import("../lib/native-passkeys.js");
  const native = vi.spyOn(capabilities, "nativePasskeys", "get").mockReturnValue(true);
  const web = vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(false);
  vi.mocked(signInWithNativePasskey).mockResolvedValue(linkedAuth as never);
  useAuthStore.setState({ device: { id: "existing-device" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  try {
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    expect(container.textContent).toContain("Sign in with a passkey");
    await click("Sign in with a passkey");
    expect(signInWithNativePasskey).toHaveBeenCalledWith("existing-device", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(keyManager.lockLocalCryptoState).toHaveBeenCalled();
    expect(applyAuthResponse).toHaveBeenCalledWith(linkedAuth);
    expect(keyManager.loadKeys).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  } finally { native.mockRestore(); web.mockRestore(); }
});

function preparedFixture(controller: Partial<Awaited<ReturnType<Awaited<ReturnType<typeof preparePasskeyDeviceSetup>>["authorize"]>>>) {
  const authorize = vi.fn().mockResolvedValue(controller);
  const fixture = { setupId: "00000000-0000-4000-8000-000000000001", authorize,
    requestAutofill: vi.fn(() => new Promise<never>(() => undefined)), discard: vi.fn(async () => undefined) } as const;
  vi.mocked(preparePasskeyDeviceSetup).mockResolvedValue(fixture);
  return fixture;
}

it("prefetches before the tap, then aborts conditional autofill before invoking the same prepared ceremony", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  vi.stubGlobal("PublicKeyCredential", { isConditionalMediationAvailable: vi.fn(async () => true) });
  const { authorize, requestAutofill } = preparedFixture({ canUsePasswordFallback: () => true, method: "password", discard: vi.fn() });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(preparePasskeyDeviceSetup).toHaveBeenCalledOnce();
  expect(container.querySelector('input[autocomplete="username webauthn"]')).not.toBeNull();
  expect(requestAutofill).toHaveBeenCalledOnce();
  const signal: AbortSignal = (requestAutofill.mock.calls as unknown as [AbortSignal][])[0][0];
  expect(signal.aborted).toBe(false);
  expect(authorize).not.toHaveBeenCalled();
  await click("Sign in with a passkey");
  expect(signal.aborted).toBe(true);
  expect(authorize).toHaveBeenCalledOnce();
  expect(getByRole(container, "heading", { level: 1, name: "Setting up this device" })).toBe(document.activeElement);
});

it("keeps password sign-in available offline and prepares again when the user retries", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  const onLine = vi.spyOn(Navigator.prototype, "onLine", "get").mockReturnValue(false);
  preparedFixture({ canUsePasswordFallback: () => true });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(getByRole<HTMLButtonElement>(container, "button", { name: "Sign in with a passkey" }).disabled).toBe(true);
  expect(getByRole<HTMLButtonElement>(container, "button", { name: "Sign In" }).disabled).toBe(false);
  onLine.mockReturnValue(true);
  await click("Retry");
  expect(preparePasskeyDeviceSetup).toHaveBeenCalledOnce();
  expect(getByRole<HTMLButtonElement>(container, "button", { name: "Sign in with a passkey" }).disabled).toBe(false);
});

it("offers Safari a focused second tap when options are still being prepared", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  vi.spyOn(Navigator.prototype, "userAgent", "get").mockReturnValue("Mozilla AppleWebKit Version/26.0 Safari");
  const prepared = preparedFixture({ canUsePasswordFallback: () => true, discard: vi.fn() });
  let resolve!: () => void;
  vi.mocked(preparePasskeyDeviceSetup).mockReturnValueOnce(new Promise(done => { resolve = () => done(prepared); }));
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  expect(getByRole(container, "status").textContent).toContain("Preparing sign-in");
  await act(async () => resolve());
  expect(prepared.authorize).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(getByRole(container, "button", { name: "Continue with passkey" }));
  await click("Continue with passkey");
  expect(prepared.authorize).toHaveBeenCalledOnce();
});

it.each([false, true])("requires a named selection and offers to continue if a slot opens (%s)", async slotOpens => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  const controller = {
    method: "passkey" as const,
    deviceLimit: { error: "device_limit" as const, slotsToFree: 1, limit: 10, hasRecoveryKey: true, limitTicket: "ticket",
      devices: [{ id: "old", name: "Old laptop", platform: "macos" as const, lastActiveAt: 1, createdAt: 1,
        activatedAt: 1, linkMethod: "passkey" as const }] },
    replace: vi.fn(async (target: string | null) => {
      if (target && slotOpens) throw { status: 409, body: { error: "replacement_not_needed", canContinue: true } };
      controller.deviceLimit = undefined as never;
    }),
    canUsePasswordFallback: () => true, discard: vi.fn(),
  };
  preparedFixture(controller);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  await click("Replace a device");
  expect(getByRole(container, "radiogroup", { name: "Replace a device" })).toBeTruthy();
  expect(getByRole<HTMLButtonElement>(container, "button", { name: "Continue" }).disabled).toBe(true);
  await act(async () => getByRole<HTMLInputElement>(container, "radio", { name: /Old laptop, Last active/ }).click());
  await click("Continue");
  expect(getByRole(container, "heading", { level: 1, name: "Confirm with your recovery key" })).toBe(document.activeElement);
  expect(getByRole(container, "button", { name: "Replace Old laptop" })).toBeTruthy();
  const field = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "abcd-efgh");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await submit();
  expect(controller.replace).toHaveBeenCalledWith("old", "abcd-efgh");
  if (slotOpens) {
    expect(container.textContent).toContain("You can continue without removing Old laptop");
    expect(getByRole<HTMLButtonElement>(container, "button", { name: "Replace Old laptop" }).disabled).toBe(true);
    await click("Continue");
    expect(controller.replace).toHaveBeenLastCalledWith(null, undefined);
  }
});

it("requires choosing Skip after explaining permanent loss on a passkey-only vault", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  const controller = {
    method: "passkey" as const, pending: { deviceName: "Laptop", user: { username: "alice" } } as never,
    canUsePasswordFallback: () => true, persistUnlock: vi.fn(async () => undefined),
    chooseBackupPassword: vi.fn(async () => undefined), complete: vi.fn(async () => auth as never), discard: vi.fn(), setupId: "setup",
  };
  preparedFixture(controller);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  expect(container.textContent).toContain("Passkey unlock is on");
  expect(controller.persistUnlock).toHaveBeenCalledTimes(1);
  await click("Continue");
  expect(getByRole(container, "heading", { name: "Add password unlock" })).toBeTruthy();
  expect(controller.persistUnlock).toHaveBeenCalledTimes(1);
  await click("Skip");
  const confirm = getByRole(document.body, "alertdialog", { name: "Skip password unlock?" });
  expect(confirm.textContent).toContain("resetting this device erases its history");
  expect(getByRole(confirm, "button", { name: "Add password unlock" })).toBe(document.activeElement);
  expect(controller.complete).not.toHaveBeenCalled();
  await act(async () => getByRole<HTMLButtonElement>(confirm, "button", { name: "Skip" }).click());
  expect(controller.complete).toHaveBeenCalledTimes(1);
});

it.each(["unlock", "backup"])("can cancel from the %s screen after automatic passkey enrollment", async screen => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  const controller = {
    setupId: "setup", method: "passkey" as const, pending: { deviceName: "Laptop", user: { username: "alice" } } as never,
    canUsePasswordFallback: vi.fn(() => true),
    persistUnlock: vi.fn(async () => {
      vi.mocked(readPendingPasskeySetup).mockResolvedValue({ setupId: "setup", stage: "unlockReady", backupPending: "passkey" } as never);
      vi.mocked(keyManager.listLocalUnlockMethods).mockResolvedValue(["passkey"]);
      controller.canUsePasswordFallback.mockReturnValue(false);
    }),
    abandon: vi.fn(), discard: vi.fn(), chooseBackupPassword: vi.fn(), complete: vi.fn(),
  };
  preparedFixture(controller);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  expect(container.textContent).toContain("Passkey unlock is on");
  if (screen === "backup") await click("Continue");
  await act(async () => getByRole<HTMLButtonElement>(container, "button", { name: "Cancel" }).click());
  expect(getByRole(container, "heading", { name: "Finish setting up this device" })).toBeTruthy();
  expect(getByRole(container, "button", { name: "Unlock with passkey" })).toBeTruthy();
  expect(controller.discard).toHaveBeenCalledOnce();
  expect(controller.abandon).not.toHaveBeenCalled();
  expect(controller.chooseBackupPassword).not.toHaveBeenCalled();
  expect(controller.complete).not.toHaveBeenCalled();
  expect(applyAuthResponse).not.toHaveBeenCalled();
  await click("Forget this device");
  const dialog = getByRole(document.body, "alertdialog");
  expect(getByRole<HTMLButtonElement>(dialog, "button", { name: "Forget keys" }).disabled).toBe(true);
  expect(forgetSavedPasskeySetup).not.toHaveBeenCalled();
});

it("asks for password unlock only when the provisioning assertion produced no PRF result", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  const controller = {
    method: "password" as const, pending: { deviceName: "Laptop", user: { username: "alice" } } as never,
    canUsePasswordFallback: () => true, persistUnlock: vi.fn(), discard: vi.fn(),
  };
  preparedFixture(controller);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  await click("Continue");
  expect(getByRole(container, "heading", { name: "Enter your password once" })).toBeTruthy();
  expect(container.textContent).toContain("This passkey couldn’t unlock this device.");
  expect(controller.persistUnlock).not.toHaveBeenCalled();
});

it("shows neutral copy when a native user chooses password-only setup", async () => {
  vi.spyOn(capabilities, "nativePasskeys", "get").mockReturnValue(true);
  vi.spyOn(capabilities, "nativePasskeyProvisioning", "get").mockReturnValue(true);
  vi.spyOn(capabilities, "biometricUnlock", "get").mockReturnValue("touchid");
  const persistUnlock = vi.fn();
  preparedFixture({ method: "native", pending: { deviceName: "Mac", user: { username: "alice" } } as never,
    canUsePasswordFallback: () => true, persistUnlock, discard: vi.fn() });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  await click("Continue");
  await click("Use password only");
  expect(getByRole(container, "heading", { name: "Enter your password once" })).toBeTruthy();
  expect(container.textContent).toContain("Enter your account password to set up password unlock.");
  expect(container.textContent).not.toContain("This passkey couldn’t unlock this device.");
  expect(persistUnlock).not.toHaveBeenCalled();
});

it("takes first-device setup straight to password when native enrollment is unsupported", async () => {
  vi.spyOn(capabilities, "nativePasskeys", "get").mockReturnValue(true);
  vi.spyOn(capabilities, "nativePasskeyProvisioning", "get").mockReturnValue(true);
  const invoke = vi.fn().mockRejectedValue("unsupported");
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlock: "windows-hello" });
  vi.stubGlobal("navigator", { userAgent: "Windows", locks: { request: vi.fn() } });
  const persistUnlock = vi.fn(() => biometricUnlock.enroll("setup-slot", new Uint8Array(32)));
  const complete = vi.fn().mockResolvedValue(auth);
  preparedFixture({ method: "native", pending: { deviceName: "PC", user: { username: "alice" } } as never,
    canUsePasswordFallback: () => true, persistUnlock, complete, discard: vi.fn() });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  await click("Continue");
  await click("Use Windows Hello");
  await act(async () => { await persistUnlock.mock.results[0].value.catch(() => undefined); });
  expect(getByRole(container, "heading", { name: "Enter your password once" })).toBeTruthy();
  expect(container.textContent).toContain("This device doesn't support setting up Windows Hello for Private Base.");
  expect(queryByRole(container, "button", { name: "Use Windows Hello" })).toBeNull();
  expect(canEnrollNativeUnlock()).toBe(false);

  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "account-password");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await submit();
  expect(complete).toHaveBeenCalledExactlyOnceWith("account-password");
  expect(invoke).toHaveBeenCalledOnce();
});

it("keeps a native passkey setup resumable while its unlock capability is being probed", async () => {
  const invoke = vi.fn().mockResolvedValue("fingerprint");
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { androidBiometricProbe: true });
  vi.mocked(readPendingPasskeySetup).mockResolvedValue({ setupId: "setup", stage: "unlockReady", backupPending: "native" } as never);
  vi.mocked(keyManager.listLocalUnlockMethods).mockResolvedValue(["native"]);
  vi.mocked(resumePasskeyDeviceSetup).mockResolvedValueOnce({
    setupId: "setup", backupMethod: "native", chooseBackupPassword: vi.fn(), complete: vi.fn(),
  });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(getByRole(container, "button", { name: "Unlock with biometrics" })).toBeTruthy();
  await act(async () => { await refreshNativeUnlockCapability(); });
  await click("Unlock with fingerprint");
  expect(resumePasskeyDeviceSetup).toHaveBeenCalledWith("native", undefined, undefined, expect.any(AbortSignal), expect.any(Function));
  expect(getByRole(container, "heading", { name: "Add password unlock" })).toBeTruthy();
});

it.each(["fresh", "saved"] as const)("can use password during a stalled native %s setup prompt", async mode => {
  vi.spyOn(capabilities, "nativePasskeys", "get").mockReturnValue(true);
  vi.spyOn(capabilities, "nativePasskeyProvisioning", "get").mockReturnValue(true);
  const invoke = vi.fn(() => new Promise<string>(() => {}));
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { biometricUnlock: "windows-hello" });
  vi.stubGlobal("navigator", { userAgent: "Windows", locks: { request: vi.fn() } });
  const complete = vi.fn().mockResolvedValue(auth);
  if (mode === "fresh") {
    preparedFixture({ method: "native", pending: { deviceName: "PC", user: { username: "alice" } } as never,
      canUsePasswordFallback: () => true, complete, discard: vi.fn(),
      persistUnlock: (_password?: string, signal?: AbortSignal) => biometricUnlock.enroll("setup-slot", new Uint8Array(32), signal),
    });
  } else {
    vi.mocked(readPendingPasskeySetup).mockResolvedValue({ setupId: "setup", stage: "unlockReady" } as never);
    vi.mocked(keyManager.listLocalUnlockMethods).mockResolvedValue(["native", "password"]);
    vi.mocked(resumePasskeyDeviceSetup)
      .mockImplementationOnce(async (_method, _password, _replacement, signal) => {
        await biometricUnlock.unlock("setup-slot", signal);
        return auth as never;
      })
      .mockResolvedValueOnce(auth as never);
  }
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  if (mode === "fresh") {
    await click("Sign in with a passkey");
    await click("Continue");
    await click("Use Windows Hello");
  } else await click("Unlock with Windows Hello");
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());

  if (mode === "fresh") await click("Use password only");
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "account-password");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(getByRole<HTMLButtonElement>(container, "button", { name: "Continue" }).disabled).toBe(false);
  await submit();
  if (mode === "fresh") expect(complete).toHaveBeenCalledExactlyOnceWith("account-password");
  else expect(resumePasskeyDeviceSetup).toHaveBeenLastCalledWith("password", "account-password", undefined);
  expect(applyAuthResponse).toHaveBeenCalledWith(auth);
  expect(invoke).toHaveBeenCalledOnce();
});

it("consumes the native activation result when password is submitted after local unlock", async () => {
  vi.spyOn(capabilities, "biometricUnlock", "get").mockReturnValue("windows-hello");
  vi.mocked(readPendingPasskeySetup).mockResolvedValue({ setupId: "setup", stage: "unlockReady" } as never);
  vi.mocked(keyManager.listLocalUnlockMethods).mockResolvedValue(["native", "password"]);
  let finish!: (result: Awaited<ReturnType<typeof resumePasskeyDeviceSetup>>) => void;
  const activating = new Promise<Awaited<ReturnType<typeof resumePasskeyDeviceSetup>>>(resolve => { finish = resolve; });
  vi.mocked(resumePasskeyDeviceSetup).mockImplementationOnce(async (_method, _password, _replacement, _signal, onLocalUnlock) => {
    onLocalUnlock?.();
    return activating;
  });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "account-password");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Unlock with Windows Hello");
  expect(getByRole<HTMLButtonElement>(container, "button", { name: "Continue" }).disabled).toBe(true);
  // A queued submit must respect the phase change even if it bypasses the disabled button.
  await submit();
  expect(vi.mocked(resumePasskeyDeviceSetup).mock.calls[0][3]?.aborted).toBe(false);
  expect(resumePasskeyDeviceSetup).toHaveBeenCalledOnce();
  await act(async () => { finish(auth as never); });
  expect(applyAuthResponse).toHaveBeenCalledExactlyOnceWith(auth);
  expect(resumePasskeyDeviceSetup).toHaveBeenCalledOnce();
});

it.each(["add", "skip", "activation retry", "invalid password", "locked vault"])("restores the backup choice after reload (%s)", async choice => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  vi.mocked(keyManager.listLocalUnlockMethods).mockResolvedValue(["passkey"]);
  vi.mocked(readPendingPasskeySetup).mockResolvedValue({ setupId: "setup", stage: "unlockReady", backupPending: "passkey" } as never);
  const chooseBackupPassword = vi.fn(async (_password?: string) => undefined);
  const complete = vi.fn(async () => auth as never);
  if (choice === "activation retry") complete.mockRejectedValueOnce(new Error("Network read failed"));
  if (choice === "invalid password") chooseBackupPassword.mockRejectedValueOnce({ status: 401, body: { error: "invalid_password" } });
  if (choice === "locked vault") chooseBackupPassword.mockRejectedValueOnce(Object.assign(new Error(), { name: "KeysLockedError" }));
  vi.mocked(resumePasskeyDeviceSetup).mockResolvedValueOnce({ setupId: "setup", backupMethod: "passkey", chooseBackupPassword, complete });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(getByRole(container, "heading", { name: "Finish setting up this device" })).toBeTruthy();
  await click("Unlock with passkey");
  expect(resumePasskeyDeviceSetup).toHaveBeenCalledWith("passkey", undefined, undefined);
  expect(getByRole(container, "heading", { name: "Add password unlock" })).toBeTruthy();
  expect(applyAuthResponse).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  const skip = choice === "skip" || choice === "locked vault";
  if (skip) {
    await click("Skip");
    const confirm = getByRole(document.body, "alertdialog", { name: "Skip password unlock?" });
    expect(confirm.textContent).toContain("resetting this device erases its history");
    expect(chooseBackupPassword).not.toHaveBeenCalled();
    await act(async () => getByRole<HTMLButtonElement>(confirm, "button", { name: "Skip" }).click());
  } else {
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "account-password");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit();
  }
  expect(chooseBackupPassword).toHaveBeenCalledExactlyOnceWith(skip ? undefined : "account-password");
  if (choice === "invalid password") {
    expect(getByRole(container, "heading", { name: "Add password unlock" })).toBeTruthy();
    expect(getByRole(container, "alert").textContent).toContain("That password is not correct.");
    expect(complete).not.toHaveBeenCalled();
    return;
  }
  if (choice === "locked vault") {
    expect(getByRole(container, "heading", { name: "Finish setting up this device" })).toBeTruthy();
    expect(getByRole(container, "button", { name: "Unlock with passkey" })).toBeTruthy();
    expect(queryByRole(container, "button", { name: "Skip" })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    return;
  }
  if (choice === "activation retry") {
    expect(getByRole(container, "heading", { name: "Finish setting up this device" })).toBeTruthy();
    expect(getByRole(container, "alert").textContent).toContain("Network read failed");
    expect(queryByRole(container, "button", { name: "Skip" })).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(applyAuthResponse).not.toHaveBeenCalled();
    await click("Retry");
    expect(chooseBackupPassword).toHaveBeenCalledOnce();
    expect(resumePasskeyDeviceSetup).toHaveBeenCalledOnce();
    expect(complete.mock.calls).toEqual([[], []]);
  } else expect(complete).toHaveBeenCalledExactlyOnceWith();
  expect(applyAuthResponse).toHaveBeenCalledWith(auth);
});

it.each(["retry with password", "forget"])("refreshes the saved setup when resumed activation reaches capacity (%s)", async action => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  vi.mocked(keyManager.listLocalUnlockMethods).mockResolvedValue(["passkey"]);
  vi.mocked(readPendingPasskeySetup).mockResolvedValue({ setupId: "setup", stage: "unlockReady", backupPending: "passkey" } as never);
  const chooseBackupPassword = vi.fn(async (_password?: string) => {
    vi.mocked(readPendingPasskeySetup).mockResolvedValue({ setupId: "setup", stage: "unlockReady", backupPending: false } as never);
    vi.mocked(keyManager.listLocalUnlockMethods).mockResolvedValue(["passkey", "password"]);
  });
  const complete = vi.fn().mockRejectedValue({ status: 409, body: {
    error: "device_limit", slotsToFree: 1, limit: 10, hasRecoveryKey: false, limitTicket: null, devices: [],
  } });
  vi.mocked(resumePasskeyDeviceSetup).mockResolvedValueOnce({ setupId: "setup", backupMethod: "passkey", chooseBackupPassword, complete });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Unlock with passkey");
  const backup = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(backup, "account-password");
    backup.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await submit();
  expect(chooseBackupPassword).toHaveBeenCalledExactlyOnceWith("account-password");
  expect(complete).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("remove one in Settings");
  const unlock = getByRole<HTMLSelectElement>(container, "combobox", { name: "Choose how to unlock" });
  expect(Array.from(unlock.options, option => option.value)).toEqual(["passkey", "password"]);
  expect(applyAuthResponse).not.toHaveBeenCalled();
  if (action === "retry with password") {
    vi.mocked(resumePasskeyDeviceSetup).mockResolvedValueOnce(auth as never);
    await act(async () => {
      unlock.value = "password";
      unlock.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "account-password");
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Try again");
    expect(resumePasskeyDeviceSetup).toHaveBeenLastCalledWith("password", "account-password", undefined);
    expect(complete).toHaveBeenCalledOnce();
    expect(applyAuthResponse).toHaveBeenCalledWith(auth);
  } else {
    vi.mocked(forgetSavedPasskeySetup).mockImplementationOnce(async () => {
      vi.mocked(readPendingPasskeySetup).mockResolvedValue(undefined);
      return true;
    });
    await click("Forget this device");
    const dialog = getByRole(document.body, "alertdialog");
    await act(async () => getByRole<HTMLInputElement>(dialog, "checkbox").click());
    await act(async () => getByRole<HTMLButtonElement>(dialog, "button", { name: "Forget keys" }).click());
    expect(forgetSavedPasskeySetup).toHaveBeenCalledExactlyOnceWith("setup");
    expect(getByRole(container, "textbox", { name: "Username" })).toBeTruthy();
    expect(queryByRole(container, "heading", { name: "Finish setting up this device" })).toBeNull();
    expect(applyAuthResponse).not.toHaveBeenCalled();
  }
});

it.each(["No passkeys registered", "Network failure"])("keeps password errors visible after %s in background preparation", async problem => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  useAuthStore.setState({ device: { id: "existing-device" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "alice-id", username: "alice", deviceId: "existing-device" });
  vi.mocked(api.post).mockImplementation(async path => {
    if (path === "/auth/passkey/login-options") {
      throw Object.assign(new Error(), { status: problem === "No passkeys registered" ? 404 : 503, body: { error: problem } });
    }
    throw new Error("Invalid credentials");
  });
  await signIn();
  expect(container.textContent).toContain("Invalid credentials");
  if (problem === "No passkeys registered") {
    expect(container.textContent).not.toContain("Couldn't prepare passkey sign-in");
    expect(container.textContent).not.toContain("Sign in with a passkey");
  } else expect(container.textContent).toContain("Couldn't prepare passkey sign-in");
});

it("allows a legacy linked credential on explicit sign-in while keeping conditional autofill discoverable", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  vi.stubGlobal("PublicKeyCredential", { isConditionalMediationAvailable: vi.fn(async () => true) });
  useAuthStore.setState({ device: { id: "existing-device" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  const options = { challenge: "test", rpId: "localhost", timeout: 60_000, userVerification: "preferred",
    allowCredentials: [{ id: "AQID", type: "public-key" as const }] };
  vi.mocked(api.post).mockImplementation(async path => path === "/auth/passkey/login-options" ? { challengeId: "prepared", options } as never : linkedAuth as never);
  vi.mocked(getPasskeyAssertion).mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValueOnce({ id: "AQID" } as never);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(getPasskeyAssertion).toHaveBeenCalledWith({ ...options, allowCredentials: [] }, expect.objectContaining({ mediation: "conditional" }));
  const signal = vi.mocked(getPasskeyAssertion).mock.calls[0][1]?.signal;
  await click("Sign in with a passkey");
  expect(signal?.aborted).toBe(true);
  expect(getPasskeyAssertion).toHaveBeenLastCalledWith(options, { signal: expect.any(AbortSignal) });
  expect(api.post).toHaveBeenLastCalledWith("/auth/passkey/login", { credential: { id: "AQID" }, deviceId: "existing-device", challengeId: "prepared" }, { signal: expect.any(AbortSignal) });
});

it.each([false, true])("refuses a mismatched legacy owner before any passkey authentication (native = %s)", async native => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(!native);
  vi.spyOn(capabilities, "nativePasskeys", "get").mockReturnValue(native);
  useAuthStore.setState({ device: { id: "bob-device", userId: "bob" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "alice-id", username: "alice" });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(queryByRole(container, "button", { name: "Sign in with a passkey" })).toBeNull();
  expect(getByRole(container, "button", { name: "Sign In" })).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  expect(getPasskeyAssertion).not.toHaveBeenCalled();
  expect(signInWithNativePasskey).not.toHaveBeenCalled();
  expect(keyManager.resetLocalDevice).not.toHaveBeenCalled();
});

it.each([false, true])("offers fresh provisioning only after confirmed removal of the revoked vault (native = %s)", async native => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(!native);
  vi.spyOn(capabilities, "nativePasskeys", "get").mockReturnValue(native);
  vi.spyOn(capabilities, "nativePasskeyProvisioning", "get").mockReturnValue(native);
  useAuthStore.setState({ device: { id: "revoked-device", userId: "alice-id" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "alice-id", username: "alice", deviceId: "revoked-device" });
  const unknownDevice = Object.assign(new Error("Unknown device"), { status: 401, body: { error: "Unknown device" } });
  vi.mocked(api.post).mockRejectedValue(unknownDevice);
  if (native) vi.mocked(signInWithNativePasskey).mockRejectedValueOnce(unknownDevice);
  vi.mocked(keyManager.resetLocalDevice).mockImplementationOnce(async () => {
    vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(false);
    vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue(null);
    return true;
  });
  const fixture = preparedFixture({ canUsePasswordFallback: () => true, discard: vi.fn() });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  if (native) await click("Sign in with a passkey");
  expect(container.textContent).toContain("This device was removed from your account.");
  expect(posts("/auth/passkey/login-options")).toHaveLength(1);
  await click("Forget this device");
  const dialog = getByRole(document.body, "alertdialog");
  const forget = getByRole<HTMLButtonElement>(dialog, "button", { name: "Forget keys" });
  expect(forget.disabled).toBe(true);
  expect(keyManager.resetLocalDevice).not.toHaveBeenCalled();
  await act(async () => getByRole<HTMLInputElement>(dialog, "checkbox").click());
  await act(async () => forget.click());
  expect(keyManager.resetLocalDevice).toHaveBeenCalledExactlyOnceWith(vaultKey);
  expect(logout).toHaveBeenCalledWith({ forgetDevice: true });
  expect(preparePasskeyDeviceSetup).toHaveBeenCalledOnce();
  expect(fixture.authorize).not.toHaveBeenCalled();
  expect(getByRole(container, "button", { name: "Sign in with a passkey" })).toBeTruthy();
  expect(posts("/auth/passkey/login-options")).toHaveLength(1);
});

it("does not offer to erase an active vault after native redeem tries a different account's passkey", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(false);
  vi.spyOn(capabilities, "nativePasskeys", "get").mockReturnValue(true);
  useAuthStore.setState({ device: { id: "existing-device" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(signInWithNativePasskey).mockRejectedValueOnce({ status: 401, body: { error: "Unknown device" } });
  vi.mocked(api.post).mockResolvedValueOnce({ challengeId: "active-device" });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  expect(container.textContent).not.toContain("This device was removed");
  expect(queryByRole(container, "button", { name: "Forget this device…" })).toBeNull();
  expect(keyManager.resetLocalDevice).not.toHaveBeenCalled();
  expect(applyAuthResponse).not.toHaveBeenCalled();
});

it.each(["released", "timed out"] as const)("waits for the native handoff before restarting sign-in (%s)", async result => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(false);
  vi.spyOn(capabilities, "nativePasskeys", "get").mockReturnValue(true);
  useAuthStore.setState({ device: { id: "existing-device" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  let settle!: () => void;
  const launcher = new Promise<void>((resolve, reject) => {
    settle = () => { if (result === "released") resolve(); else reject(new DOMException("Timed out", "TimeoutError")); };
  });
  vi.spyOn(passkeyHandoff, "waitForNativePasskeyHandoff").mockReturnValue(launcher);
  vi.mocked(signInWithNativePasskey).mockImplementationOnce(async (_, handoff) => {
    handoff!.onHandoff("browser");
    return new Promise((_, reject) => handoff!.signal.addEventListener("abort", () => reject(handoff!.signal.reason), { once: true }));
  }).mockResolvedValueOnce(linkedAuth as never);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  await click("Restart sign-in");
  expect(signInWithNativePasskey).toHaveBeenCalledOnce();
  expect(getByRole<HTMLButtonElement>(container, "button", { name: "Restart sign-in" }).disabled).toBe(true);
  await act(async () => settle());
  if (result === "released") {
    expect(signInWithNativePasskey).toHaveBeenCalledTimes(2);
    expect(applyAuthResponse).toHaveBeenCalledWith(linkedAuth);
  } else {
    expect(signInWithNativePasskey).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Signing in wasn't finished in time.");
    expect(getByRole(container, "button", { name: "Retry" })).toBeTruthy();
  }
});

it("pauses approved-link requests at the cap and resumes the same request on manual retry", async () => {
  const complete = "/api/device-links/approved/complete";
  let freeSlot = false;
  vi.mocked(api.post).mockImplementation(async path => {
    if (path === "/api/device-links/start") return { linkRequestId: "approved", shortCode: "123456", expiresAt: Date.now() + 60_000 } as never;
    if (path === complete && !freeSlot) throw { status: 409, body: { error: "device_limit_reached" } };
    if (path === complete && freeSlot) return auth as never;
    throw new Error(`Unexpected ${path}`);
  });
  vi.mocked(api.get).mockResolvedValue({ status: "approved", challengeNonce: "nonce" });
  const { signDeviceLinkCompletion } = await import("../lib/device-link.js");
  await signIn();
  await click("Approve from another device");
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(container.textContent).toContain("remove one in Settings");
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(api.get).toHaveBeenCalledOnce();
  expect(signDeviceLinkCompletion).toHaveBeenCalledOnce();
  expect(posts(complete)).toHaveLength(1);
  freeSlot = true;
  await click("Retry");
  expect(posts(complete)).toHaveLength(2);
  expect(posts("/api/device-links/start")).toHaveLength(1);
  expect(applyAuthResponse).toHaveBeenCalledWith(auth);
});

it("discards the prepared passkey bundle before password linking and prepares a new one on return", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  const stale = preparedFixture({ canUsePasswordFallback: () => true, discard: vi.fn() });
  const fresh = preparedFixture({ canUsePasswordFallback: () => true, discard: vi.fn() });
  vi.mocked(preparePasskeyDeviceSetup).mockResolvedValueOnce(stale);
  vi.mocked(api.post).mockImplementation(async path => {
    if (path === "/api/device-links/start") {
      expect(stale.discard).toHaveBeenCalledOnce();
      return { linkRequestId: "approved", shortCode: "123456", expiresAt: Date.now() + 60_000 } as never;
    }
    throw new Error(`Unexpected ${path}`);
  });
  await signIn();
  await click("Approve from another device");
  await click("Cancel");
  await click("Back to sign in");
  await click("Sign in with a passkey");
  expect(preparePasskeyDeviceSetup).toHaveBeenCalledTimes(2);
  expect(stale.authorize).not.toHaveBeenCalled();
  expect(fresh.authorize).toHaveBeenCalledOnce();
});

it("refreshes expired linked-device challenges before prompting even when the refresh timer has not fired", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  useAuthStore.setState({ device: { id: "existing-device" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  let requests = 0;
  vi.mocked(api.post).mockImplementation(async path => path === "/auth/passkey/login-options"
    ? { challengeId: `attempt-${++requests}`, options: { challenge: `challenge-${requests}` } } as never : linkedAuth as never);
  vi.mocked(getPasskeyAssertion).mockResolvedValue({ id: "passkey" } as never);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(requests).toBe(1);
  vi.setSystemTime(Date.now() + 6 * 60_000);
  await click("Sign in with a passkey");
  expect(requests).toBe(2);
  expect(getPasskeyAssertion).toHaveBeenCalledExactlyOnceWith({ challenge: "challenge-2" }, { signal: expect.any(AbortSignal) });
  expect(api.post).toHaveBeenLastCalledWith("/auth/passkey/login", { credential: { id: "passkey" }, deviceId: "existing-device", challengeId: "attempt-2" }, { signal: expect.any(AbortSignal) });
});

it("discards expired provisioning options and keeps the Safari second-tap gesture", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  vi.spyOn(Navigator.prototype, "userAgent", "get").mockReturnValue("Mozilla AppleWebKit Version/26.0 Safari");
  const stale = preparedFixture({ canUsePasswordFallback: () => true, discard: vi.fn() });
  const fresh = preparedFixture({ canUsePasswordFallback: () => true, discard: vi.fn() });
  vi.mocked(preparePasskeyDeviceSetup).mockResolvedValueOnce(stale);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(preparePasskeyDeviceSetup).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() + 6 * 60_000);
  await click("Sign in with a passkey");
  expect(preparePasskeyDeviceSetup).toHaveBeenCalledTimes(2);
  expect(stale.discard).toHaveBeenCalledOnce();
  expect(stale.authorize).not.toHaveBeenCalled();
  expect(fresh.authorize).not.toHaveBeenCalled();
  await click("Continue with passkey");
  expect(fresh.authorize).toHaveBeenCalledOnce();
});

it.each(["retry", "forget"])("offers %s when a replacement ticket expires after the vault has been saved", async action => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  const controller = {
    setupId: "durable", method: "password" as const, pending: { deviceName: "Browser" } as never,
    deviceLimit: { error: "device_limit" as const, slotsToFree: 1, limit: 10, hasRecoveryKey: true, limitTicket: "expired",
      devices: [{ id: "old", name: "Old laptop", platform: "macos" as const, lastActiveAt: 1, createdAt: 1,
        activatedAt: 1, linkMethod: "passkey" as const }] },
    replace: vi.fn(async () => { throw { status: 401, body: { error: "limit_ticket_expired" } }; }),
    canUsePasswordFallback: () => false, discard: vi.fn(), complete: vi.fn(async () => auth as never),
  };
  preparedFixture(controller);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  await click("Replace a device");
  await act(async () => getByRole<HTMLInputElement>(container, "radio", { name: /Old laptop/ }).click());
  await click("Continue");
  await act(async () => {
    const field = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "abcd-efgh");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await submit();
  expect(controller.replace).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("remove one in Settings");
  expect(queryByRole(container, "button", { name: "Use passkey" })).toBeNull();
  expect(preparePasskeyDeviceSetup).toHaveBeenCalledOnce();
  if (action === "retry") {
    await click("Try again");
    expect(controller.complete).toHaveBeenCalledOnce();
    expect(applyAuthResponse).toHaveBeenCalledWith(auth);
    expect(forgetSavedPasskeySetup).not.toHaveBeenCalled();
  } else {
    vi.mocked(readPendingPasskeySetup).mockResolvedValueOnce({ setupId: "durable", stage: "unlockReady" } as never);
    await click("Forget this device");
    const dialog = getByRole(document.body, "alertdialog");
    const forget = getByRole<HTMLButtonElement>(dialog, "button", { name: "Forget keys" });
    expect(forget.disabled).toBe(true);
    expect(forgetSavedPasskeySetup).not.toHaveBeenCalled();
    await act(async () => getByRole<HTMLInputElement>(dialog, "checkbox").click());
    await act(async () => forget.click());
    expect(controller.discard).toHaveBeenCalledOnce();
    expect(forgetSavedPasskeySetup).toHaveBeenCalledWith("durable");
    expect(preparePasskeyDeviceSetup).toHaveBeenCalledTimes(2);
  }
});

it("dismisses a revoked-vault confirmation when the captured vault has been replaced", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  useAuthStore.setState({ device: { id: "revoked-device", userId: "alice-id" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "alice-id", username: "alice", deviceId: "revoked-device" });
  vi.mocked(api.post).mockRejectedValueOnce({ status: 401, body: { error: "Unknown device" } });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Forget this device");
  const dialog = getByRole(document.body, "alertdialog");
  vi.mocked(keyManager.getLocalVaultKey).mockResolvedValue({ ...vaultKey, data: "replacement encrypted identity" });
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "alice-id", username: "alice", deviceId: "replacement" });
  await act(async () => getByRole<HTMLInputElement>(dialog, "checkbox").click());
  await act(async () => getByRole<HTMLButtonElement>(dialog, "button", { name: "Forget keys" }).click());
  expect(keyManager.resetLocalDevice).not.toHaveBeenCalled();
  expect(logout).not.toHaveBeenCalled();
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
});

it.each([false, true])("uses the neutral key-owner prompt when a legacy vault cannot prove the revoked ID (native = %s)", async native => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(!native);
  vi.spyOn(capabilities, "nativePasskeys", "get").mockReturnValue(native);
  useAuthStore.setState({ device: { id: "unrelated-revoked-device", userId: "alice-id" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "alice-id", username: "alice" });
  const unknown = { status: 401, body: { error: "Unknown device" } };
  vi.mocked(api.post).mockRejectedValueOnce(unknown);
  if (native) vi.mocked(signInWithNativePasskey).mockRejectedValueOnce(unknown);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  if (native) await click("Sign in with a passkey");
  expect(getByRole(container, "heading", { name: "This browser already holds encryption keys" })).toBeTruthy();
  expect(container.textContent).not.toContain("This device was removed from your account");
  expect(queryByRole(container, "button", { name: "Forget this device…" })).toBeNull();
  expect(keyManager.resetLocalDevice).not.toHaveBeenCalled();
  await click("Sign in as @alice instead");
  expect(getByRole(container, "button", { name: "Sign In" })).toBeTruthy();
  expect(posts("/auth/passkey/login-options")).toHaveLength(1);
});

it("does not prepare passkey options using a device ID superseded in storage before Login mounted", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  useAuthStore.setState({ device: { id: "old-device" }, sessionId: null } as never);
  localStorage.setItem("e2ee-auth", JSON.stringify({ state: { device: null, sessionId: null } }));
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keyManager.getLocalVaultKey).mockResolvedValue({ ...vaultKey, data: "replacement encrypted identity" });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  expect(posts("/auth/passkey/login-options")).toHaveLength(0);
  expect(keyManager.resetLocalDevice).not.toHaveBeenCalled();
});

it.each(["unmount", "session", "storage", "device", "vault"])("discards a submitted existing-device passkey login after a %s change", async changed => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  if (changed === "storage") vi.stubGlobal("PublicKeyCredential", { isConditionalMediationAvailable: async () => true });
  useAuthStore.setState({ device: { id: "existing-device", userId: "alice-id" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(getPasskeyAssertion).mockResolvedValue({ id: "credential" } as never);
  let resolveLogin!: () => void;
  vi.mocked(api.post).mockImplementation(async path => path === "/auth/passkey/login-options"
    ? { challengeId: "prepared", options: {} } as never
    : new Promise(resolve => { resolveLogin = () => resolve(linkedAuth as never); }));
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  if (changed !== "storage") await click("Sign in with a passkey");
  expect(posts("/auth/passkey/login")).toHaveLength(1);
  const signal = posts("/auth/passkey/login")[0][2]?.signal;
  await act(async () => {
    if (changed === "unmount") root.render(null);
    if (changed === "session") useAuthStore.setState({ sessionId: "new-session" });
    if (changed === "storage") localStorage.setItem("e2ee-auth", JSON.stringify({ state: { sessionId: "new-session" } }));
    if (changed === "device") vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue({ userId: "alice-id", username: "alice", deviceId: "replacement" });
    if (changed === "vault") vi.mocked(keyManager.getLocalVaultKey).mockResolvedValue({ ...vaultKey, data: "different vault" });
  });
  if (changed === "unmount") expect(signal?.aborted).toBe(true);
  await act(async () => resolveLogin());
  expect(keyManager.lockLocalCryptoState).not.toHaveBeenCalled();
  expect(applyAuthResponse).not.toHaveBeenCalled();
});

it.each(["unchanged", "changed", "changed back"])("starts approved linking automatically only for the unchanged authorized username (%s)", async account => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  const prepared = preparedFixture({});
  prepared.authorize.mockRejectedValueOnce(new DeviceApprovalRequiredError("alice"));
  vi.mocked(api.post).mockResolvedValue({ linkRequestId: "link", shortCode: "123456", expiresAt: Date.now() + 60_000 });
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  if (account !== "unchanged") await act(async () => type("Username", "bob"));
  if (account === "changed back") await act(async () => type("Username", "alice"));
  await act(async () => type("Password", "password"));
  await submit();
  if (account === "unchanged") {
    expect(posts("/api/device-links/start")).toEqual([["/api/device-links/start",
      expect.objectContaining({ username: "alice", password: "password" })]]);
  } else {
    expect(getByRole(container, "heading", { name: "Set up this device" })).toBeTruthy();
    expect(keyManager.initializeKeys).not.toHaveBeenCalled();
    expect(posts("/api/device-links/start")).toHaveLength(0);
  }
});

it("preserves a saved vault when approval turns on before completion and offers a confirmed alternative setup", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  const controller = {
    setupId: "setup", method: "passkey" as const, pending: { deviceName: "Browser", user: { username: "alice" } } as never,
    canUsePasswordFallback: () => true, discard: vi.fn(), persistUnlock: vi.fn(async () => undefined),
    chooseBackupPassword: vi.fn(async () => undefined),
    complete: vi.fn(async () => {
      vi.mocked(readPendingPasskeySetup).mockResolvedValue({ setupId: "setup", stage: "unlockReady" } as never);
      throw new DeviceApprovalRequiredError("alice");
    }),
  };
  preparedFixture(controller);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await click("Sign in with a passkey");
  await click("Continue");
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "account-password");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await submit();
  expect(controller.discard).toHaveBeenCalledOnce();
  expect(getByRole(container, "heading", { name: "Finish setting up this device" })).toBeTruthy();
  expect(container.textContent).toContain("Your account asks for approval");
  expect(keyManager.resetLocalCryptoState).not.toHaveBeenCalled();
  expect(forgetSavedPasskeySetup).not.toHaveBeenCalled();
  await click("Set up this device");
  const dialog = getByRole(document.body, "alertdialog");
  expect(getByRole<HTMLButtonElement>(dialog, "button", { name: "Forget keys" }).disabled).toBe(true);
  expect(forgetSavedPasskeySetup).not.toHaveBeenCalled();
  vi.mocked(forgetSavedPasskeySetup).mockImplementationOnce(async () => {
    vi.mocked(readPendingPasskeySetup).mockResolvedValue(undefined);
    return true;
  });
  await act(async () => getByRole<HTMLInputElement>(dialog, "checkbox").click());
  await act(async () => getByRole<HTMLButtonElement>(dialog, "button", { name: "Forget keys" }).click());
  await act(async () => type("Password", "account-password"));
  await submit();
  expect(getByRole(container, "button", { name: /Approve from another device/ })).toBeTruthy();
  expect(getByRole(container, "button", { name: /Use my recovery key/ })).toBeTruthy();
  expect(posts("/api/device-links/start")).toHaveLength(0);
});
