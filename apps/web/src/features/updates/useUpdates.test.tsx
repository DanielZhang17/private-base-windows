import { act } from "react";
import { getByRole } from "@testing-library/dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { click, setupDom } from "../../ui/test-utils.js";
import { capabilities } from "../../platform/capabilities.js";
import { uiBundles, updates, UpdateError, type UpdateProgress } from "../../platform/updates.js";
import { useCallStore } from "../../stores/callStore.js";
import { canDownloadAutomatically, UPDATE_CHANNEL_KEY, UPDATE_INTERVAL, useUpdates } from "./useUpdates.js";
import { UpdateActions } from "./UpdateStatus.js";
vi.mock("../../platform/updates.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../platform/updates.js")>(),
  updates: { getVersion: vi.fn(), check: vi.fn(), download: vi.fn(), install: vi.fn(), onProgress: vi.fn(), openPermissionSettings: vi.fn() },
}));
const { render } = setupDom();
let value: ReturnType<typeof useUpdates>;
function Probe({ active = false }: { active?: boolean }) { value = useUpdates(active); return null; }
let progress: (value: UpdateProgress) => void;
const stop = vi.fn();
const available = { available: true, version: "0.1.1", notes: "Fixes", sizeBytes: 100 };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.removeItem(UPDATE_CHANNEL_KEY);
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("desktop");
  vi.mocked(updates.getVersion).mockResolvedValue("0.1.0");
  vi.mocked(updates.check).mockResolvedValue({ available: false });
  vi.mocked(updates.download).mockResolvedValue(); vi.mocked(updates.install).mockResolvedValue();
  vi.mocked(updates.onProgress).mockImplementation(async callback => { progress = callback; return stop; });
  vi.mocked(updates.openPermissionSettings).mockResolvedValue();
  useCallStore.setState({ callStatus: null, pendingCallStart: null });
});
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(UPDATE_CHANNEL_KEY); });
it("does nothing on browsers and older native shells", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue(undefined);
  await render(<Probe />);
  expect(updates.check).not.toHaveBeenCalled(); expect(updates.getVersion).not.toHaveBeenCalled();
});
it("checks at startup and every six hours, and cleans up polling", async () => {
  vi.useFakeTimers(); await render(<Probe />);
  expect(updates.check).toHaveBeenCalledExactlyOnceWith("stable"); expect(value.version).toBe("0.1.0");
  await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL); });
  expect(updates.check).toHaveBeenCalledTimes(2);
  await render(null); await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL); });
  expect(updates.check).toHaveBeenCalledTimes(2);
});
it("waits for native verification before ready and unsubscribes from progress", async () => {
  let finish!: () => void;
  vi.mocked(updates.check).mockResolvedValue(available);
  vi.mocked(updates.download).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render(<Probe />);
  expect(value.state.status).toBe("downloading"); expect(value.ready).toBe(false);
  await act(async () => progress({ downloaded: 30, total: 100 }));
  expect(value.state.progress?.downloaded).toBe(30);
  await act(async () => finish());
  expect(value.ready).toBe(true); expect(stop).toHaveBeenCalledOnce();
  await act(async () => progress({ downloaded: 100, total: 100 }));
  expect(value.ready).toBe(true);
  await act(async () => value.check()); expect(updates.check).toHaveBeenCalledTimes(2);
  expect(value.ready).toBe(true); expect(updates.download).toHaveBeenCalledOnce();
});
it("asks on Android when connection is metered or unknown and permits an explicit download", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("android");
  vi.mocked(updates.check).mockResolvedValue(available);
  await render(<Probe />);
  expect(value.state.status).toBe("available"); expect(updates.download).not.toHaveBeenCalled();
  await act(async () => value.download()); expect(value.ready).toBe(true);
});
it("only auto-downloads Android on a known unmetered connection", () => {
  for (const [connection, expected] of [[undefined, false], [{ effectiveType: "4g" }, false], [{ type: "cellular", metered: true }, false], [{ type: "wifi", saveData: true }, false], [{ type: "wifi" }, true], [{ metered: false }, true]] as const) {
    vi.stubGlobal("navigator", { connection }); expect(canDownloadAutomatically("android")).toBe(expected);
  }
  expect(canDownloadAutomatically("desktop")).toBe(true);
});
it("auto-downloads Android on Wi-Fi", async () => {
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("android");
  vi.stubGlobal("navigator", { connection: { type: "wifi" } });
  vi.mocked(updates.check).mockResolvedValue(available);
  await render(<Probe />); expect(value.ready).toBe(true);
});
it("coalesces actions, defers installation during calls and permits Later to cancel it", async () => {
  vi.mocked(updates.check).mockResolvedValue(available);
  await render(<Probe active />);
  await act(async () => { await value.install(); await value.install(); });
  expect(updates.install).not.toHaveBeenCalled(); expect(value.deferred).toBe(true);
  await act(async () => value.later()); await render(<Probe />);
  expect(updates.install).not.toHaveBeenCalled(); expect(value.dismissed).toBe(true);
  await render(<Probe active />); await act(async () => value.install()); await render(<Probe />);
  expect(updates.install).toHaveBeenCalledOnce();
});
it("rechecks a newly started call immediately before invoking install", async () => {
  vi.mocked(updates.check).mockResolvedValue(available); await render(<Probe />);
  useCallStore.setState({ callStatus: "active" });
  await act(async () => value.install()); expect(updates.install).not.toHaveBeenCalled();
  useCallStore.setState({ callStatus: null });
});
it("keeps a mandatory notice on download failure and exposes retry", async () => {
  vi.mocked(updates.check).mockResolvedValue({ ...available, mandatory: true });
  vi.mocked(updates.download).mockRejectedValueOnce(new UpdateError("network"));
  await render(<Probe />);
  expect(value.state.status).toBe("error"); expect(value.state.update?.mandatory).toBe(true);
  await act(async () => value.retry()); expect(value.ready).toBe(true);
});
it("retains the verified update across Android permission recovery", async () => {
  vi.mocked(updates.check).mockResolvedValue(available); await render(<Probe />);
  vi.mocked(updates.install).mockRejectedValueOnce(new UpdateError("permission_required"));
  await act(async () => value.install()); expect(value.state.error).toBe("permission_required"); expect(value.ready).toBe(true);
  await act(async () => value.openPermissionSettings()); await act(async () => value.retry());
  expect(updates.openPermissionSettings).toHaveBeenCalledOnce(); expect(updates.install).toHaveBeenCalledTimes(2);
  expect(updates.download).toHaveBeenCalledOnce(); expect(value.state.error).toBeUndefined();
});
it("resumes an install retry after a call and re-enables the install controls", async () => {
  function Controls({ active = false }: { active?: boolean }) {
    value = useUpdates(active);
    return <UpdateActions update={value} />;
  }
  const installButton = () => getByRole<HTMLButtonElement>(document.body, "button", { name: "Install" });
  vi.spyOn(capabilities, "autoUpdate", "get").mockReturnValue("android");
  vi.mocked(updates.check).mockResolvedValue(available);
  vi.mocked(updates.install).mockRejectedValueOnce(new UpdateError("permission_required"));
  await render(<Controls />);
  await act(async () => value.download());
  await click(installButton());
  expect(value.state).toMatchObject({ status: "error", error: "permission_required", retry: "install" });

  await render(<Controls active />);
  await click(installButton());
  expect(value.deferred).toBe(true);
  expect(updates.install).toHaveBeenCalledOnce();
  expect(installButton().disabled).toBe(true);

  let finish!: () => void;
  vi.mocked(updates.install).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await render(<Controls />);
  expect(updates.install).toHaveBeenCalledTimes(2);
  expect(value.deferred).toBe(false);
  expect(value.installing).toBe(true);
  expect(installButton().disabled).toBe(true);

  await act(async () => finish());
  expect(value.state.status).toBe("ready");
  expect(value.state.error).toBeUndefined();
  expect(value.installing).toBe(false);
  expect(installButton().disabled).toBe(false);
  expect(updates.download).toHaveBeenCalledOnce();
});
it("persists the per-device channel and checks the selected channel", async () => {
  await render(<Probe />); await act(async () => value.setChannel("beta"));
  expect(localStorage.getItem(UPDATE_CHANNEL_KEY)).toBe("beta"); expect(updates.check).toHaveBeenLastCalledWith("beta");
  await render(null); await render(<Probe />); expect(value.channel).toBe("beta");
});
it("keeps the selected channel during a native save and allows a failed switch to be retried", async () => {
  let reject!: (error: Error) => void;
  const persist = vi.spyOn(uiBundles, "setChannel")
    .mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }))
    .mockResolvedValueOnce(undefined);
  localStorage.setItem(UPDATE_CHANNEL_KEY, "beta");
  await render(<Probe />);
  await act(async () => { void value.setChannel("stable"); });
  expect(persist).toHaveBeenCalledExactlyOnceWith("stable");
  expect(value.channelLocked).toBe(true);
  expect(value.channel).toBe("beta");
  expect(localStorage.getItem(UPDATE_CHANNEL_KEY)).toBe("beta");
  expect(updates.check).toHaveBeenCalledExactlyOnceWith("beta");

  await act(async () => { reject(new Error("native persistence failed")); });
  expect(value.channelLocked).toBe(false);
  expect(value.state.error).toBe("failed");
  expect(value.channel).toBe("beta");
  expect(localStorage.getItem(UPDATE_CHANNEL_KEY)).toBe("beta");

  await act(async () => value.setChannel("stable"));
  expect(value.channel).toBe("stable");
  expect(localStorage.getItem(UPDATE_CHANNEL_KEY)).toBe("stable");
  expect(updates.check).toHaveBeenLastCalledWith("stable");
});
it("ignores stale work after unmount and removes an in-flight download listener", async () => {
  let finish!: (value: typeof available) => void;
  vi.mocked(updates.check).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render(<Probe />); await render(null); await act(async () => finish(available));
  expect(updates.download).not.toHaveBeenCalled();
  vi.mocked(updates.check).mockResolvedValue(available);
  vi.mocked(updates.download).mockReturnValue(new Promise(() => {}));
  await render(<Probe />); await render(null); expect(stop).toHaveBeenCalled();
});

it("refreshes policy for ready updates every six hours and cancels an install if native withdraws the candidate", async () => {
  vi.useFakeTimers(); vi.mocked(updates.check).mockResolvedValue(available);
  await render(<Probe active />); await act(async () => value.install());
  expect(value.ready).toBe(true); expect(value.deferred).toBe(true);
  vi.mocked(updates.check).mockResolvedValue({ available: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL); });
  expect(updates.check).toHaveBeenCalledTimes(2); expect(value.ready).toBe(false); expect(value.deferred).toBe(false);
  await render(<Probe />); expect(updates.install).not.toHaveBeenCalled();
});
it("retains a verified candidate through a failed policy refresh and resumes a queued install after checking", async () => {
  vi.mocked(updates.check).mockResolvedValue(available); await render(<Probe active />);
  vi.mocked(updates.check).mockRejectedValueOnce(new UpdateError("network"));
  await act(async () => value.check()); expect(value.state.status).toBe("error");
  await act(async () => value.retry()); expect(value.ready).toBe(true); expect(updates.download).toHaveBeenCalledOnce();
  await act(async () => value.install());
  let finish!: (update: typeof available) => void;
  vi.mocked(updates.check).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await act(async () => { void value.check(); }); await render(<Probe />);
  expect(updates.install).not.toHaveBeenCalled();
  await act(async () => finish(available)); expect(updates.install).toHaveBeenCalledOnce();
});

it("cancels a queued install on a failed policy check so retry remains actionable", async () => {
  vi.mocked(updates.check).mockResolvedValue({ ...available, mandatory: true });
  await render(<Probe active />); await act(async () => value.install());
  vi.mocked(updates.check).mockRejectedValueOnce(new UpdateError("network"));
  await act(async () => value.check());
  expect(value.deferred).toBe(false); expect(value.state.error).toBe("network"); expect(value.state.retry).toBe("check");
  await render(<Probe />); expect(updates.install).not.toHaveBeenCalled();
});
