import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UnlockPage from "./UnlockPage.js";
import { listLocalUnlockMethods, loadKeys, resetLocalDevice, unlockLocalKeys } from "../lib/key-manager.js";
import { capabilities } from "../platform/capabilities.js";
import { NativeBiometricError } from "../platform/biometric-unlock.js";
import { useAuthStore } from "../stores/authStore.js";

vi.mock("../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { username: "alice", displayName: "Alice" }, accessToken: "token", device: { id: "device" }, bumpSessionState: vi.fn(), logout: vi.fn() })) };
});
vi.mock("../lib/key-manager.js", () => ({ keysLoaded: () => false, loadKeys: vi.fn(), unlockLocalKeys: vi.fn(), resetLocalDevice: vi.fn(), listLocalUnlockMethods: vi.fn(async () => ["password"]) }));
vi.mock("../services/api.js", () => ({ resolveApiUrl: (path: string) => path }));
let root: Root;
let container: HTMLDivElement;
let pathname: string;
function Destination() { const l = useLocation(); pathname = `${l.pathname}${l.search}${l.hash}`; return null; }
beforeEach(async () => {
  const { clearUnlockAttempts } = await import("../features/auth/unlockAttempt.js");
  await clearUnlockAttempts("device");
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: "/unlock", state: { from: { pathname: "/chat/one", search: "?draft=yes", hash: "#latest" } } }]}><Routes><Route path="/unlock" element={<UnlockPage />} /><Route path="*" element={<Destination />} /></Routes></MemoryRouter>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const button = (name: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === name)!;

it("describes local passkey unlock on the lock screen", async () => {
  vi.spyOn(capabilities, "passkeys", "get").mockReturnValue(true);
  vi.mocked(listLocalUnlockMethods).mockResolvedValueOnce(["passkey"]);
  await act(async () => root.render(<MemoryRouter key="passkey"><UnlockPage /></MemoryRouter>));
  expect(container.textContent).toContain("Unlock with your passkey to see your messages.");
  expect(button("Unlock with passkey")).toBeDefined();
});

async function enterPassword() {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[placeholder="Password"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "password");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    const previous = vi.mocked(loadKeys).mock.calls.length;
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(loadKeys).toHaveBeenCalledTimes(previous + 1));
    await vi.mocked(loadKeys).mock.results.at(-1)?.value?.catch(() => undefined);
  });
}

it("selects a wrong password for retry and returns to the complete original location after unlocking", async () => {
  vi.mocked(loadKeys).mockRejectedValueOnce(new DOMException("The operation failed for an operation-specific reason", "OperationError"));
  await enterPassword();
  const input = container.querySelector<HTMLInputElement>('[placeholder="Password"]')!;
  expect(container.textContent).toContain("That password is not correct.");
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(8);
  vi.mocked(loadKeys).mockResolvedValueOnce({} as never);
  await enterPassword();
  expect(loadKeys).toHaveBeenCalledWith("password");
  expect(pathname).toBe("/chat/one?draft=yes#latest");
});

it.each([
  { record: { id: "identity", type: "identity", data: "remaining encrypted record" }, message: "No keys found — register first" },
  { record: { id: "dbKey", type: "salt", data: "AAAAAAAAAAAAAAAAAAAAAA" }, message: "Identity key not found" },
])("preserves the missing-key error with only the $record.id record remaining", async ({ record, message }) => {
  const actual = await vi.importActual<typeof import("../lib/key-manager.js")>("../lib/key-manager.js");
  const { getAppDB } = await import("../db/index.js");
  const db = await getAppDB();
  await db.clear("deviceKeys");
  await db.put("deviceKeys", record);
  try {
    expect(await actual.hasLocalKeyMaterial()).toBe(true);
    vi.mocked(loadKeys).mockImplementationOnce(actual.loadKeys);
    await enterPassword();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(container.textContent).not.toContain("That password is not correct.");
    expect(useAuthStore.getState().bumpSessionState).not.toHaveBeenCalled();
    expect(await db.get("deviceKeys", record.id)).toEqual(record);
  } finally {
    actual.lockLocalCryptoState();
    await db.clear("deviceKeys");
  }
});

it.each([
  new DOMException("IndexedDB could not read the encryption keys", "UnknownError"),
  new Error("Keys were locked during reload"),
  new Error("OperationError"),
])("preserves a non-password unlock error: $message", async (error) => {
  vi.mocked(loadKeys).mockRejectedValueOnce(error);
  await enterPassword();
  const expected = error.message === "Keys were locked during reload" ? error.message : `Failed to unlock this device\n${error.message}`;
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected);
  expect(container.textContent).not.toContain("That password is not correct.");
  expect(useAuthStore.getState().bumpSessionState).not.toHaveBeenCalled();
});

it("requires acknowledgement in the shared forget dialog before clearing local keys", async () => {
  await act(async () => button("Forget this device…").click());
  expect(resetLocalDevice).not.toHaveBeenCalled();
  expect(button("Forget keys").disabled).toBe(true);
  await act(async () => button("Forget keys").click());
  expect(resetLocalDevice).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLInputElement>('[role="alertdialog"] input[type="checkbox"]')!.click());
  await act(async () => button("Forget keys").click());
  expect(resetLocalDevice).toHaveBeenCalledTimes(1);
  expect(useAuthStore.getState().logout).toHaveBeenCalledWith({ forgetDevice: true });
  expect(pathname).toBe("/login");
});

it("auto-prompts once for Face ID and offers retry without reset during a temporary lockout", async () => {
  vi.spyOn(capabilities, "biometricUnlock", "get").mockReturnValue("faceid");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(listLocalUnlockMethods).mockResolvedValueOnce(["native"]);
  vi.mocked(unlockLocalKeys).mockRejectedValueOnce(new NativeBiometricError("lockout"));
  await act(async () => root.render(<MemoryRouter key="new-lock"><UnlockPage /></MemoryRouter>));
  expect(unlockLocalKeys).toHaveBeenCalledTimes(1);
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(button("Try again")).toBeTruthy();
  expect(button("Reset this device")).toBeUndefined();
  expect(container.textContent).toContain("Face ID is locked after too many tries");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(unlockLocalKeys).toHaveBeenCalledTimes(1);
});

it("labels the Windows unlock action Windows Hello", async () => {
  vi.spyOn(capabilities, "biometricUnlock", "get").mockReturnValue("windows-hello");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.mocked(listLocalUnlockMethods).mockResolvedValueOnce(["native"]);
  await act(async () => root.render(<MemoryRouter key="windows-hello"><UnlockPage /></MemoryRouter>));
  expect(button("Unlock with Windows Hello")).toBeTruthy();
});

it("retries a temporarily unavailable Windows Hello-only slot without resetting the device", async () => {
  vi.spyOn(capabilities, "biometricUnlock", "get").mockReturnValue("windows-hello");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(listLocalUnlockMethods).mockResolvedValueOnce(["native"]);
  vi.mocked(unlockLocalKeys)
    .mockRejectedValueOnce(new NativeBiometricError("failed"))
    .mockResolvedValueOnce(undefined);
  await act(async () => root.render(<MemoryRouter key="hello-retry"><UnlockPage /></MemoryRouter>));
  expect(unlockLocalKeys).toHaveBeenCalledTimes(1);
  expect(button("Reset this device")).toBeUndefined();
  await act(async () => button("Try again").click());
  expect(unlockLocalKeys).toHaveBeenCalledTimes(2);
  expect(useAuthStore.getState().bumpSessionState).toHaveBeenCalledTimes(1);
  expect(resetLocalDevice).not.toHaveBeenCalled();
});

it("offers a confirmed reset only after the sole native method reports permanent invalidation", async () => {
  vi.spyOn(capabilities, "biometricUnlock", "get").mockReturnValue("windows-hello");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(listLocalUnlockMethods).mockResolvedValueOnce(["native"]);
  vi.mocked(unlockLocalKeys).mockRejectedValueOnce(new NativeBiometricError("invalidated"));
  await act(async () => root.render(<MemoryRouter key="permanent-loss"><UnlockPage /></MemoryRouter>));
  expect(container.textContent).toContain("Windows Hello changed");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  await act(async () => button("Reset this device").click());
  expect(button("Forget keys").disabled).toBe(true);
  expect(resetLocalDevice).not.toHaveBeenCalled();
});

it("retries a failed unlock-method read without changing the vault", async () => {
  vi.mocked(listLocalUnlockMethods).mockRejectedValueOnce(new DOMException("Read failed", "UnknownError"));
  await act(async () => root.render(<MemoryRouter key="read-failure"><UnlockPage /></MemoryRouter>));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Failed to unlock this device");
  expect(button("Forget this device…")).toBeUndefined();
  expect(container.querySelector('input[type="password"]')).toBeNull();
  await act(async () => button("Retry").click());
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(resetLocalDevice).not.toHaveBeenCalled();
});

it.each(["/devices", "/settings?section=privacy"])("opens the protected destination %s after unlock", async destination => {
  const [targetPath, search] = destination.split("?");
  await act(async () => root.render(<MemoryRouter key={destination} initialEntries={[
    { pathname: "/unlock", state: { from: { pathname: targetPath, search: search ? `?${search}` : "" } } },
  ]}><Routes><Route path="/unlock" element={<UnlockPage />} /><Route path="*" element={<Destination />} /></Routes></MemoryRouter>));
  await enterPassword();
  expect(pathname).toBe(destination);
});

it("offers restoring an invalidated biometric slot after a password retry", async () => {
  const { unlockOfferFor, dismissUnlockOffer } = await import("../features/auth/unlockOfferState.js");
  dismissUnlockOffer("device");
  vi.spyOn(capabilities, "biometricUnlock", "get").mockReturnValue("touchid");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(listLocalUnlockMethods).mockResolvedValueOnce(["native", "password"]);
  vi.mocked(unlockLocalKeys).mockRejectedValueOnce(new NativeBiometricError("invalidated"));
  vi.mocked(loadKeys).mockRejectedValueOnce(new DOMException("Wrong password", "OperationError"));
  await act(async () => root.render(<MemoryRouter key="restore"><Routes><Route path="/" element={<UnlockPage />} /></Routes></MemoryRouter>));
  await enterPassword();
  expect(unlockOfferFor("device")).toBeNull();
  await enterPassword();
  expect(unlockOfferFor("device")).toBe("restore");
  dismissUnlockOffer("device");
});
