import { beforeEach, expect, it, vi } from "vitest";
import { useAuthPhase } from "./useAppPhase.js";
import { updatePendingSetupRecord, readPendingSetupRecord } from "../../db/index.js";
import { getLocalKeyOwner, hasLocalKeyMaterial, keysLoaded } from "../../lib/key-manager.js";
import { useAuthStore } from "../../stores/authStore.js";
import { setupDom } from "../../ui/test-utils.js";

vi.mock("../../components/app/useKeyMaintenance.js", () => ({ useKeyMaintenance: vi.fn() }));
vi.mock("../../lib/key-manager.js", () => ({
  getLocalKeyOwner: vi.fn(), hasLocalKeyMaterial: vi.fn(), keysLoaded: vi.fn(), onKeysLocked: vi.fn(),
  retryNativeKeyCleanup: vi.fn(),
}));
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ accessToken: null, device: null, authEpoch: 0 })) };
});

const { render, container } = setupDom();
function Probe() { return <output>{useAuthPhase()}</output>; }
const checkpoint = { id: "setup:pending" as const, setupId: "setup", deviceId: "new-device", bundleHash: "digest", createdAt: 10 };

beforeEach(async () => {
  await updatePendingSetupRecord(undefined, await readPendingSetupRecord());
  useAuthStore.setState({ accessToken: "old-token", device: { id: "old-device" } } as never);
  vi.mocked(getLocalKeyOwner).mockResolvedValue({ deviceId: "new-device", userId: "new-user", username: "sam" });
  vi.mocked(hasLocalKeyMaterial).mockResolvedValue(true);
  vi.mocked(keysLoaded).mockReturnValue(false);
});

it.each(["unlockReady", "complete"] as const)("leaves the %s setup available to Login after a reload with an old token", async stage => {
  await updatePendingSetupRecord({ ...checkpoint, stage });
  await render(<Probe />);
  await vi.waitFor(() => expect(container().textContent).toBe("anonymous"));
});

it("opens ordinary unlock after the completed vault's own session has been applied", async () => {
  await updatePendingSetupRecord({ ...checkpoint, stage: "complete" });
  useAuthStore.setState({ accessToken: "new-token", device: { id: "new-device" } } as never);
  await render(<Probe />);
  await vi.waitFor(() => expect(container().textContent).toBe("locked"));
});

it("rejects an old session paired with loaded keys from a different vault", async () => {
  vi.mocked(keysLoaded).mockReturnValue(true);
  await render(<Probe />);
  await vi.waitFor(() => expect(container().textContent).toBe("anonymous"));
});
