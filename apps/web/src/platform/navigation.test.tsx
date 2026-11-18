import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, useLocation, useNavigate } from "react-router-dom";
import { waitFor } from "@testing-library/dom";
import { useOverlayLayer } from "../ui/useOverlayLayer.js";
import { OVERLAY_RANK } from "../ui/overlay-stack.js";
import { afterEach, expect, it, vi } from "vitest";
import { RouterNavigation } from "./RouterNavigation.js";
import { navigate, registerNavigate } from "./navigation.js";

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])("dismisses phone layers on the first router entry without CloseWatcher (previous document=%s)", async (previousDocument) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CloseWatcher", undefined);
  const chat = "/chat/direct";
  if (previousDocument) {
    window.history.replaceState(null, "", "/previous-document");
    window.history.pushState(null, "", chat);
    vi.stubGlobal("performance", { now: performance.now.bind(performance), getEntriesByType: () => [{ type: "navigate" }] });
  } else {
    expect(window.history.length).toBe(1);
    window.history.replaceState(null, "", chat);
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Route() {
    const { pathname } = useLocation();
    const [open, setOpen] = useState(false);
    const [menu, setMenu] = useState(false);
    useOverlayLayer(open, "popover", OVERLAY_RANK.picker, () => setOpen(false));
    useOverlayLayer(menu, "modal", OVERLAY_RANK.actionMenu, () => setMenu(false));
    return <><output>{pathname}</output>
      <button onClick={() => setOpen(!open)}>{open ? "Close picker" : "Open picker"}</button>
      {open && <button onClick={() => setMenu(true)}>Open actions</button>}
      {menu && <p>Phone actions</p>}
    </>;
  }
  const traverse = (go: () => void) => act(async () => {
    const settled = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    go();
    await settled;
  });
  const toggle = () => container.querySelector("button")!.click();
  try {
    await act(async () => root.render(<BrowserRouter><RouterNavigation><Route /></RouterNavigation></BrowserRouter>));
    const entry = window.history.state;
    expect(entry.idx).toBe(0);
    await act(async () => toggle());
    expect(window.history.state.privateBaseOverlay).toBeTruthy();
    await act(async () => container.querySelectorAll("button")[1].click());
    await traverse(() => window.history.back());
    expect(container.textContent).not.toContain("Phone actions");
    expect(container.textContent).toContain("Close picker");
    expect(window.history.state.privateBaseOverlay).toBeTruthy();
    await traverse(() => window.history.back());
    expect(container.textContent).toBe(`${chat}Open picker`);
    expect(window.location.pathname).toBe(chat);
    expect(window.history.state).toEqual(entry);
    await act(async () => toggle());
    expect(window.history.state.privateBaseOverlay).toBeTruthy();
    await traverse(toggle);
    expect(window.history.state).toEqual(entry);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([false, true])("registers the mounted BrowserRouter and preserves native/web navigation (native=%s)", async (native) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (native) vi.stubGlobal("__TAURI_INTERNALS__", {});
  window.history.replaceState(null, "", "/chat/initial");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function CurrentRoute() { return <output>{useLocation().pathname}</output>; }
  await act(async () => root.render(<BrowserRouter><RouterNavigation /><CurrentRoute /></BrowserRouter>));
  expect(container.textContent).toBe("/chat/initial");
  await act(async () => navigate("/login"));
  expect(container.textContent).toBe("/login");
  expect(window.location.pathname).toBe("/login");
  await act(async () => root.unmount());
  container.remove();
});

it.each(["https://chat.718788.xyz", "tauri://localhost"])("falls back before router registration on %s", (url) => {
  const location = { href: url };
  vi.stubGlobal("window", { location });
  navigate("/login");
  expect(location.href).toBe("/login");
});

it("does not unregister a newer router during old-router cleanup", () => {
  const oldRoute = vi.fn();
  const newRoute = vi.fn();
  const cleanupOld = registerNavigate(oldRoute);
  const cleanupNew = registerNavigate(newRoute);
  cleanupOld();
  navigate("/chat/1");
  expect(oldRoute).not.toHaveBeenCalled();
  expect(newRoute).toHaveBeenCalledWith("/chat/1");
  cleanupNew();
});

it.each(["push", "replace"] as const)("dismisses the picker on a router %s and leaves normal Back history", async (method) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({ idx: 0 }, "", "/");
  window.history.pushState({ idx: 1 }, "", "/chat/sticker");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Route() {
    const location = useLocation();
    const nav = useNavigate();
    const [picker, setPicker] = useState(true);
    useOverlayLayer(picker && location.pathname === "/chat/sticker", "popover", OVERLAY_RANK.picker, () => setPicker(false));
    return <><output>{location.pathname}</output>{picker && <p>Phone picker</p>}
      <Link to="/settings" replace={method === "replace"}>Leave</Link>
      <button onClick={() => nav(-1)}>Back</button></>;
  }
  try {
    await act(async () => root.render(<BrowserRouter><RouterNavigation><Route /></RouterNavigation></BrowserRouter>));
    expect(container.textContent).toContain("Phone picker");
    await act(async () => container.querySelector<HTMLElement>("a")!.click());
    expect(container.querySelector("output")?.textContent).toBe("/settings");
    expect(container.textContent).not.toContain("Phone picker");
    expect(window.history.state.privateBaseOverlay).toBeUndefined();
    const back = () => act(async () => {
      const traversed = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
      container.querySelector("button")!.click();
      await traversed;
    });
    await back();
    if (method === "push") {
      expect(container.querySelector("output")?.textContent).toBe("/chat/sticker");
      expect(window.history.state.privateBaseOverlay).toBeUndefined();
      await back();
    }
    expect(container.querySelector("output")?.textContent).toBe("/");
    if (method === "replace") {
      const forward = () => act(async () => {
        const settled = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
        window.history.forward();
        await settled;
      });
      await forward();
      expect(container.querySelector("output")?.textContent).toBe("/settings");
      await back();
      expect(container.querySelector("output")?.textContent).toBe("/");
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each(["privateBaseOverlay", "messageActionMenu"])("retires a restored %s marker and skips it on Forward", async (marker) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const chat = "/chat/restored";
  const chatState = { idx: 0, key: "restored-chat" };
  window.history.replaceState(chatState, "", chat);
  window.history.pushState({ ...chatState, [marker]: "restored-token" }, "", chat);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Route() { return <output>{useLocation().pathname}</output>; }
  const traversal = (go: () => void) => act(async () => {
    const traversed = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    go();
    await traversed;
  });
  try {
    await act(async () => root.render(<BrowserRouter><RouterNavigation><Route /></RouterNavigation></BrowserRouter>));
    await act(async () => {
      await waitFor(() => expect(window.history.state[marker]).toBeUndefined());
    });
    await traversal(() => window.history.forward());
    expect(container.textContent).toBe(chat);
    expect(window.history.state[marker]).toBeUndefined();
    await act(async () => navigate("/settings"));
    expect(container.textContent).toBe("/settings");
    await traversal(() => window.history.back());
    expect(container.textContent).toBe(chat);
    expect(window.history.state[marker]).toBeUndefined();
    await traversal(() => window.history.forward());
    expect(container.textContent).toBe("/settings");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("dismisses the phone picker when a notification navigates within the mounted chat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const chat = "/chat/open";
  window.history.replaceState({ idx: 0 }, "", "/");
  window.history.pushState({ idx: 1 }, "", chat);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Route() {
    const { pathname, search } = useLocation();
    const [open, setOpen] = useState(true);
    useOverlayLayer(open, "popover", OVERLAY_RANK.picker, () => setOpen(false));
    return <><output>{pathname + search}</output>{open && <p>Phone picker</p>}</>;
  }
  const traverse = (go: () => void) => act(async () => {
    const settled = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    go();
    await settled;
  });
  try {
    await act(async () => root.render(<BrowserRouter><RouterNavigation><Route /></RouterNavigation></BrowserRouter>));
    expect(container.textContent).toContain("Phone picker");
    await act(async () => navigate(`${chat}?push=message`));
    expect(container.textContent).toBe(`${chat}?push=message`);
    expect(window.history.state.privateBaseOverlay).toBeUndefined();
    await traverse(() => window.history.back());
    expect(container.textContent).toBe(chat);
    await traverse(() => window.history.forward());
    expect(container.textContent).toBe(`${chat}?push=message`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([
  { dismissal: "close button", first: false },
  { dismissal: "browser Back", first: false },
  { dismissal: "close button", first: true },
])("preserves Forward after dismissing the phone picker with $dismissal (first router entry=$first)", async ({ dismissal, first }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CloseWatcher", undefined);
  vi.stubGlobal("performance", { now: performance.now.bind(performance), getEntriesByType: () => [{ type: "navigate" }] });
  window.history.replaceState({ idx: 0 }, "", first ? "/chat/a" : "/");
  if (!first) window.history.pushState({ idx: 1 }, "", "/chat/a");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Route() {
    const { pathname } = useLocation();
    const [open, setOpen] = useState(false);
    useOverlayLayer(open, "popover", OVERLAY_RANK.picker, () => setOpen(false));
    return <><output>{pathname}</output><button onClick={() => setOpen(!open)}>{open ? "Close picker" : "Open picker"}</button></>;
  }
  const traverse = (go: () => void) => act(async () => {
    const settled = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    go();
    await settled;
  });
  const route = () => container.querySelector("output")?.textContent;
  const toggle = () => act(async () => container.querySelector("button")!.click());
  try {
    await act(async () => root.render(<BrowserRouter><RouterNavigation><Route /></RouterNavigation></BrowserRouter>));
    await act(async () => navigate("/chat/b"));
    expect(route()).toBe("/chat/b");
    await traverse(() => window.history.back());
    expect(route()).toBe("/chat/a");
    const historyLength = window.history.length;
    const chatEntry = window.history.state;
    const pushState = vi.spyOn(window.history, "pushState");
    try {
      await toggle();
      expect(container.textContent).toContain("Close picker");
      if (dismissal === "browser Back") await traverse(() => window.history.back());
      else await toggle();
      expect(container.textContent).toContain("Open picker");
      expect(route()).toBe("/chat/a");
      expect(window.history.state).toEqual(chatEntry);
      expect(window.history.length).toBe(historyLength);
      expect(pushState).not.toHaveBeenCalled();
      await traverse(() => window.history.forward());
      expect(route()).toBe("/chat/b");
    } finally { pushState.mockRestore(); }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
