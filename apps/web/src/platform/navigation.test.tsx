import { act } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { RouterNavigation } from "./RouterNavigation.js";
import { navigate, registerNavigate } from "./navigation.js";

afterEach(() => vi.unstubAllGlobals());

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
