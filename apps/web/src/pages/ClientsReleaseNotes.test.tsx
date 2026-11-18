import { act } from "react";
import { BrowserRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import ClientsApp from "../ClientsApp.js";
import { LATEST } from "../features/clients/manifest.fixture.js";
import { MANIFEST_URL, NOTES_URL } from "../features/clients/manifest.js";
import { setLocalePreference } from "../i18n/index.js";
import { click, press, setupDom } from "../ui/test-utils.js";

const { render, container } = setupDom();
const latest = { version: "0.2.0", published: "2026-11-18T12:00:00Z", notes: "## Highlights\n- **Fast** downloads.", platforms: ["windows", "android"] };
const older = { version: "0.1.0", published: "2026-11-15T12:00:00Z", notes: "The first release.", platforms: ["macos"] };
const response = (entries: unknown = [latest, older]) => new Response(JSON.stringify({ product: "Private Base", entries }));
const query = <T extends HTMLElement = HTMLElement>(selector: string) => container().querySelector<T>(selector);
const tab = (name: string) => query<HTMLAnchorElement>(`#clients-tab-${name}`)!;

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((finish) => { resolve = finish; });
  return { promise, resolve };
}

async function open(path: string, fetchMock: typeof fetch) {
  window.history.replaceState(null, "", path);
  vi.stubGlobal("fetch", fetchMock);
  await render(<BrowserRouter><ClientsApp /></BrowserRouter>);
}

async function travel(direction: "back" | "forward") {
  await act(() => new Promise<void>((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
    window.history[direction]();
  }));
}

afterEach(() => { window.history.replaceState(null, "", "/"); });

it("selects Release notes on a standalone deep link and requests only the public notes archive", async () => {
  const finish = deferredResponse();
  const load = vi.fn(() => finish.promise);
  await open("/Clients/Releases//", load);
  expect(tab("releases").getAttribute("aria-selected")).toBe("true");
  expect(tab("download").tabIndex).toBe(-1);
  const panel = query("[role='tabpanel']:not([hidden])")!;
  expect(panel.getAttribute("aria-labelledby")).toBe(tab("releases").id);
  expect(panel.id).toBe(tab("releases").getAttribute("aria-controls"));
  expect(panel.querySelector("[role='status']")?.textContent).toBe("Loading release notes");
  expect(load).toHaveBeenCalledExactlyOnceWith(NOTES_URL, {
    cache: "no-store", credentials: "omit", mode: "cors", redirect: "error",
    referrerPolicy: "no-referrer", signal: expect.any(AbortSignal), headers: { Accept: "application/json" },
  });

  await act(async () => finish.resolve(response()));
  const newest = panel.querySelector("article")!;
  expect(newest.querySelector("h2")?.textContent).toBe("0.2.0");
  expect(newest.querySelector("time")?.textContent).toBe(new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(new Date(latest.published)));
  expect(newest.textContent).toContain("WindowsAndroid");
  expect(newest.querySelector("strong")?.textContent).toBe("Fast");
  expect(newest.querySelector("[lang='en']")).not.toBeNull();
  expect(panel.textContent).not.toContain("Release notes are in English.");

  const details = panel.querySelector("details")!;
  const summary = details.querySelector("summary")!;
  const toggle = () => act(async () => {
    const toggled = new Promise((resolve) => details.addEventListener("toggle", resolve, { once: true }));
    summary.click();
    await toggled;
  });
  expect(details.open).toBe(false);
  expect(summary.textContent).toContain("0.1.0");
  expect(details.querySelector("[lang='en']")).toBeNull();
  expect(details.textContent).not.toContain(older.notes);
  await toggle();
  expect(details.open).toBe(true);
  const mounted = details.querySelector("[lang='en']");
  expect(mounted?.textContent).toBe(older.notes);
  await toggle();
  expect(details.open).toBe(false);
  expect(details.querySelector("[lang='en']")).toBe(mounted);
  await toggle();
  expect(details.open).toBe(true);
  expect(details.querySelector("[lang='en']")).toBe(mounted);

  await act(async () => setLocalePreference("de"));
  expect(panel.textContent).toContain("Die Versionshinweise sind auf Englisch.");
  expect(newest.querySelector("time")?.textContent).toBe(new Intl.DateTimeFormat("de", { dateStyle: "long" }).format(new Date(latest.published)));
});

it("navigates from What’s new, supports arrow keys and follows browser history", async () => {
  await open("/clients?platform=macos", vi.fn(async (url) => url === MANIFEST_URL ? new Response(JSON.stringify(LATEST)) : response()));
  expect(query(".min-h-11[role='tab']")?.textContent).toBe("Download");
  await click(query("footer a")!);
  expect(window.location.pathname).toBe("/clients/releases");
  expect(document.activeElement).toBe(tab("releases"));
  expect(query("#clients-panel-download")?.hidden).toBe(true);
  await travel("back");
  expect(window.location.pathname).toBe("/clients");
  expect(window.location.search).toBe("?platform=macos");
  expect(tab("download").getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tab("download"));
  await travel("forward");
  expect(document.activeElement).toBe(tab("releases"));
  await press("ArrowLeft");
  expect(window.location.pathname).toBe("/clients");
  expect(tab("download").tabIndex).toBe(0);
  await press("ArrowRight");
  expect(window.location.pathname).toBe("/clients/releases");
  await press("Home");
  expect(window.location.pathname).toBe("/clients");
  await press("End");
  expect(window.location.pathname).toBe("/clients/releases");
  await click(tab("download"));
  expect(window.location.pathname).toBe("/clients");
});

it("selects Release notes for an encoded standalone deep link", async () => {
  const load = vi.fn(async () => response());
  await open("/clients/%72eleases", load);
  expect(tab("releases").getAttribute("aria-selected")).toBe("true");
  expect(query("article h2")?.textContent).toBe(latest.version);
  expect(load).toHaveBeenCalledExactlyOnceWith(NOTES_URL, expect.any(Object));
});

it("rejects the whole malformed archive and shows a busy Retry before the empty state", async () => {
  const retry = deferredResponse();
  const load = vi.fn<typeof fetch>().mockResolvedValueOnce(response([latest, { ...older, platforms: ["invalid"] }]))
    .mockReturnValueOnce(retry.promise);
  await open("/clients/releases", load);
  const alert = query("[role='alert']")!;
  expect(alert.textContent).toContain("Release notes could not be loaded");
  expect(query("article")).toBeNull();
  const button = alert.querySelector("button")!;
  await click(button);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => retry.resolve(response([])));
  expect(query("[role='status']")?.textContent).toBe("No release notes have been published yet.");
});

it("reports HTTP and invalid JSON responses as errors", async () => {
  const load = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response("not JSON"));
  await open("/clients/releases", load);
  expect(query("[role='alert']")?.textContent).toContain("Release notes could not be loaded");
  await click(query("[role='alert'] button")!);
  expect(query("[role='alert']")?.textContent).toContain("Release notes could not be loaded");
});

it("times out at eight seconds and aborts a retry when leaving the tab", async () => {
  vi.useFakeTimers();
  const load = vi.fn<typeof fetch>((url, options) => {
    if (url === MANIFEST_URL) return Promise.resolve(new Response(JSON.stringify(LATEST)));
    return new Promise((_, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  await open("/clients/releases", load);
  await act(async () => { await vi.advanceTimersByTimeAsync(7_999); });
  expect(query("[aria-busy='true']")).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(query("[role='alert']")).not.toBeNull();
  await click(query("[role='alert'] button")!);
  const signal = load.mock.calls[1][1]!.signal!;
  expect(signal.aborted).toBe(false);
  await click(tab("download"));
  expect(signal.aborted).toBe(true);
});
