import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UiPreferencesEffects from "../app/UiPreferencesEffects.js";
const state = vi.hoisted(() => ({ preferences: { themeMode: "light", outgoingMessageColor: "", incomingMessageColor: "", sendButtonColor: "" } }));
vi.mock("../../stores/authStore.js", () => ({ useAuthStore: (select: (value: unknown) => unknown) => select({ user: { id: "alice" } }) }));
vi.mock("../../stores/uiPreferencesStore.js", () => ({ useUiPreferencesStore: (select: (value: unknown) => unknown) => select({ getPreferencesForUser: () => state.preferences }) }));
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  state.preferences = { ...state.preferences, themeMode: "light" };
  document.head.insertAdjacentHTML("beforeend", '<meta name="theme-color" content="#eef2f3" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0e171c" media="(prefers-color-scheme: dark)">');
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  document.documentElement.removeAttribute("data-theme"); document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
});
it("updates browser chrome for a forced theme and restores OS media rules for System", async () => {
  await act(async () => root.render(<UiPreferencesEffects />));
  const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  expect(metas.map((meta) => meta.content)).toEqual(["#eef2f3", "#eef2f3"]);
  expect(metas.every((meta) => !meta.hasAttribute("media"))).toBe(true);
  state.preferences = { ...state.preferences, themeMode: "dark" };
  await act(async () => root.render(<UiPreferencesEffects />));
  expect(metas.map((meta) => meta.content)).toEqual(["#0e171c", "#0e171c"]);
  state.preferences = { ...state.preferences, themeMode: "system" };
  await act(async () => root.render(<UiPreferencesEffects />));
  expect(metas.map((meta) => meta.content)).toEqual(["#eef2f3", "#0e171c"]);
  expect(metas.map((meta) => meta.getAttribute("media"))).toEqual(["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"]);
});
