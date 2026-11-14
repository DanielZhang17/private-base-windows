import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCallPresentation } from "./useCallPresentation.js";
let root: Root; let view: ReturnType<typeof useCallPresentation>;
function Probe() { view = useCallPresentation(true, true); return null; }
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); root = createRoot(document.createElement("div")); });
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("fades phone video controls on idle and restores them on input", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  await act(async () => root.render(<Probe />));
  await act(async () => vi.advanceTimersByTime(4000));
  expect(view.controlsVisible).toBe(false);
  await act(async () => view.showControls());
  expect(view.controlsVisible).toBe(true);
});
it("keeps desktop controls available and offers a keyboard alternative for moving the preview", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  await act(async () => root.render(<Probe />));
  await act(async () => vi.advanceTimersByTime(10000));
  expect(view.controlsVisible).toBe(true);
  await act(async () => view.cycleCorner());
  expect(view.corner).toBe("bottom-start");
  await act(async () => view.movePreview(window.innerWidth, 0));
  expect(view.corner).toBe("top-end");
});
