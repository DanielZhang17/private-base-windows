import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UnlockPage from "./UnlockPage.js";
import { loadKeys, resetLocalCryptoState } from "../lib/key-manager.js";
import { useAuthStore } from "../stores/authStore.js";

vi.mock("../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { username: "alice", displayName: "Alice" }, accessToken: "token", device: { id: "device" }, bumpSessionState: vi.fn(), logout: vi.fn() })) };
});
vi.mock("../lib/key-manager.js", () => ({ keysLoaded: () => false, loadKeys: vi.fn(), resetLocalCryptoState: vi.fn() }));
vi.mock("../services/api.js", () => ({ resolveApiUrl: (path: string) => path }));
let root: Root;
let container: HTMLDivElement;
let pathname: string;
function Destination() { const l = useLocation(); pathname = `${l.pathname}${l.search}${l.hash}`; return null; }
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: "/unlock", state: { from: { pathname: "/chat/one", search: "?draft=yes", hash: "#latest" } } }]}><Routes><Route path="/unlock" element={<UnlockPage />} /><Route path="*" element={<Destination />} /></Routes></MemoryRouter>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (name: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === name)!;
async function enterPassword() {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[placeholder="Password"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "password");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.mocked(loadKeys).mock.results.at(-1)!.value?.catch(() => undefined);
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
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>("node:crypto");
  vi.stubGlobal("crypto", webcrypto);
  const actual = await vi.importActual<typeof import("../lib/key-manager.js")>("../lib/key-manager.js");
  const { getAppDB } = await import("../db/index.js");
  const db = await getAppDB();
  await db.clear("localKeys");
  await db.put("localKeys", record);
  try {
    expect(await actual.hasLocalKeyMaterial()).toBe(true);
    vi.mocked(loadKeys).mockImplementationOnce(actual.loadKeys);
    await enterPassword();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(container.textContent).not.toContain("That password is not correct.");
    expect(useAuthStore.getState().bumpSessionState).not.toHaveBeenCalled();
    expect(await db.get("localKeys", record.id)).toEqual(record);
  } finally {
    actual.lockLocalCryptoState();
    await db.clear("localKeys");
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
  expect(resetLocalCryptoState).not.toHaveBeenCalled();
  expect(button("Forget keys").disabled).toBe(true);
  await act(async () => button("Forget keys").click());
  expect(resetLocalCryptoState).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLInputElement>('[role="alertdialog"] input[type="checkbox"]')!.click());
  await act(async () => button("Forget keys").click());
  expect(resetLocalCryptoState).toHaveBeenCalledTimes(1);
  expect(useAuthStore.getState().logout).toHaveBeenCalledWith({ forgetDevice: true });
  expect(pathname).toBe("/login");
});
