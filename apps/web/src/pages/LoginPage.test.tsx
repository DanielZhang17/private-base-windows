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
    hasLocalKeyMaterial: vi.fn(),
    initializeKeys: vi.fn(),
    keysLoaded: vi.fn(),
    lockLocalCryptoState: vi.fn(),
    loadKeys: vi.fn(),
    resetLocalCryptoState: vi.fn(),
    setLocalKeyOwner: vi.fn(),
  };
});
vi.mock("../lib/device-link.js", () => ({
  buildDefaultDeviceName: () => "Test browser",
  signDeviceLinkCompletion: vi.fn(async () => "signature"),
}));
vi.mock("../lib/native-passkeys.js", () => ({ signInWithNativePasskey: vi.fn() }));
vi.mock("../lib/webauthn.js", () => ({ isWebAuthnSupported: () => false, getPasskeyAssertion: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
const applyAuthResponse = vi.fn();
const logout = vi.fn();
const auth = { user: { id: "alice-id", username: "alice" }, device: { id: "new-device" }, accessToken: "a", refreshToken: "r" };

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
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  useAuthStore.setState({ device: null, applyAuthResponse, logout } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(false);
  vi.mocked(keyManager.getLocalKeyOwner).mockResolvedValue(null);
  vi.mocked(keyManager.keysLoaded).mockReturnValue(true);
  vi.mocked(keyManager.resetLocalCryptoState).mockResolvedValue();
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
  // Only the wipe that precedes key generation ran; the request's keys were never discarded.
  expect(keyManager.initializeKeys).toHaveBeenCalledTimes(1);
  expect(keyManager.resetLocalCryptoState).toHaveBeenCalledTimes(1);
  expect(vi.mocked(keyManager.resetLocalCryptoState).mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(keyManager.initializeKeys).mock.invocationCallOrder[0]);
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
  expect(keyManager.resetLocalCryptoState).toHaveBeenCalledTimes(1);
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
  expect(keyManager.resetLocalCryptoState).toHaveBeenCalledTimes(1);
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
  vi.mocked(signInWithNativePasskey).mockResolvedValue(auth as never);
  useAuthStore.setState({ device: { id: "existing-device" } } as never);
  vi.mocked(keyManager.hasLocalKeyMaterial).mockResolvedValue(true);
  try {
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    expect(container.textContent).toContain("Sign in with a passkey");
    await click("Sign in with a passkey");
    expect(signInWithNativePasskey).toHaveBeenCalledWith("existing-device");
    expect(keyManager.lockLocalCryptoState).toHaveBeenCalled();
    expect(applyAuthResponse).toHaveBeenCalledWith(auth);
    expect(keyManager.loadKeys).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  } finally { native.mockRestore(); web.mockRestore(); }
});
