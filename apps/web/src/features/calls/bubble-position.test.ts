import { describe, expect, it } from "vitest";
import { clampBubble, snapBubble, getBubbleArea } from "./bubble-position.js";

const bubble = { width: 176, height: 208 };
const viewport = { width: 368, height: 640 };
describe("call bubble placement within the safe viewport", () => {
  it("clamps dragging beyond every edge", () => {
    expect(clampBubble({ x: -50, y: -100 }, bubble, viewport)).toEqual({ x: 0, y: 0 });
    expect(clampBubble({ x: 999, y: 999 }, bubble, viewport)).toEqual({ x: 192, y: 432 });
    expect(clampBubble({ x: 83, y: 200 }, bubble, viewport)).toEqual({ x: 83, y: 200 });
  });
  it("snaps to the nearest horizontal edge, retaining the clamped height", () => {
    expect(snapBubble({ x: 90, y: 200 }, bubble, viewport)).toEqual({ x: 0, y: 200 });
    expect(snapBubble({ x: 100, y: 999 }, bubble, viewport)).toEqual({ x: 192, y: 432 });
    expect(snapBubble({ x: 96, y: -10 }, bubble, viewport)).toEqual({ x: 192, y: 0 });
  });
  it("stays within a smaller or rotated viewport", () => {
    expect(snapBubble({ x: 192, y: 432 }, bubble, { width: 300, height: 260 })).toEqual({ x: 124, y: 52 });
    expect(clampBubble({ x: 200, y: 400 }, bubble, { width: 100, height: 100 })).toEqual({ x: 0, y: 0 });
  });
});


describe("call bubble avoid zones", () => {
  it("excludes top actions, composer and bottom navigation from clamping and snapping", () => {
    const area = getBubbleArea({ left: 16, top: 16, right: 384, bottom: 804 }, [
      { edge: "top", left: 0, top: 0, right: 400, bottom: 72 },
      { edge: "bottom", left: 0, top: 750, right: 400, bottom: 820 },
      { edge: "bottom", left: 0, top: 650, right: 400, bottom: 750 },
    ]);
    expect(area).toEqual({ left: 16, top: 88, right: 384, bottom: 634 });
    const bounds = { width: area.right - area.left, height: area.bottom - area.top };
    for (const place of [clampBubble, snapBubble]) {
      const position = place({ x: 999, y: 999 }, bubble, bounds);
      expect(area.left + position.x + bubble.width).toBeLessThanOrEqual(area.right);
      expect(area.top + position.y + bubble.height).toBeLessThanOrEqual(634);
      expect(area.top + position.y).toBeGreaterThanOrEqual(88);
    }
  });
  it("restricts desktop placement to the message pane and excludes the navigation rail", () => {
    expect(getBubbleArea({ left: 16, top: 16, right: 1264, bottom: 804 }, [
      { edge: "left", left: 0, top: 0, right: 72, bottom: 820 },
    ], { left: 392, top: 56, right: 1280, bottom: 758 }))
      .toEqual({ left: 408, top: 72, right: 1264, bottom: 742 });
  });
  it("shrinks the allowed area for a growing composer and keyboard", () => {
    const viewport = { left: 16, top: 16, right: 384, bottom: 484 };
    const zone = { edge: "bottom" as const, left: 0, top: 400, right: 400, bottom: 500 };
    expect(getBubbleArea(viewport, [zone]).bottom).toBe(384);
    expect(getBubbleArea(viewport, [{ ...zone, top: 320 }]).bottom).toBe(304);
    expect(getBubbleArea(viewport, [{ edge: "top", left: 0, top: 0, right: 0, bottom: 0 }])).toEqual(viewport);
  });
});
