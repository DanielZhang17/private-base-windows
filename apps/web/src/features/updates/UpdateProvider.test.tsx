import { getByRole, queryByRole } from "@testing-library/dom";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { setupDom, click } from "../../ui/test-utils.js";
import { capabilities } from "../../platform/capabilities.js";
import { updates } from "../../platform/updates.js";
import { clearAccountScopedState } from "../../platform/session.js";
import { useAuthStore } from "../../stores/authStore.js";
import { UpdateProvider } from "./UpdateProvider.js";
import { UpdateBanner } from "./UpdateBanner.js";
import { AboutUpdates } from "./AboutUpdates.js";
import { UPDATE_CHANNEL_KEY } from "./useUpdates.js";
vi.mock("../calls/CallContext.js", () => ({ useCall: () => ({ stage: "ended" }) }));
vi.mock("../../platform/session.js", () => ({ clearAccountScopedState: vi.fn() }));
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create<{ user: { id: string } | null; logout: () => void }>(set => ({
    user: null, logout: vi.fn(() => set({ user: null })),
  })) };
});
vi.mock("../../platform/updates.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../platform/updates.js")>(),
  updates: { getVersion: vi.fn(), check: vi.fn(), download: vi.fn(), install: vi.fn(), onProgress: vi.fn(), openPermissionSettings: vi.fn() },
}));
const { render } = setupDom();
const show = (path = "/settings?section=about") => render(<MemoryRouter initialEntries={[path]}><UpdateProvider>
  <Routes>
    <Route path="/" element={<UpdateBanner />} />
    <Route path="/settings" element={<AboutUpdates />} />
    <Route path="*" element={null} />
  </Routes>
</UpdateProvider></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks(); localStorage.removeItem(UPDATE_CHANNEL_KEY);
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("desktop");
  vi.mocked(updates.getVersion).mockResolvedValue("0.1.0");
  vi.mocked(updates.check).mockResolvedValue({ available: true, version: "0.1.1" });
  vi.mocked(updates.download).mockResolvedValue();
  vi.mocked(updates.onProgress).mockResolvedValue(vi.fn());
  useAuthStore.setState({ user: null });
});
afterEach(() => { vi.restoreAllMocks(); });
it("checks while signed out and keeps About controls the same size without a banner", async () => {
  await show(); expect(updates.check).toHaveBeenCalledWith("stable");
  expect(document.body.textContent).toContain("Current version: 0.1.0");
  expect(document.body.textContent).toContain("Update ready — restart to update");
  expect(queryByRole(document.body, "status", { name: "App update" })).toBeNull();
  const check = getByRole(document.body, "button", { name: "Check for updates" });
  const restart = getByRole(document.body, "button", { name: "Restart to update" });
  for (const control of [check, restart]) {
    expect(control.className).toContain("min-h-11");
    expect(control.className).toContain("text-[0.9375rem]");
  }
  expect(getByRole<HTMLSelectElement>(document.body, "combobox").disabled).toBe(true);
});
it("requires installation or sign-out and reopens after a new sign-in", async () => {
  useAuthStore.setState({ user: { id: "user" } } as never);
  vi.mocked(updates.check).mockResolvedValue({ available: true, mandatory: true, version: "0.1.1" });
  await show();
  const dialog = getByRole(document.body, "dialog", { name: "Update required" });
  expect(queryByRole(dialog, "button", { name: "Later" })).toBeNull();
  expect(queryByRole(dialog, "button", { name: "Close" })).toBeNull();
  await click(getByRole(dialog, "button", { name: "Sign out" }));
  expect(clearAccountScopedState).toHaveBeenCalledOnce(); expect(useAuthStore.getState().logout).toHaveBeenCalledOnce();
  expect(queryByRole(document.body, "dialog")).toBeNull();
  await act(async () => useAuthStore.setState({ user: { id: "new-user" } } as never));
  expect(getByRole(document.body, "dialog", { name: "Update required" })).toBeTruthy();
});
it("leaves browser UI and commands unchanged", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue(undefined);
  await show(); expect(document.body.textContent).toBe(""); expect(updates.check).not.toHaveBeenCalled();
});
it("asks before downloading on an unknown Android connection", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("android");
  await show(); expect(updates.download).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("An unmetered connection could not be confirmed.");
  const actions = document.querySelectorAll('button');
  const download = Array.from(actions).find(button => button.textContent === "Download update")!;
  await click(download); expect(updates.download).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Update ready — install");
});

it("shows compact stacked banner content and Later hides only that banner", async () => {
  await show("/");
  const banner = getByRole(document.body, "status", { name: "App update" });
  expect(banner.querySelector("p")?.textContent).toBe("Update ready");
  expect(banner.querySelector("p")?.className).toContain("truncate");
  const actions = banner.querySelector("button")?.parentElement;
  expect(actions?.className).toContain("flex");
  expect(actions?.className).toContain("justify-end");
  expect(Array.from(actions!.querySelectorAll("button")).map(button => button.textContent)).toEqual(["Later", "Restart to update"]);
  expect(banner.parentElement?.className).toContain("sm:order-last");
  expect(banner.parentElement?.className).not.toMatch(/fixed|absolute/);
  await click(getByRole(banner, "button", { name: "Later" }));
  expect(queryByRole(document.body, "status", { name: "App update" })).toBeNull();
  expect(updates.download).toHaveBeenCalledOnce();
});
it.each(["/settings", "/settings/profile", "/settings?section=about", "/clients", "/call/existing"])("never renders the banner on %s even with a ready update", async path => {
  await show(path);
  expect(queryByRole(document.body, "status", { name: "App update" })).toBeNull();
});
it("discloses release notes without an indented summary or duplicated visible notes", async () => {
  vi.mocked(updates.check).mockResolvedValue({ available: true, version: "0.1.1", notes: "Release fixes" });
  await show();
  const details = document.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")?.textContent).toBe("Release notes");
  expect(details.querySelector("summary")?.className).not.toMatch(/px-|ps-/);
  expect(details.querySelector("p")?.textContent).toBe("Release fixes");
  const link = getByRole<HTMLAnchorElement>(details, "link", { name: "View release page", hidden: true });
  expect(link.getAttribute("href")).toBe("https://chat.718788.xyz/clients");
  expect(link.className).not.toMatch(/px-|ps-/);
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  expect(details.open).toBe(true);
});

it.each([
  [15900000, undefined, "15.9 MB · Your network may be metered"],
  [undefined, undefined, "Your network may be metered"],
  [15900000, { type: "cellular", metered: true }, "15.9 MB · Your network may be metered"],
  [15900000, { type: "wifi" }, "15.9 MB"],
  [15900000, { metered: false, saveData: true }, "15.9 MB"],
  [undefined, { type: "wifi" }, undefined],
] as const)("shows the Android available summary for size %s and connection %j", async (sizeBytes, connection, expected) => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("android");
  vi.stubGlobal("navigator", { connection: undefined });
  vi.mocked(updates.check).mockResolvedValue({ available: true, version: "0.1.1", sizeBytes });
  await show("/");
  // The connection can change after a check has offered a manual download.
  vi.stubGlobal("navigator", { connection });
  await show("/");
  const banner = getByRole(document.body, "status", { name: "App update" });
  expect(banner.querySelector("p")?.textContent).toBe("Update 0.1.1 available");
  const secondary = banner.querySelectorAll("p")[1];
  expect(secondary?.textContent).toBe(expected);
  if (secondary) {
    expect(secondary.className).toContain("truncate");
    expect(secondary.getAttribute("title")).toBe(expected);
  }
  expect(updates.download).not.toHaveBeenCalled();
});
