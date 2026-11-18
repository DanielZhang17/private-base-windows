import { act } from "react";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocalePreference } from "../i18n/index.js";
import { LATEST } from "../features/clients/manifest.fixture.js";
import { PLATFORM_ORDER } from "../features/clients/manifest.js";
import { ToastProvider } from "../ui/index.js";
import { click, setupDom } from "../ui/test-utils.js";
import ClientsPage from "./ClientsPage.js";

const clipboard = vi.hoisted(() => ({ copyText: vi.fn(async (_text: string) => undefined) }));
vi.mock("../platform/clipboard.js", () => clipboard);

const { render, container } = setupDom();
const $ = <T extends Element = HTMLElement>(selector: string) => container().querySelector<T>(selector);
const $$ = (selector: string) => Array.from(container().querySelectorAll<HTMLElement>(selector));
const text = (selector: string) => $$(selector).map((element) => element.textContent?.trim());
const body = () => document.body.textContent ?? "";

const ok = () => new Response(JSON.stringify(LATEST), { status: 200 });
let fetchMock: ReturnType<typeof vi.fn>;

async function settle() {
  for (let index = 0; index < 5; index++) await act(async () => { await Promise.resolve(); });
}

async function open(search = "", respond: () => Promise<Response> = async () => ok()) {
  window.history.replaceState(null, "", `/clients${search}`);
  fetchMock = vi.fn(respond);
  vi.stubGlobal("fetch", fetchMock);
  await render(<BrowserRouter><ToastProvider><ClientsPage /></ToastProvider></BrowserRouter>);
  await settle();
}

beforeEach(() => { clipboard.copyText.mockReset(); clipboard.copyText.mockResolvedValue(undefined); });
afterEach(() => { window.history.replaceState(null, "", "/"); });

it("shows the skeleton while loading and keeps the web app reachable", async () => {
  await open("?platform=macos", () => new Promise<Response>(() => undefined));
  expect($("h1")?.textContent).toBe("Get Private Base");
  expect($("[aria-busy='true']")).not.toBeNull();
  expect($("[role='status']")?.textContent).toBe("Loading downloads");
  expect($$("[aria-busy='true'] .animate-ui-pulse").length).toBeGreaterThan(0);
  expect($("a[href^='https://']")).toBeNull();
  expect($<HTMLAnchorElement>("a[href='/login']")).not.toBeNull();
  expect(document.title).toBe("Download Private Base");
});

it.each(["ready", "error"])("leaves focus at document start through loading and %s", async (status) => {
  let finish: (response: Response) => void = () => undefined;
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  try {
    await open("?platform=macos", () => new Promise<Response>((resolve) => { finish = resolve; }));
    expect(document.activeElement).toBe(document.body);
    expect($("[autofocus]")).toBeNull();
    await act(async () => finish(status === "ready" ? ok() : new Response("no", { status: 503 })));
    await settle();
    expect(document.activeElement).toBe(document.body);
    expect($("[autofocus]")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    const brand = $<HTMLAnchorElement>("header a[href='/']")!;
    brand.focus();
    expect(document.activeElement).toBe(brand);
    expect(brand.tabIndex).toBe(0);
  } finally {
    focus.mockRestore();
  }
});

describe("loaded", () => {
  it("features macOS with facts, download and a closed Verify disclosure", async () => {
    await open("?platform=macos");
    expect(fetchMock).toHaveBeenCalledWith("https://dist.718788.xyz/private-base/releases/latest.json", expect.objectContaining({ credentials: "omit" }));
    expect(text("h2")[0]).toBe("Private Base for macOS");
    const download = $<HTMLAnchorElement>(`a[href='${LATEST.platforms.macos.url}']`)!;
    expect(download.textContent).toBe("Download for macOS");
    expect(download.getAttribute("aria-label")).toBe("Download for macOS (Private Base, 4.8 MB)");
    expect(download.hasAttribute("download")).toBe(false);
    const featured = $("section[aria-labelledby='clients-featured']")!;
    expect(featured.textContent).toContain("Apple silicon");
    expect(featured.textContent).toContain("macOS 12.3 or later");
    expect(featured.textContent).toContain("System Settings › Privacy & Security and choose Open Anyway.");
    expect(featured.textContent).toContain("choosing Open works only on macOS 14 and earlier.");
    const details = featured.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelectorAll(".secret-text span")).toHaveLength(8);
    expect(details.textContent).toContain("shasum -a 256 ~/Downloads/PrivateBase-0.0.1-20261115-macos-arm64.dmg");
    expect(details.textContent).toContain("The result must match the checksum above.");
    expect(text("footer p")[0]).toMatch(/^Version 0\.0\.1-20261115 · Published November 1[67], 2026$/);
    expect($("footer a[href='/clients/releases?platform=macos']")?.textContent).toBe("What’s new");
  });

  it("displays the Android 7.0 minimum with a localized requirement suffix", async () => {
    await open("?platform=android");
    expect($("section[aria-labelledby='clients-featured']")?.textContent).toContain("Android 7.0 or later");
  });

  it.each([
    ["macos", "Private Base for macOS", ["Windows", "Android", "iPhone and iPad"]],
    ["windows", "Private Base for Windows", ["macOS", "Android", "iPhone and iPad"]],
    ["android", "Private Base for Android", ["macOS", "Windows", "iPhone and iPad"]],
    ["ios", "Private Base for iPhone and iPad", ["macOS", "Windows", "Android"]],
  ])("?platform=%s puts that platform first and lists the others once, in order", async (platform, title, others) => {
    await open(`?platform=${platform}`);
    const headings = text("h2");
    expect(headings.slice(0, 2)).toEqual([title, "Other platforms"]);
    expect(text("article h3")).toEqual(others);
    expect(headings).toEqual([title, "Other platforms", "No download needed", "Privacy and safety"]);
  });

  it("shows iOS as Coming soon with Safari guidance and the web app as primary action", async () => {
    await open("?platform=ios");
    const featured = $("section[aria-labelledby='clients-featured']")!;
    expect(featured.textContent).toContain("Coming soon");
    expect(featured.textContent).toContain("Not available yet");
    expect(featured.textContent).toContain("open Private Base in Safari");
    expect(featured.querySelector("dl")).toBeNull();
    expect(featured.querySelector("details")).toBeNull();
    const webApp = featured.querySelector<HTMLAnchorElement>("a[href='/login']")!;
    expect(webApp.textContent).toBe("Open the web app");
    expect(webApp.className).toContain("bg-brand");
  });

  it.each([...PLATFORM_ORDER, "other"])("renders an available iOS build when the visitor platform is %s", async (platform) => {
    const ios = {
      ...LATEST.platforms.android,
      file: "PrivateBase-ios-arm64.ipa",
      url: "https://dist.718788.xyz/private-base/releases/PrivateBase-ios-arm64.ipa",
      minOs: "iOS 16.0",
    };
    const manifest = { ...LATEST, platforms: { ...LATEST.platforms, ios } };
    await open(platform === "other" ? "" : `?platform=${platform}`, async () => new Response(JSON.stringify(manifest), { status: 200 }));
    const download = $<HTMLAnchorElement>(`a[href='${ios.url}']`)!;
    expect(download.textContent).toBe("Download for iPhone and iPad");
    const card = download.closest(platform === "ios" ? "section" : "article")!;
    expect(card.textContent).toContain("Install on iPhone or iPad");
    expect(card.textContent).toContain("Follow the instructions that come with this build.");
    expect(card.textContent).toContain("iOS 16.0 or later");
    expect(card.textContent).not.toContain("Not available yet");
    expect(card.textContent).not.toContain("open Private Base in Safari");
    expect(card.querySelector("details")?.textContent).toContain("To check the file, copy it to a computer.");
    await click(card.querySelector("button[aria-label='Copy checksum for iPhone and iPad']")!);
    expect(clipboard.copyText).toHaveBeenCalledWith(ios.sha256);
  });

  it("features the web app on Linux and other systems and lists all four platforms", async () => {
    await open("");
    expect(text("h2")).toEqual(["No download needed", "All platforms", "Privacy and safety"]);
    expect(text("article h3")).toEqual(["macOS", "Windows", "Android", "iPhone and iPad"]);
    expect($("section[aria-labelledby='clients-featured']")).toBeNull();
    const signInOnWeb = $$("a[href='/login']").find((link) => link.textContent === "Sign in on the web")!;
    expect(signInOnWeb.className).toContain("bg-brand");
  });

  it("copies the checksum without spaces and confirms with a toast", async () => {
    await open("?platform=windows");
    const copy = $<HTMLButtonElement>("button[aria-label='Copy checksum for Windows']")!;
    expect(copy.textContent).toBe("Copy");
    await click(copy);
    expect(clipboard.copyText).toHaveBeenCalledWith(LATEST.platforms.windows.sha256);
    expect(body()).toContain("Checksum copied");
  });

  it("reports a failed copy", async () => {
    clipboard.copyText.mockRejectedValue(new Error("denied"));
    await open("?platform=android");
    await click($("button[aria-label='Copy checksum for Android']")!);
    expect(body()).toContain("Could not copy the checksum");
  });

  it("follows the app language", async () => {
    await setLocalePreference("de");
    await open("?platform=macos");
    expect($("h1")?.textContent).toBe("Private Base herunterladen");
    expect($(`a[href='${LATEST.platforms.macos.url}']`)?.textContent).toBe("Für macOS herunterladen");
    expect(body()).toMatch(/4,8\sMB/);
  });
});

describe("error", () => {
  it("replaces the platforms with a notice; Try again refetches", async () => {
    let attempt = 0;
    let resolveRetry: (response: Response) => void = () => undefined;
    await open("?platform=macos", () => (++attempt === 1 ? Promise.reject(new TypeError("offline")) : new Promise<Response>((resolve) => { resolveRetry = resolve; })));
    const alert = $("[role='alert']")!;
    expect(alert.textContent).toContain("Downloads could not be loaded");
    expect($("section[aria-labelledby='clients-featured']")).toBeNull();
    expect($("article")).toBeNull();
    expect(text("h2")).toEqual(["No download needed", "Privacy and safety"]);
    expect($$("a").some((link) => link.getAttribute("href")?.startsWith("https://dist.718788.xyz/private-base/releases/") && !link.getAttribute("href")?.includes("."))).toBe(false);
    expect(alert.querySelector<HTMLAnchorElement>("a[href='/login']")?.textContent).toBe("Open the web app");

    const retry = Array.from(alert.querySelectorAll("button")).find((button) => button.textContent === "Try again")!;
    await click(retry);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => resolveRetry(ok()));
    await settle();
    expect(text("h2")[0]).toBe("Private Base for macOS");
  });

  it("treats a manifest with a foreign download URL as an error and never links it", async () => {
    const tampered = { ...LATEST, platforms: { ...LATEST.platforms, windows: { ...LATEST.platforms.windows, url: "https://evil.example/setup.exe" } } };
    await open("?platform=windows", async () => new Response(JSON.stringify(tampered), { status: 200 }));
    expect($("[role='alert']")?.textContent).toContain("Downloads could not be loaded");
    expect($("a[href*='evil']")).toBeNull();
  });

  it("treats a non-200 response as an error", async () => {
    await open("?platform=android", async () => new Response("no", { status: 503 }));
    expect($("[role='alert']")?.textContent).toContain("Downloads could not be loaded");
  });
});
