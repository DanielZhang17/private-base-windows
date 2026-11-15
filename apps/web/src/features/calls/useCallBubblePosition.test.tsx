import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCallBubblePosition } from "./useCallBubblePosition.js";

let root: Root;
let container: HTMLDivElement;
let view: ReturnType<typeof useCallBubblePosition>;
let notifyResize: () => void;
let viewport = { width: 368, height: 640 };
const expand = vi.fn();
const capture = vi.fn();
function Probe() {
  view = useCallBubblePosition();
  return <div ref={view.boundsRef} data-bounds><div ref={view.bubbleRef} data-bubble>
    <button {...view.dragProps} onClick={(event) => { if (view.shouldExpand(event.detail)) expand(); }}>Return</button>
  </div></div>;
}
function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  container.querySelector("button")!.dispatchEvent(event);
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.stubGlobal("innerWidth", 400);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { notifyResize = callback; }
    observe() {} unobserve() {} disconnect() {}
  });
  viewport = { width: 368, height: 640 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const size = this.hasAttribute("data-bounds") ? viewport : { width: 176, height: 208 };
    return { ...size, left: 0, top: 0, right: size.width, bottom: size.height } as DOMRect;
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: capture });
  container = document.createElement("div"); root = createRoot(container);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("drags with pointer capture, clamps, snaps and suppresses the drag's click while retaining keyboard expansion", async () => {
  expect(view.position).toEqual({ x: 192, y: 432 });
  await act(async () => pointer("pointerdown", 250, 500));
  expect(capture).toHaveBeenCalledWith(1);
  await act(async () => pointer("pointermove", -50, 300));
  expect(view.position).toEqual({ x: 0, y: 232 });
  expect(view.snapping).toBe(false);
  await act(async () => pointer("pointerup", -50, 300));
  expect(view.position).toEqual({ x: 0, y: 232 });
  expect(view.snapping).toBe(true);
  container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  expect(expand).not.toHaveBeenCalled();
  container.querySelector("button")!.click(); // Native Enter/Space activation also has detail 0.
  expect(expand).toHaveBeenCalledOnce();
});
it("snaps to the closest edge and immediately reclamps after rotation without animating outside the viewport", async () => {
  await act(async () => pointer("pointerdown", 250, 500));
  await act(async () => pointer("pointermove", 210, 700));
  expect(view.position).toEqual({ x: 152, y: 432 });
  await act(async () => pointer("pointerup", 210, 700));
  expect(view.position).toEqual({ x: 192, y: 432 });
  viewport = { width: 300, height: 260 };
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(view.position).toEqual({ x: 124, y: 52 });
  expect(view.snapping).toBe(false);
});
it("treats small touch jitter as a tap and cancels a drag without expanding", async () => {
  await act(async () => pointer("pointerdown", 250, 500));
  await act(async () => pointer("pointermove", 252, 501));
  await act(async () => pointer("pointerup", 252, 501));
  container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  expect(expand).toHaveBeenCalledOnce();
  await act(async () => pointer("pointerdown", 250, 500));
  await act(async () => pointer("pointermove", 100, 300));
  await act(async () => pointer("pointercancel", 100, 300));
  expect(view.position).toEqual({ x: 0, y: 232 });
  container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  expect(expand).toHaveBeenCalledOnce();
});

it("defaults to the top-right of the desktop message area", async () => {
  vi.stubGlobal("innerWidth", 1280);
  await act(async () => root.unmount());
  viewport = { width: 1248, height: 788 };
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
  expect(view.position).toEqual({ x: 1072, y: 0 });
});
it("reclamps above the composer when multiline text or an attachment grows it", async () => {
  let composerTop = 560;
  const composer = document.createElement("form");
  composer.dataset.callAvoid = "bottom";
  composer.getBoundingClientRect = () => ({ left: 0, top: composerTop, right: 400, bottom: 640, width: 400, height: 640 - composerTop } as DOMRect);
  await act(async () => document.body.append(composer, container));
  await act(async () => notifyResize());
  expect(view.areaStyle?.height).toBe(544);
  expect(view.position?.y).toBe(336);
  composerTop = 440;
  await act(async () => notifyResize());
  expect(view.areaStyle?.height).toBe(424);
  expect(view.position?.y).toBe(216);
  await act(async () => {
    pointer("pointerdown", 250, 300);
    pointer("pointermove", 999, 999);
    pointer("pointerup", 999, 999);
  });
  expect(view.position).toEqual({ x: 192, y: 216 });
  await act(async () => composer.remove());
});
it("reclamps on visual viewport keyboard resize and pan", async () => {
  await act(async () => root.unmount());
  const visual = Object.assign(new EventTarget(), { offsetTop: 0, offsetLeft: 0, width: 400, height: 672 });
  vi.stubGlobal("visualViewport", visual);
  vi.stubGlobal("innerHeight", 672);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
  visual.height = 400;
  viewport.height = 368; // Fixed bounds after the visual viewport CSS inset changes.
  await act(async () => visual.dispatchEvent(new Event("resize")));
  expect(view.position).toEqual({ x: 192, y: 160 });
  expect(container.querySelector<HTMLElement>("[data-bounds]")!.style.getPropertyValue("--call-viewport-bottom")).toBe("272px");
  visual.offsetTop = 20;
  await act(async () => visual.dispatchEvent(new Event("scroll")));
  expect(container.querySelector<HTMLElement>("[data-bounds]")!.style.getPropertyValue("--call-viewport-top")).toBe("20px");
});
