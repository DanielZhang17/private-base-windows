import { act, useState } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import MediaViewer from "./MediaViewer.js";
import { Dialog } from "../../ui/index.js";
import { click, press, setupDom } from "../../ui/test-utils.js";

const { render } = setupDom();
let onClose: ReturnType<typeof vi.fn>;
let width = 400;
let height = 600;
beforeEach(() => {
  onClose = vi.fn();
  width = 400; height = 600;
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("639") && width < 640 })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON() {} }));
  HTMLElement.prototype.setPointerCapture = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

function Harness({ video = false, save = true }: { video?: boolean; save?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button id="opener" onClick={() => setOpen(true)}>Open</button><button id="outside">Outside</button>
    {open && <MediaViewer objectUrl="blob:private" fileName="photo.png" isVideo={video} onClose={() => { onClose(); setOpen(false); }} onSave={save ? () => {} : undefined} />}</>;
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const stage = () => document.querySelector<HTMLElement>(".media-viewer-stage")!;
const image = () => document.querySelector<HTMLImageElement>(".media-viewer-image")!;
const scale = () => document.querySelector(".media-viewer-zoom")!.textContent;
async function open(options = {}) {
  await render(<Harness {...options} />);
  const opener = document.getElementById("opener")!;
  opener.focus();
  await click(opener);
  if (image()) {
    Object.defineProperty(image(), "naturalWidth", { configurable: true, value: 800 });
    Object.defineProperty(image(), "naturalHeight", { configurable: true, value: 1200 });
    await act(async () => { image().dispatchEvent(new Event("load")); });
  }
  return opener;
}
async function pointer(type: string, x = 200, y = 300, pointerId = 1, pointerType = "touch") {
  await act(async () => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: pointerType } });
    stage().dispatchEvent(event);
  });
}
async function tap(x = 200, y = 300) { await pointer("pointerdown", x, y); await pointer("pointerup", x, y); }
const advance = (ms = 251) => act(async () => { vi.advanceTimersByTime(ms); });
const doubleTap = async (x = 200, y = 300) => { await tap(x, y); await advance(100); await tap(x, y); };

it("is a named dark modal, traps focus, locks scrolling and restores the opener on Escape", async () => {
  const opener = await open();
  expect(dialog().getAttribute("aria-modal")).toBe("true");
  expect(dialog().dataset.theme).toBe("dark");
  expect(document.getElementById(dialog().getAttribute("aria-labelledby")!)!.textContent).toBe("Media viewer: photo.png");
  expect(document.activeElement).toBe(dialog().querySelector('[aria-label="Close"]'));
  expect(document.body.style.overflow).toBe("hidden");
  const buttons = dialog().querySelectorAll("button");
  buttons[buttons.length - 1].focus();
  await press("Tab");
  expect(document.activeElement).toBe(buttons[0]);
  await press("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  document.getElementById("outside")!.focus();
  expect(dialog().contains(document.activeElement)).toBe(true);
  await press("Escape");
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe("");
});

it("shares the modal focus stack with existing dialogs", async () => {
  await render(<Dialog open title="Underlying dialog" onClose={() => {}}><Harness /></Dialog>);
  await click(document.getElementById("opener")!);
  const viewer = document.querySelector(".media-viewer")!;
  expect(viewer.contains(document.activeElement)).toBe(true);
  await press("Escape");
  expect(document.querySelector(".media-viewer")).toBeNull();
  expect(dialog().contains(document.activeElement)).toBe(true);
  expect(document.body.style.overflow).toBe("hidden");
});

it("delays single-tap close at 1x and cancels the pending close for a double tap at its focal point", async () => {
  await open();
  await tap();
  await advance(249);
  expect(onClose).not.toHaveBeenCalled();
  await advance(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  await open();
  onClose.mockClear();
  await doubleTap(300, 200);
  expect(scale()).toBe("250%");
  expect(image().style.transform).toBe("translate(-150px, 150px) scale(2.5)");
  await advance();
  expect(onClose).not.toHaveBeenCalled();
});

it("resets zoom immediately on the first tap, then closes on the next single tap", async () => {
  await open();
  await doubleTap();
  await advance();
  await tap();
  expect(scale()).toBe("100%");
  expect(onClose).not.toHaveBeenCalled();
  await advance();
  await tap();
  await advance();
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("a double click at 2.5x resets to 1x and never schedules a close", async () => {
  await open();
  await doubleTap();
  await advance();
  await doubleTap();
  await advance();
  expect(scale()).toBe("100%");
  expect(onClose).not.toHaveBeenCalled();
});

it("never treats dragging out and back, cancellation, or a held second tap as a close", async () => {
  await open();
  await tap();
  await advance(100);
  await pointer("pointerdown");
  await advance(500);
  expect(onClose).not.toHaveBeenCalled();
  await pointer("pointermove", 230, 300);
  await pointer("pointermove", 200, 300);
  await pointer("pointerup");
  await advance();
  await pointer("pointerdown");
  await pointer("pointercancel");
  await advance();
  expect(onClose).not.toHaveBeenCalled();
});

it("pinches to zoom and pans with bounds, suppressing taps until every pointer lifts", async () => {
  await open();
  await pointer("pointerdown", 100, 300, 1);
  await pointer("pointerdown", 300, 300, 2);
  await pointer("pointermove", 400, 300, 2);
  expect(scale()).toBe("150%");
  await pointer("pointerup", 400, 300, 2);
  await pointer("pointermove", 2000, 300, 1);
  expect(image().style.transform).toBe("translate(100px, 0px) scale(1.5)");
  await pointer("pointerup", 2000, 300, 1);
  await advance();
  expect(onClose).not.toHaveBeenCalled();
});

it("wheel zoom prevents page scrolling, stays within 1–5x and cancels pending taps", async () => {
  await open();
  await tap();
  const wheel = async (deltaY: number) => {
    const event = new WheelEvent("wheel", { deltaY, clientX: 200, clientY: 300, bubbles: true, cancelable: true });
    await act(async () => { stage().dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  };
  await wheel(-10000);
  expect(scale()).toBe("500%");
  await advance();
  expect(onClose).not.toHaveBeenCalled();
  await wheel(10000);
  expect(scale()).toBe("100%");
});

it.each([400, 768, 1280])("fits safely at %ipx and only dismisses a downward swipe on phones", async (viewportWidth) => {
  width = viewportWidth;
  await open();
  expect(parseFloat(image().style.width)).toBeLessThanOrEqual(width);
  expect(parseFloat(image().style.height)).toBeLessThanOrEqual(height);
  await pointer("pointerdown");
  await pointer("pointermove", 205, 450);
  expect(image().style.transform).toBe(`translate(0px, ${width < 640 ? 150 : 0}px) scale(1)`);
  await pointer("pointerup", 205, 450);
  await advance();
  expect(onClose).toHaveBeenCalledTimes(width < 640 ? 1 : 0);
});

it("springs a short swipe back, and pans instead of dismissing when zoomed", async () => {
  await open();
  await pointer("pointerdown");
  await pointer("pointermove", 200, 350);
  await pointer("pointerup", 200, 350);
  expect(image().style.transform).toBe("translate(0px, 0px) scale(1)");
  await doubleTap();
  await pointer("pointerdown");
  await pointer("pointermove", 200, 500);
  await pointer("pointerup", 200, 500);
  await advance();
  expect(onClose).not.toHaveBeenCalled();
});

it("plays video inline with native controls, ignores video taps, and pauses on backdrop close", async () => {
  await open({ video: true, save: false });
  const video = dialog().querySelector("video")!;
  expect(video.controls).toBe(true);
  expect(video.playsInline).toBe(true);
  expect(video.autoplay).toBe(true);
  video.focus();
  await press("Tab");
  expect(document.activeElement).toBe(dialog().querySelector('[aria-label="Close"]'));
  await press("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(video);
  await click(video);
  expect(onClose).not.toHaveBeenCalled();
  await click(stage());
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(video.pause).toHaveBeenCalledTimes(1);
});
