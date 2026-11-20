import { fireEvent, getByRole, queryAllByRole, queryByRole } from "@testing-library/dom";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { setupDom, click } from "../../ui/test-utils.js";
import { capabilities } from "../../platform/capabilities.js";
import { type UpdateChannel, uiBundles, UiRestartError, updates } from "../../platform/updates.js";
import { clearAccountScopedState } from "../../platform/session.js";
import { useAuthStore } from "../../stores/authStore.js";
import { UpdateProvider } from "./UpdateProvider.js";
import { UpdateBanner } from "./UpdateBanner.js";
import { AboutUpdates, PENDING_POLL_MS } from "./AboutUpdates.js";
import { UPDATE_CHANNEL_KEY } from "./useUpdates.js";
import { ToastProvider } from "../../ui/index.js";
const live = vi.hoisted(() => ({ callStage: "ended", transferPhase: "idle", stopTransfer: (() => {}) as () => void }));
vi.mock("../calls/CallContext.js", () => ({ useCall: () => ({ stage: live.callStage }) }));
vi.mock("../transfer/useHistoryTransfer.js", () => ({ useHistoryTransfer: () => ({ phase: live.transferPhase, stop: live.stopTransfer }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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
const show = (path = "/settings?section=about") => render(<ToastProvider><MemoryRouter initialEntries={[path]}><UpdateProvider>
  <Routes>
    <Route path="/" element={<UpdateBanner />} />
    <Route path="/settings" element={<AboutUpdates />} />
    <Route path="*" element={null} />
  </Routes>
</UpdateProvider></MemoryRouter></ToastProvider>);
/** Each About row as [label, ...value parts]. */
const versionRows = () => Array.from(document.querySelectorAll("dl > div")).map(row =>
  [row.querySelector("dt")!.textContent!, ...Array.from(row.querySelectorAll("dd > span")).map(part => part.textContent!)]);
beforeEach(() => {
  vi.clearAllMocks(); localStorage.removeItem(UPDATE_CHANNEL_KEY);
  // The native pending query has its own adapter tests; keep invoke assertions about the channel.
  vi.spyOn(uiBundles, "getPending").mockResolvedValue(undefined);
  Object.assign(live, { callStage: "ended", transferPhase: "idle", stopTransfer: vi.fn() });
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("desktop");
  vi.mocked(updates.getVersion).mockResolvedValue("0.1.0");
  vi.mocked(updates.check).mockResolvedValue({ available: true, version: "0.1.1" });
  vi.mocked(updates.download).mockResolvedValue();
  vi.mocked(updates.onProgress).mockResolvedValue(vi.fn());
  useAuthStore.setState({ user: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete window.__PRIVATEBASE_NATIVE_CAPABILITIES__;
  delete window.__PRIVATEBASE_UI_BUNDLE__;
});
it("checks while signed out and keeps About controls the same size without a banner", async () => {
  await show(); expect(updates.check).toHaveBeenCalledWith("stable");
  expect(versionRows()).toEqual([["App version", "0.1.0"]]);
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
it.each([null, "stable"])("checks the saved native channel and locks About in read-only mode with localStorage set to %s", async cached => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: "read-only" };
  window.__PRIVATEBASE_UI_BUNDLE__ = { appVersion: "0.1.3", uiVersion: "1.0.1", uiSource: "ota" };
  vi.mocked(invoke).mockResolvedValueOnce("beta");
  if (cached) localStorage.setItem(UPDATE_CHANNEL_KEY, cached);
  vi.mocked(updates.check).mockResolvedValue({ available: false });
  const persist = vi.spyOn(uiBundles, "setChannel");

  await show();
  const selector = getByRole<HTMLSelectElement>(document.body, "combobox");
  expect(selector.value).toBe("beta");
  expect(selector.disabled).toBe(true);
  expect(versionRows()).toEqual([["App version", "0.1.3"], ["UI bundle version", "1.0.1", "Updated"]]);
  expect(uiBundles.getActive()?.uiSource).toBe("ota");
  await act(async () => { fireEvent.change(selector, { target: { value: "stable" } }); });
  expect(persist).not.toHaveBeenCalled();
  expect(localStorage.getItem(UPDATE_CHANNEL_KEY)).toBe(cached);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("ui_bundle_get_channel");
  expect(updates.check).toHaveBeenCalledExactlyOnceWith("beta");
  await expect(uiBundles.setChannel("stable")).rejects.toMatchObject({ code: "failed" });
});
it("waits for the current native channel before the first full-updater check after a document reload", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true };
  vi.mocked(updates.check).mockResolvedValue({ available: false });
  let saved: UpdateChannel = "stable";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "ui_bundle_set_channel") saved = (args as { channel: UpdateChannel }).channel;
    return (command === "ui_bundle_get_channel" ? saved : undefined) as never;
  });
  await show();
  expect(updates.check).toHaveBeenCalledExactlyOnceWith("stable");
  const selector = () => getByRole<HTMLSelectElement>(document.body, "combobox");
  await act(async () => { fireEvent.change(selector(), { target: { value: "beta" } }); });
  expect(saved).toBe("beta");
  await render(null);

  localStorage.setItem(UPDATE_CHANNEL_KEY, "stable");
  vi.mocked(updates.check).mockClear();
  let finish!: () => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(saved as never); }));
  await show();
  expect(selector().disabled).toBe(true);
  expect(updates.check).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(selector().value).toBe("beta");
  expect(updates.check).toHaveBeenCalledExactlyOnceWith("beta");
  expect(invoke).toHaveBeenLastCalledWith("ui_bundle_get_channel");
});
it("lets OTA-only shells switch channels and retry failed saves without exposing the full updater", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue(undefined);
  vi.spyOn(capabilities, "otaUi", "get").mockReturnValue(true);
  vi.spyOn(uiBundles, "getActive").mockReturnValue({ appVersion: "0.1.3", uiVersion: "1.0.0", uiSource: "embedded" });
  const persist = vi.spyOn(uiBundles, "setChannel")
    .mockRejectedValueOnce(new Error("save failed"))
    .mockResolvedValue(undefined);
  await show();
  const selector = getByRole<HTMLSelectElement>(document.body, "combobox");
  expect(selector.value).toBe("stable");
  expect(selector.disabled).toBe(false);
  expect(versionRows()).toEqual([["App version", "0.1.3"], ["UI bundle version", "1.0.0", "Built-in"]]);
  expect(queryByRole(document.body, "button", { name: "Check for updates" })).toBeNull();
  expect(queryByRole(document.body, "status")).toBeNull();

  await act(async () => { fireEvent.change(selector, { target: { value: "beta" } }); });
  expect(selector.value).toBe("stable");
  expect(getByRole(document.body, "alert")).toBeTruthy();
  await act(async () => { fireEvent.change(selector, { target: { value: "beta" } }); });
  expect(selector.value).toBe("beta");
  expect(localStorage.getItem(UPDATE_CHANNEL_KEY)).toBe("beta");
  expect(queryByRole(document.body, "alert")).toBeNull();
  await act(async () => { fireEvent.change(selector, { target: { value: "stable" } }); });
  expect(selector.value).toBe("stable");
  expect(persist.mock.calls).toEqual([["beta"], ["beta"], ["stable"]]);
  expect(updates.check).not.toHaveBeenCalled();
  expect(updates.download).not.toHaveBeenCalled();
  expect(updates.install).not.toHaveBeenCalled();
});
it("asks before downloading on an unknown Android connection", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true };
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("android");
  await show(); expect(updates.download).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("ui_bundle_get_channel");
  expect(document.body.textContent).toContain("An unmetered connection could not be confirmed.");
  const actions = document.querySelectorAll('button');
  const download = Array.from(actions).find(button => button.textContent === "Download update")!;
  await click(download); expect(updates.download).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Update ready — install");
});

it.each([false, true, null, "error"] as const)("uses Android metering when available and keeps the legacy safeguard otherwise (%s)", async unmetered => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("navigator", { connection: { type: "wifi" } });
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true };
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("android");
  vi.mocked(invoke).mockImplementation(async command => {
    if (command !== "ui_bundle_is_unmetered") return "stable" as never;
    if (unmetered === "error") throw new Error("network state unavailable");
    return unmetered as never;
  });
  await show("/");
  expect(invoke).toHaveBeenLastCalledWith("ui_bundle_is_unmetered");
  expect(updates.download).toHaveBeenCalledTimes(unmetered === false ? 0 : 1);
  if (unmetered === false) {
    const banner = getByRole(document.body, "status", { name: "App update" });
    expect(banner.textContent).toContain("Your network may be metered");
    await click(getByRole(document.body, "button", { name: "Download update" }));
    expect(updates.download).toHaveBeenCalledOnce();
  }
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

function nativeShell(bundle: { uiVersion: string; uiSource: "embedded" | "ota" }) {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true };
  window.__PRIVATEBASE_UI_BUNDLE__ = { appVersion: "0.1.3", ...bundle };
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue(undefined);
  vi.mocked(invoke).mockResolvedValue("stable");
}
const MOBILE_NOTICE = "A UI update is ready. It will be applied after you fully close and reopen Private Base.";
const DESKTOP_NOTICE = "A UI update is ready. It will be applied the next time you open Private Base.";
const pendingNotice = () => queryAllByRole(document.body, "status")
  .find(status => status.textContent?.startsWith(MOBILE_NOTICE) || status.textContent?.startsWith(DESKTOP_NOTICE)) ?? null;
it.each([
  ["embedded", "1.0.0", "Built-in"],
  ["ota", "1.0.4", "Updated"],
] as const)("shows separate app and %s UI bundle version rows", async (uiSource, uiVersion, qualifier) => {
  nativeShell({ uiVersion, uiSource });
  await show();
  expect(versionRows()).toEqual([["App version", "0.1.3"], ["UI bundle version", uiVersion, qualifier]]);
  const parts = document.querySelectorAll("dl > div:last-child dd > span");
  expect(parts[1].className).toContain("text-ink-muted");
  expect(document.body.textContent).not.toContain("Current version");
});
it("reflects a rollback to the built-in UI on the next launch", async () => {
  nativeShell({ uiVersion: "1.0.4", uiSource: "ota" });
  await show();
  expect(versionRows()[1]).toEqual(["UI bundle version", "1.0.4", "Updated"]);
  await render(null);
  // The shell rolled back an unacknowledged trial and relaunched on the embedded bundle.
  window.__PRIVATEBASE_UI_BUNDLE__ = { appVersion: "0.1.3", uiVersion: "1.0.0", uiSource: "embedded" };
  await show();
  expect(versionRows()).toEqual([["App version", "0.1.3"], ["UI bundle version", "1.0.0", "Built-in"]]);
});
it("shows only the app version row on desktop shells without OTA UI support", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  window.__PRIVATEBASE_UI_BUNDLE__ = { appVersion: "0.1.3", uiVersion: "1.0.4", uiSource: "ota" };
  vi.mocked(updates.check).mockResolvedValue({ available: false });
  await show();
  expect(versionRows()).toEqual([["App version", "0.1.0"]]);
  expect(uiBundles.getPending).toHaveBeenCalled();
  expect(pendingNotice()).toBeNull();
});
it("keeps the web build free of About content", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue(undefined);
  vi.mocked(uiBundles.getPending).mockResolvedValue("1.0.4");
  await show();
  expect(document.querySelector("dl")).toBeNull();
  expect(document.body.textContent).toBe("");
});
it("shows a calm next-launch notice for a staged UI bundle without a restart action", async () => {
  nativeShell({ uiVersion: "1.0.0", uiSource: "embedded" });
  vi.mocked(uiBundles.getPending).mockResolvedValue("1.0.4");
  await show();
  const notice = pendingNotice()!;
  expect(notice).toBeTruthy();
  expect(notice.getAttribute("role")).toBe("status");
  expect(queryByRole(document.body, "alert")).toBeNull();
  expect(queryByRole(document.body, "dialog")).toBeNull();
  // The shell exposes no relaunch command to the web app, so there is nothing to press.
  expect(queryByRole(notice, "button")).toBeNull();
  expect(Array.from(document.querySelectorAll("button")).filter(button => /restart/i.test(button.textContent ?? ""))).toEqual([]);
  expect(versionRows()[1]).toEqual(["UI bundle version", "1.0.0", "Built-in"]);
});
it("hides the next-launch notice when nothing is staged and never shows it outside About", async () => {
  nativeShell({ uiVersion: "1.0.4", uiSource: "ota" });
  await show();
  expect(pendingNotice()).toBeNull();
  await render(null);
  vi.mocked(uiBundles.getPending).mockResolvedValue("1.0.5");
  await show("/");
  expect(document.body.textContent).toBe("");
});
it("drops the next-launch notice after a saved channel change withdraws the staged bundle", async () => {
  nativeShell({ uiVersion: "1.0.0", uiSource: "embedded" });
  const persist = vi.spyOn(uiBundles, "setChannel").mockRejectedValueOnce(new Error("save failed")).mockResolvedValue(undefined);
  let staged: string | undefined = "1.0.4";
  vi.mocked(uiBundles.getPending).mockImplementation(async () => staged);
  await show();
  expect(pendingNotice()).toBeTruthy();
  const selector = getByRole<HTMLSelectElement>(document.body, "combobox");
  const reads = vi.mocked(uiBundles.getPending).mock.calls.length;
  // A failed save leaves native state, and so the notice, unchanged.
  await act(async () => { fireEvent.change(selector, { target: { value: "beta" } }); });
  expect(vi.mocked(uiBundles.getPending).mock.calls.length).toBe(reads);
  expect(pendingNotice()).toBeTruthy();
  staged = undefined; // ui_bundle_set_channel clears the staged bundle synchronously.
  await act(async () => { fireEvent.change(selector, { target: { value: "beta" } }); });
  expect(persist).toHaveBeenLastCalledWith("beta");
  expect(selector.value).toBe("beta");
  expect(vi.mocked(uiBundles.getPending).mock.calls.length).toBe(reads + 1);
  expect(pendingNotice()).toBeNull();
});

it.each([
  ["Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36", MOBILE_NOTICE],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", MOBILE_NOTICE],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)", DESKTOP_NOTICE],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", DESKTOP_NOTICE],
])("words the notice for the platform (%s)", async (userAgent, text) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  nativeShell({ uiVersion: "1.0.0", uiSource: "embedded" });
  vi.mocked(uiBundles.getPending).mockResolvedValue("1.0.4");
  await show();
  expect(pendingNotice()?.textContent).toBe(text);
});

function restartShell(pendingVersion: string | undefined = "1.0.4") {
  nativeShell({ uiVersion: "1.0.0", uiSource: "embedded" });
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: true, otaUiRestart: true };
  vi.mocked(uiBundles.getPending).mockResolvedValue(pendingVersion);
  return vi.spyOn(uiBundles, "restart").mockResolvedValue(undefined);
}
const restartButton = () => queryByRole<HTMLButtonElement>(document.body, "button", { name: "Restart now" });
it.each([
  [{ otaUi: true }, "1.0.4", false],
  [{ otaUi: true, otaUiRestart: true }, undefined, false],
  [{ otaUi: "read-only", otaUiRestart: true }, "1.0.4", false],
  [{ otaUi: true, otaUiRestart: true }, "1.0.4", true],
] as const)("offers Restart now only with otaUiRestart and a staged bundle (%j, pending %s)", async (flags, pendingVersion, offered) => {
  restartShell();
  vi.mocked(uiBundles.getPending).mockResolvedValue(pendingVersion);
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { ...flags };
  await show();
  expect(!!restartButton()).toBe(offered);
  if (offered) expect(pendingNotice()!.contains(restartButton())).toBe(true);
});
it("restarts straight away when nothing would be interrupted", async () => {
  const restart = restartShell();
  await show();
  await click(restartButton()!);
  expect(restart).toHaveBeenCalledOnce();
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
});
it("asks first during a call and restarts only on confirmation", async () => {
  live.callStage = "active";
  const restart = restartShell();
  await show();
  await click(restartButton()!);
  const dialog = getByRole(document.body, "alertdialog", { name: "Restart Private Base now?" });
  expect(dialog.textContent).toContain("Restarting ends your current call.");
  expect(restart).not.toHaveBeenCalled();
  await click(getByRole(dialog, "button", { name: "Cancel" }));
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
  expect(restart).not.toHaveBeenCalled();

  await click(restartButton()!);
  await click(getByRole(getByRole(document.body, "alertdialog"), "button", { name: "Restart now" }));
  expect(restart).toHaveBeenCalledOnce();
});
it.each(["transferring", "paused", "reconnecting"])("disables Restart now with a hint while a history transfer is %s", async transferPhase => {
  live.transferPhase = transferPhase;
  live.callStage = "active";
  const restart = restartShell();
  await show();
  const button = restartButton()!;
  expect(button.disabled).toBe(true);
  const hint = document.getElementById(button.getAttribute("aria-describedby")!)!;
  expect(hint.textContent).toBe("Finish or stop the history transfer first.");
  expect(hint.className).toContain("text-ink-muted");
  await click(button);
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
  expect(restart).not.toHaveBeenCalled();
  expect(live.stopTransfer).not.toHaveBeenCalled();
});
it("enables Restart now without a hint when no transfer runs", async () => {
  restartShell();
  await show();
  expect(restartButton()!.disabled).toBe(false);
  expect(restartButton()!.hasAttribute("aria-describedby")).toBe(false);
  expect(document.body.textContent).not.toContain("Finish or stop the history transfer first.");
});
it("re-reads the staged bundle every 30 s and on focus while About is visible, and stops when hidden or closed", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    nativeShell({ uiVersion: "1.0.0", uiSource: "embedded" });
    let staged: string | undefined;
    vi.mocked(uiBundles.getPending).mockImplementation(async () => staged);
    await show();
    const reads = () => vi.mocked(uiBundles.getPending).mock.calls.length;
    const initial = reads();
    expect(pendingNotice()).toBeNull();
    staged = "1.0.4";
    await act(async () => { vi.advanceTimersByTime(PENDING_POLL_MS - 1); });
    expect(reads()).toBe(initial);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(reads()).toBe(initial + 1);
    expect(pendingNotice()).toBeTruthy();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(reads()).toBe(initial + 2);

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { window.dispatchEvent(new Event("focus")); vi.advanceTimersByTime(PENDING_POLL_MS * 3); });
    expect(reads()).toBe(initial + 2);
    hidden.mockReturnValue(false);
    staged = undefined;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(reads()).toBe(initial + 3);
    expect(pendingNotice()).toBeNull();
    await act(async () => { vi.advanceTimersByTime(PENDING_POLL_MS); });
    expect(reads()).toBe(initial + 4);

    await render(null);
    await act(async () => { vi.advanceTimersByTime(PENDING_POLL_MS * 3); window.dispatchEvent(new Event("focus")); });
    expect(reads()).toBe(initial + 4);
  } finally { vi.useRealTimers(); }
});
it("does not poll on read-only OTA launches", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    nativeShell({ uiVersion: "1.0.4", uiSource: "ota" });
    window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { otaUi: "read-only" };
    await show();
    const initial = vi.mocked(uiBundles.getPending).mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(PENDING_POLL_MS * 3); window.dispatchEvent(new Event("focus")); });
    expect(vi.mocked(uiBundles.getPending).mock.calls.length).toBe(initial);
  } finally { vi.useRealTimers(); }
});
it("refreshes the notice when native reports the bundle is no longer ready", async () => {
  const restart = restartShell();
  restart.mockRejectedValue(new UiRestartError("not_ready"));
  await show();
  vi.mocked(uiBundles.getPending).mockResolvedValue(undefined);
  await click(restartButton()!);
  expect(pendingNotice()).toBeNull();
  expect(document.body.textContent).not.toContain("Could not restart");
});
it.each(["failed", "unsupported"] as const)("shows a toast when the restart fails (%s) and keeps the notice", async code => {
  const restart = restartShell();
  restart.mockRejectedValue(new UiRestartError(code));
  await show();
  await click(restartButton()!);
  expect(document.body.textContent).toContain("Could not restart Private Base. The UI update will be applied the next time you open it.");
  expect(pendingNotice()).toBeTruthy();
  expect(restartButton()).toBeTruthy();
});
