import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSafetyNumber } from "./useSafetyNumber.js";
import { api } from "../../services/api.js";
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn() } }));
vi.mock("../../lib/key-manager.js", () => ({ getIdentityKeyPair: () => ({ publicEd25519: new Uint8Array([1]) }) }));
vi.mock("@e2ee-chat/crypto", () => ({ fromBase64Url: () => new Uint8Array([2]), generateSafetyNumber: async () => "number", formatSafetyNumber: (value: string) => value }));
vi.mock("../../stores/authStore.js", () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: "sam", displayName: "Sam" } }) }));
const entries = new Map<string, string>();
const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
let root: Root;
let state: ReturnType<typeof useSafetyNumber>;
function Probe() { state = useSafetyNumber(); return null; }
beforeEach(() => { entries.clear(); Object.defineProperty(window, "localStorage", { value: storage, configurable: true }); vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); root = createRoot(document.createElement("div")); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => root.render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={["/verify/bob"]}>
      <Routes>
        <Route path="/verify/:userId" element={<Probe />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}
it("reports an empty remote device list instead of loading forever", async () => {
  vi.mocked(api.get).mockImplementation(async (path) => (path.includes("/devices/") ? [] : { id: "bob" }) as never);
  await render();
  expect(state.safetyNumber).toBeNull();
  expect(state.error).toBe("No active device found for this user");
});
it("reports device lookup failures", async () => {
  vi.mocked(api.get).mockRejectedValue(new Error("Device unavailable"));
  await render();
  expect(state.error).toBe("Something went wrong. Please try again.\nDevice unavailable");
});

it("persists verification only for this account and contact and can remove it", async () => {
  vi.mocked(api.get).mockImplementation(async (path) => (path.includes("/devices/") ? [{ id: "device", identityKey: "public" }] : { id: "bob", displayName: "Bob" }) as never);
  await render();
  expect(state.verified).toBe(false);
  await act(async () => { expect(state.toggleVerification()).toBe(true); });
  expect(state.verified).toBe(true);
  expect(window.localStorage.getItem("private-base-verification:sam:bob")).toBe("number");
  expect(window.localStorage.getItem("private-base-verification:other:bob")).toBeNull();
  await act(async () => { state.toggleVerification(); });
  expect(state.verified).toBe(false);
  expect(window.localStorage.getItem("private-base-verification:sam:bob")).toBeNull();
});
it("flags a changed number rather than carrying verification to a new identity", async () => {
  window.localStorage.setItem("private-base-verification:sam:bob", "old-number");
  vi.mocked(api.get).mockImplementation(async (path) => (path.includes("/devices/") ? [{ id: "device", identityKey: "new-public" }] : { id: "bob" }) as never);
  await render(); expect(state.verified).toBe(false); expect(state.verificationChanged).toBe(true);
});
