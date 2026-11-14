import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRegisterFlow } from "./useRegisterFlow.js";
import { initializeKeys, uploadPreKeyBundle } from "../../lib/key-manager.js";
import { copyText } from "../../platform/clipboard.js";
vi.mock("../../platform/clipboard.js", () => ({ copyText: vi.fn(async () => {}) }));
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ register: vi.fn(async () => {}), user: { id: "alice", username: "alice" }, device: { id: "device" } })) };
});

vi.mock("../../lib/key-manager.js", () => ({ initializeKeys: vi.fn(async () => "identity"), hasLocalKeyMaterial: async () => false, setLocalKeyOwner: async () => {}, getLocalKeyOwner: vi.fn(), resetLocalCryptoState: vi.fn(), uploadPreKeyBundle: vi.fn() }));
vi.mock("../../lib/device-link.js", () => ({ buildDefaultDeviceName: () => "Browser", generateRecoveryKey: () => "recovery" }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("prevents duplicate key generation and cancels registration upload timers on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  let state!: ReturnType<typeof useRegisterFlow>;
  function Probe() { state = useRegisterFlow(); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  await act(async () => { state.setPassword("password"); state.setConfirmPassword("password"); });
  let pending!: Promise<void>;
  await act(async () => {
    pending = state.handleSubmit({ preventDefault() {} } as React.FormEvent);
    void state.handleSubmit({ preventDefault() {} } as React.FormEvent);
  });
  expect(initializeKeys).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root.unmount());
  await pending;
  expect(vi.getTimerCount()).toBe(0);
  expect(uploadPreKeyBundle).not.toHaveBeenCalled();
});

it("copies the generated recovery key through the platform adapter", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  vi.mocked(uploadPreKeyBundle).mockResolvedValueOnce(undefined);
  let state!: ReturnType<typeof useRegisterFlow>;
  function Probe() { state = useRegisterFlow(); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<MemoryRouter><Probe /></MemoryRouter>));
  await act(async () => { state.setPassword("password"); state.setConfirmPassword("password"); });
  let pending!: Promise<void>;
  await act(async () => { pending = state.handleSubmit({ preventDefault() {} } as React.FormEvent); });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); await pending; });
  await act(async () => state.copyRecoveryKey());
  expect(copyText).toHaveBeenCalledExactlyOnceWith("recovery");
  await act(async () => root.unmount());
});
