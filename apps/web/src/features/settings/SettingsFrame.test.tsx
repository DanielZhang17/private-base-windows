import { getByText, queryByText } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore.js";
import { click, setupDom } from "../../ui/test-utils.js";
import { TRANSFER_PATH, TRANSFER_SETUP_PATH } from "../transfer/HistoryTransferScreens.js";
import { SettingsFrame } from "./SettingsFrame.js";
import { resetCaptureGuardForTests } from "./hiddenOptions.js";

vi.mock("../auth/UnlockOffer.js", () => ({ UnlockOffer: () => <p>Unlock faster next time</p> }));
vi.mock("../../services/api.js", () => ({ api: { get: async () => [] } }));

const { render, container } = setupDom();
const initialAuth = useAuthStore.getState();
afterEach(() => act(async () => useAuthStore.setState(initialAuth, true)));

it.each(["/settings", TRANSFER_PATH, TRANSFER_SETUP_PATH])("never shows the unlock offer on %s", async (path) => {
  useAuthStore.setState({ user: { id: "user", username: "user", displayName: "User", avatarUrl: null, createdAt: 1, updatedAt: 1 } });
  const client = new QueryClient();
  function Settings() {
    const navigate = useNavigate();
    return <SettingsFrame title="Linked devices" section="devices" detail={<button onClick={() => navigate("/devices")}>Leave transfer</button>} />;
  }
  await render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Settings /></MemoryRouter></QueryClientProvider>);
  expect(queryByText(container(), "Unlock faster next time")).toBeNull();
  await click(getByText(container(), "Leave transfer"));
  expect(queryByText(container(), "Unlock faster next time")).toBeNull();
});

it.each([
  ["the Android app", "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36", true],
  ["other platforms", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", false],
])("reveals the screenshot switch after seven footer taps on %s only", async (_platform, userAgent, gated) => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { captureProtection: "full" });
  const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  localStorage.removeItem("pb.captureToggleUnlocked");
  resetCaptureGuardForTests();
  try {
    await render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/settings"]}>
      <SettingsFrame title="Settings" detail={null} />
    </MemoryRouter></QueryClientProvider>);
    const footer = getByText(container(), "Private Base");
    for (let i = 0; i < 6; i++) await click(footer);
    expect(queryByText(document.body, "Screenshot setting unlocked. You'll find it in Privacy.")).toBeNull();
    await click(footer);
    expect(!!queryByText(document.body, "Screenshot setting unlocked. You'll find it in Privacy.")).toBe(gated);
    expect(localStorage.getItem("pb.captureToggleUnlocked")).toBe(gated ? "1" : null);
  } finally {
    agent.mockRestore();
    localStorage.removeItem("pb.captureToggleUnlocked");
  }
});

it("lets keyboard users reveal the screenshot switch without announcing a control", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__PRIVATEBASE_NATIVE_CAPABILITIES__", { captureProtection: "full" });
  const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36");
  localStorage.removeItem("pb.captureToggleUnlocked");
  resetCaptureGuardForTests();
  try {
    await render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/settings"]}>
      <SettingsFrame title="Settings" detail={null} />
    </MemoryRouter></QueryClientProvider>);
    const footer = getByText(container(), "Private Base");
    expect(footer.tabIndex).toBe(0);
    expect(footer.getAttribute("role")).toBeNull();
    const key = (init: KeyboardEventInit) => act(async () => { footer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
    for (let i = 0; i < 4; i++) await key({ key: "Enter" });
    await key({ key: "Enter", repeat: true }); // a held key does not count
    for (let i = 0; i < 2; i++) await key({ key: " " });
    expect(localStorage.getItem("pb.captureToggleUnlocked")).toBeNull();
    await key({ key: "Enter" });
    expect(localStorage.getItem("pb.captureToggleUnlocked")).toBe("1");
    expect(queryByText(document.body, "Screenshot setting unlocked. You'll find it in Privacy.")).toBeTruthy();
  } finally {
    agent.mockRestore();
    localStorage.removeItem("pb.captureToggleUnlocked");
  }
});
