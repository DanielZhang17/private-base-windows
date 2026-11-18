import { act, useRef, useState } from "react";
import { getByRole } from "@testing-library/dom";
import { afterEach, expect, it, vi } from "vitest";
import { click, setupDom } from "../../ui/test-utils.js";
import { useComposerPanel } from "./useComposerPanel.js";

const dom = setupDom();
const heightKey = "private-base:keyboard-height:portrait";

function Composer() {
  const input = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const geometry = useComposerPanel(true, open, input, () => setOpen(false));
  return <>
    <textarea ref={input} onFocus={geometry.measure} onBlur={geometry.measure} />
    <button type="button" onClick={() => setOpen(true)}>Open picker</button>
    <output data-height={geometry.height} data-occupied={geometry.occupied} data-overlay={geometry.overlay} />
  </>;
}

afterEach(() => localStorage.removeItem(heightKey));

async function focusComposer(coarse: boolean) {
  vi.stubGlobal("innerWidth", 450);
  vi.stubGlobal("innerHeight", 850);
  vi.stubGlobal("matchMedia", () => ({ matches: coarse }));
  const visual = Object.assign(new EventTarget(), { height: 850, scale: 1, offsetTop: 0 });
  vi.stubGlobal("visualViewport", visual);
  await dom.render(<Composer />);
  await act(async () => getByRole(dom.container(), "textbox").focus());
  return visual;
}

it("rebases a narrow desktop window resize while the textarea is focused", async () => {
  localStorage.setItem(heightKey, "300");
  const visual = await focusComposer(false);
  await act(async () => {
    vi.stubGlobal("innerHeight", 500);
    visual.height = 500;
    window.dispatchEvent(new Event("resize"));
  });
  await click(getByRole(dom.container(), "button", { name: "Open picker" }));
  expect(dom.container().querySelector("output")?.dataset).toMatchObject({ height: "250", occupied: "0", overlay: "0" });
  expect(localStorage.getItem(heightKey)).toBe("300");
});

it.each([false, true])("still measures a touch software keyboard (overlay=%s)", async (overlay) => {
  const visual = await focusComposer(true);
  await act(async () => {
    if (!overlay) vi.stubGlobal("innerHeight", 500);
    visual.height = 500;
    (overlay ? visual : window).dispatchEvent(new Event("resize"));
  });
  expect(dom.container().querySelector("output")?.dataset).toMatchObject({
    height: "350", occupied: "350", overlay: overlay ? "350" : "0",
  });
  expect(localStorage.getItem(heightKey)).toBe("350");
});
