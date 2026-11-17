import { useState } from "react";
import { act } from "react";
import { getByRole, queryByRole } from "@testing-library/dom";
import { afterEach, expect, it, vi } from "vitest";
import { ActionMenu, type ActionMenuPosition } from "./ActionMenu.js";
import { click, press, setupDom } from "./test-utils.js";
const dom = setupDom();
afterEach(() => vi.restoreAllMocks());
function Harness({ position = { x: 300, y: 100 } }: { position?: ActionMenuPosition }) {
  const [open, setOpen] = useState(true);
  return <ActionMenu open={open} position={position} title="Message actions" preview={<span>Alice — Private preview</span>} onClose={() => setOpen(false)} items={[
    { id: "copy", label: "Copy text", icon: "copy", onSelect: vi.fn() },
    { id: "save", label: "Save file", icon: "share", onSelect: vi.fn() },
    { id: "delete", label: "Delete for me", icon: "trash", hint: "This device only", separatorBefore: true, danger: true, onSelect: vi.fn() },
  ]} />;
}
it("focuses the pointer menu container, supports arrows/typeahead and renders icons, hints and a divider", async () => {
  await dom.render(<Harness />);
  const menu = getByRole(document.body, "menu");
  expect(document.activeElement).toBe(menu);
  expect(menu.tabIndex).toBe(-1);
  expect(getByRole(menu, "separator")).toBeDefined();
  const remove = getByRole(menu, "menuitem", { name: "Delete for me" });
  expect(document.getElementById(remove.getAttribute("aria-describedby")!)?.textContent).toBe("This device only");
  expect(remove.querySelector("svg")?.getAttribute("width")).toBe("18");
  await press("ArrowDown"); expect(document.activeElement?.getAttribute("aria-label")).toBe("Copy text");
  await press("d"); expect(document.activeElement).toBe(remove);
  await press("Escape"); expect(queryByRole(document.body, "menu")).toBeNull();
});
it("focuses the first item only for keyboard openings and preserves Space activation", async () => {
  await dom.render(<Harness position={{ x: 300, y: 100, keyboard: true }} />);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Copy text");
  const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  await act(async () => { document.activeElement!.dispatchEvent(space); });
  expect(space.defaultPrevented).toBe(false);
});
it.each([
  { source: "button" as const, align: "end" as const, x: 300, y: 100, top: 64, left: "100px", expectedTop: "104px" },
  { source: "button" as const, align: "start" as const, x: 300, y: 100, top: 64, left: "300px", expectedTop: "104px" },
  { source: "pointer" as const, align: "end" as const, x: 300, y: 100, left: "96px", expectedTop: "104px" },
  { source: "pointer" as const, align: "start" as const, x: 300, y: 100, left: "304px", expectedTop: "104px" },
  { source: "button" as const, align: "end" as const, x: 300, y: 760, top: 724, left: "100px", expectedTop: "620px" },
])("places $source/$align at $left, $expectedTop", async ({ left, expectedTop, ...position }) => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 200, height: 100 } as DOMRect);
  await dom.render(<Harness position={position} />);
  const panel = getByRole(document.body, "menu").parentElement!;
  expect(panel.style.left).toBe(left); expect(panel.style.top).toBe(expectedTop);
});
it("shows the phone preview with pointer focus, 52px rows, 20px icons and a 44px close button", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await dom.render(<Harness />);
  const sheet = getByRole(document.body, "dialog", { name: "Message actions" });
  expect(sheet.textContent).toContain("Alice — Private preview");
  const menu = getByRole(sheet, "menu"); expect(document.activeElement).toBe(menu);
  const row = getByRole(menu, "menuitem", { name: "Delete for me" });
  expect(row.className).toContain("min-h-[52px]");
  expect(row.querySelector("svg")?.getAttribute("width")).toBe("20");
  expect(getByRole(sheet, "button", { name: "Close" }).className).toContain("size-11");
  await click(getByRole(sheet, "button", { name: "Close" }));
  expect(queryByRole(document.body, "menu")).toBeNull();
});
it("consumes the phone back gesture to close the menu", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await dom.render(<Harness />);
  expect(history.state?.messageActionMenu).toBeTruthy();
  // Model the popstate after the browser has traversed the temporary entry.
  history.replaceState(null, "");
  await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(queryByRole(document.body, "menu")).toBeNull();
});
