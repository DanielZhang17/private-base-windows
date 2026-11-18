import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";

let root: Root;
let container: HTMLDivElement;

/** Registers per-test setup/teardown and returns render helpers. Call once at the top of a test file. */
export function setupDom() {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  return {
    render: (node: ReactNode) => act(async () => root.render(node)),
    container: () => container,
  };
}

export const click = (element: Element) => act(async () => (element as HTMLElement).click());

export function mockCloseRequests() {
  let active: EventTarget | undefined;
  class TestCloseWatcher extends EventTarget {
    constructor() { super(); active = this; }
    destroy() { if (active === this) active = undefined; }
  }
  vi.stubGlobal("CloseWatcher", TestCloseWatcher);
  return () => act(async () => {
    if (!active) throw new Error("No active close watcher");
    const watcher = active;
    active = undefined;
    watcher.dispatchEvent(new Event("close"));
  });
}

export const press = (key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
