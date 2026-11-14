import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RegisterPage from "./RegisterPage.js";
import * as keys from "../lib/key-manager.js";
import { copyText } from "../platform/clipboard.js";
import { api } from "../services/api.js";
import { useAuthStore } from "../stores/authStore.js";
import { setLocalePreference } from "../i18n/index.js";

vi.mock("../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({ register: vi.fn(async () => { store.setState({ accessToken: "new-token" }); }),
    accessToken: null as string | null, user: { id: "alice", username: "alice" }, device: { id: "device" } }));
  return { useAuthStore: store };
});
vi.mock("../lib/key-manager.js", () => ({ initializeKeys: vi.fn(async () => "identity"), hasLocalKeyMaterial: vi.fn(async () => false), setLocalKeyOwner: vi.fn(async () => {}), getLocalKeyOwner: vi.fn(), resetLocalCryptoState: vi.fn(), uploadPreKeyBundle: vi.fn(async () => {}) }));
vi.mock("../lib/device-link.js", () => ({ buildDefaultDeviceName: () => "Browser", generateRecoveryKey: () => "abcd-efgh-ijkl-mnop-qrst-uvwx-yz12-3456" }));
vi.mock("../platform/clipboard.js", () => ({ copyText: vi.fn(async () => {}) }));
vi.mock("../services/api.js", () => ({ api: { post: vi.fn() }, resolveApiUrl: (path: string) => path }));
let root: Root;
let container: HTMLDivElement;
let pathname: string;
function Location() { pathname = useLocation().pathname; return null; }
beforeEach(async () => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useAuthStore.setState({ accessToken: null });
  vi.mocked(keys.hasLocalKeyMaterial).mockResolvedValue(false);
  vi.mocked(keys.uploadPreKeyBundle).mockResolvedValue();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={["/register"]}><RegisterPage /><Location /></MemoryRouter>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const button = (name: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === name)!;
async function fillRegistration() {
  await act(async () => {
    for (const [placeholder, value] of [["Username", "alice"], ["Display Name", "Alice"], ["Min 8 characters", "password"], ["Confirm Password", "password"]]) {
      const input = container.querySelector<HTMLInputElement>(`[placeholder="${placeholder}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}
async function submitRegistration() {
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
}
async function register() {
  await fillRegistration();
  await submitRegistration();
}

async function selectFile(file?: File) {
  await act(async () => button("Choose picture").click());
  await act(async () => button("Upload").click());
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: file ? [file] : [] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

it("previews a file without an account, preserves it on picker cancellation, and allows retry after registration", async () => {
  const createPreview = vi.fn(() => "blob:avatar");
  const revokePreview = vi.fn();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: createPreview, revokeObjectURL: revokePreview }));
  vi.mocked(api.post).mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({ uploadUrl: "/upload" });
  const upload = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ avatarUrl: "r2://avatar" }) });
  vi.stubGlobal("fetch", upload);
  const file = Object.assign(new File(["image"], "avatar.png", { type: "image/png" }), {
    arrayBuffer: async () => new ArrayBuffer(5),
  });
  await fillRegistration();
  await selectFile(file);
  expect(container.querySelector('img[src="blob:avatar"]')).not.toBeNull();
  await selectFile();
  expect(pathname).toBe("/register");
  expect(container.querySelector<HTMLInputElement>('[placeholder="Username"]')!.value).toBe("alice");
  expect(api.post).not.toHaveBeenCalled();
  expect(useAuthStore.getState().register).not.toHaveBeenCalled();

  await submitRegistration();
  expect(useAuthStore.getState().register).toHaveBeenCalledWith("alice", "Alice", "password", expect.any(String), "Browser", "identity", null);
  expect(container.textContent).toContain("Save Your Recovery Key");
  expect(container.textContent).toContain("Failed to upload avatar");
  await act(async () => button("Retry").click());
  expect(upload).toHaveBeenCalledWith("/upload", expect.objectContaining({
    method: "PUT", headers: { Authorization: "Bearer new-token", "Content-Type": "image/png" },
  }));
  expect(useAuthStore.getState().user?.avatarUrl).toBe("r2://avatar");
  expect(revokePreview).toHaveBeenCalledWith("blob:avatar");
  expect(button("Retry")).toBeUndefined();
});

it("displays and searches official localized names while submitting the same avatar slug", async () => {
  await fillRegistration();
  await act(async () => button("Choose picture").click());
  try {
    await act(async () => setLocalePreference("zh-Hans"));
    const search = container.querySelector<HTMLInputElement>('input[placeholder*="角色"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "amber");
    await act(async () => search.dispatchEvent(new Event("input", { bubbles: true })));
    expect(container.querySelectorAll('button[aria-pressed]')).toHaveLength(4);
    await act(async () => button("安柏").click());
  } finally {
    await act(async () => setLocalePreference("en"));
  }
  await submitRegistration();
  expect(useAuthStore.getState().register).toHaveBeenCalledWith("alice", "Alice", "password", expect.any(String), "Browser", "identity", "genshin://amber");
});

it("shows recovery as an unskippable step, copies via the adapter, and requires acknowledgement", async () => {
  await register();
  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).toContain("Save Your Recovery Key");
  expect(container.querySelector(".mockup-code code")?.textContent).toBe("abcd-efgh-ijkl-mnop-qrst-uvwx-yz12-3456");
  expect(button("Continue").disabled).toBe(true);
  await act(async () => { button("Continue").click(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(pathname).toBe("/register");
  expect(container.textContent).toContain("Save Your Recovery Key");
  await act(async () => button("Copy").click());
  expect(copyText).toHaveBeenCalledExactlyOnceWith("abcd-efgh-ijkl-mnop-qrst-uvwx-yz12-3456");
  expect(document.body.textContent).toContain("Recovery key copied");
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button("Continue").disabled).toBe(false);
  await act(async () => button("Continue").click());
  expect(pathname).toBe("/");
});

it("keeps recovery visible with an upload warning after all three upload attempts fail", async () => {
  vi.mocked(keys.uploadPreKeyBundle).mockRejectedValue(new Error("Offline"));
  await register();
  expect(keys.uploadPreKeyBundle).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain("Your device keys will finish uploading automatically");
  expect(container.textContent).toContain("Save Your Recovery Key");
  expect(keys.resetLocalCryptoState).not.toHaveBeenCalled();
  expect(button("Continue").disabled).toBe(true);
});

it("keeps the registration owner guard ahead of key generation", async () => {
  vi.mocked(keys.hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keys.getLocalKeyOwner).mockResolvedValue({ userId: "bob", username: "bob", deviceId: "bob-device" });
  await register();
  expect(container.textContent).toContain("This browser already holds encryption keys");
  expect(keys.initializeKeys).not.toHaveBeenCalled();
  expect(keys.resetLocalCryptoState).not.toHaveBeenCalled();
});
