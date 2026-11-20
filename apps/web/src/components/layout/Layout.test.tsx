import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getByRole, queryByRole } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { capabilities } from "../../platform/capabilities.js";
import { HistoryTransferScreen } from "../../features/transfer/HistoryTransferScreens.js";
import * as transfer from "../../features/transfer/useHistoryTransfer.js";
import { ToastProvider } from "../../ui/index.js";
import Layout from "./Layout.js";
import { useUnlockOfferHeld } from "../../features/auth/unlockOfferGate.js";
vi.mock("../../features/chat/useOutgoingQueue.js", () => ({ useOutgoingQueue: vi.fn() }));
vi.mock("../../features/chat/useShell.js", () => ({ useShell: () => ({ user: null, isOnline: false, unread: 2 }) }));
// These layout tests cover the shell, not history transfer (on by default since 2026-11-19).
vi.mock("../../features/transfer/flag.js", () => ({ historyTransferEnabled: false }));
vi.mock("../../pages/ChatListPage.js", () => ({ default: () => <h1>Chats</h1> }));
vi.mock("../calls/IncomingCallModal.js", () => ({ default: () => null }));
let root: Root; let container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it("mounts one list and one route surface in the responsive shell", async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={["/chat/mara"]}><Routes><Route element={<Layout />}><Route path="chat/:conversationId" element={<div data-testid="conversation">Conversation</div>} /></Route></Routes></MemoryRouter>));
  expect(container.querySelectorAll("h1")).toHaveLength(1);
  expect(container.querySelectorAll('[data-testid="conversation"]')).toHaveLength(1);
  expect(container.querySelectorAll("aside")).toHaveLength(1);
  expect(container.querySelectorAll("main")).toHaveLength(1);
  expect(container.textContent).toContain("You are offline. Messages will send when you reconnect.");
  expect(container.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(1);
  expect(document.documentElement.hasAttribute("data-titlebar")).toBe(false);
});

it("emphasizes the setup receipt's device name and keeps Dismiss usable on narrow screens", async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: "/", state: {
    passkeySetup: { id: "new", deviceName: "Chrome on macOS", activatedAt: Date.now() },
  } }]}><Layout /></MemoryRouter>));
  const dismiss = getByRole(container, "button", { name: "Dismiss" });
  const receipt = dismiss.closest('[role="status"]');
  expect(receipt?.querySelector("strong")?.textContent).toBe("Chrome on macOS");
  expect(receipt?.textContent).toContain("Signed in");
  expect(dismiss.className.split(" ")).toEqual(expect.arrayContaining(["min-h-11", "min-w-11", "shrink-0"]));
  expect(dismiss.parentElement?.className).toContain("flex-wrap");
  await act(async () => dismiss.click());
  expect(queryByRole(container, "button", { name: "Dismiss" })).toBeNull();
});

it("holds the unlock offer while the setup receipt is shown", async () => {
  let held: boolean | undefined;
  function Probe() { held = useUnlockOfferHeld(); return null; }
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: "/", state: {
    passkeySetup: { id: "new", deviceName: "Chrome on macOS", activatedAt: Date.now() },
  } }]}><Layout /><Probe /></MemoryRouter>));
  expect(held).toBe(true);
  await act(async () => getByRole(container, "button", { name: "Dismiss" }).click());
  expect(held).toBe(false);
});

it("opens the receive entry from setup step 2 and returns to the setup receipt", async () => {
  const previous = capabilities.historyTransfer;
  capabilities.historyTransfer = true;
  const startAsReceiver = vi.fn(async () => undefined);
  const flow = vi.spyOn(transfer, "useHistoryTransfer").mockReturnValue({
    phase: "idle", startAsReceiver, dismiss: vi.fn(), stop: vi.fn(),
  } as unknown as ReturnType<typeof transfer.useHistoryTransfer>);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } } });
  const receipt = { id: "new", deviceName: "New phone", activatedAt: Date.now() };
  client.setQueryData(["myDevices"], [receipt, { id: "old", deviceName: "Old phone", platform: "web", lastSeenAt: Date.now() }]);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: "/", state: { passkeySetup: receipt } }]}><Routes>
        <Route path="/" element={<Layout />} />
        <Route path="/setup/history-transfer" element={<ToastProvider><HistoryTransferScreen setup /></ToastProvider>} />
      </Routes></MemoryRouter>
    </QueryClientProvider>));
    expect(container.textContent).toContain("Step 2 of 2");
    await act(async () => getByRole<HTMLButtonElement>(container, "button", { name: "Transfer history" }).click());
    expect(startAsReceiver).toHaveBeenCalledOnce();
    await act(async () => getByRole<HTMLButtonElement>(container, "button", { name: "Cancel" }).click());
    expect(getByRole(container, "button", { name: "Dismiss" }).closest('[role="status"]')?.textContent).toContain(receipt.deviceName);
    expect(container.textContent).not.toContain("Step 2 of 2");
  } finally {
    flow.mockRestore();
    capabilities.historyTransfer = previous;
  }
});
