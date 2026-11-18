import { afterEach, expect, it, vi } from "vitest";
import { endRevokedDeviceSession } from "./device-session.js";
import { navigate } from "../platform/navigation.js";
import { clearAccountScopedState } from "../platform/session.js";

const { logout } = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock("../platform/navigation.js", () => ({ navigate: vi.fn() }));
vi.mock("../platform/session.js", () => ({ clearAccountScopedState: vi.fn() }));
vi.mock("../stores/authStore.js", () => ({ useAuthStore: {
  getState: () => ({ sessionId: "old-login", user: { id: "alice" }, device: { id: "old-device" }, accessToken: "old-token", logout }),
} }));

afterEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("e2ee-auth");
});

it.each([["new-login", "new-device"], ["new-login", "old-device"], ["old-login", "new-device"]])(
  "preserves persisted login %s on %s before the storage event arrives",
  (sessionId, deviceId) => {
    const persisted = JSON.stringify({ state: { sessionId, device: { id: deviceId }, user: { id: "alice" }, accessToken: "new-token" } });
    localStorage.setItem("e2ee-auth", persisted);
    endRevokedDeviceSession();
    expect(logout).not.toHaveBeenCalled();
    expect(clearAccountScopedState).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(localStorage.getItem("e2ee-auth")).toBe(persisted);
  },
);

it("logs out the revoked login when persisted identity still matches, even after token rotation", () => {
  localStorage.setItem("e2ee-auth", JSON.stringify({
    state: { sessionId: "old-login", user: { id: "alice" }, device: { id: "old-device" }, accessToken: "rotated-token" },
  }));
  endRevokedDeviceSession("Laptop");
  expect(logout).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledExactlyOnceWith("/session-ended", { replace: true, state: { replacementDeviceName: "Laptop" } });
});
