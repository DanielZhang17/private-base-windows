import { describe, expect, it } from "vitest";
import { clamp, clampZoom, classifyTap, fitMedia, INITIAL_ZOOM, zoomAt, type Tap } from "./media-gestures.js";

it("clamps numeric values and zoom to 1–5x", () => {
  expect(clamp(-2, 1, 5)).toBe(1);
  expect(clamp(9, 1, 5)).toBe(5);
  expect(clamp(3, 1, 5)).toBe(3);
  expect(clampZoom({ scale: 8, x: 999, y: -999 }, { width: 100, height: 100 }, { width: 100, height: 100 })).toEqual({ scale: 5, x: 200, y: -200 });
});

describe.each([400, 768, 1280])("%ipx viewport", (width) => {
  const viewport = { width, height: 700 };
  it.each([{ width: 2000, height: 1000 }, { width: 500, height: 2000 }])("fits and clamps a $width × $height image", (natural) => {
    const media = fitMedia(natural, viewport);
    expect(media.width).toBeLessThanOrEqual(width);
    expect(media.height).toBeLessThanOrEqual(700);
    expect(clampZoom({ scale: 1, x: 500, y: -500 }, media, viewport)).toEqual(INITIAL_ZOOM);
    const zoom = clampZoom({ scale: 2.5, x: 9999, y: -9999 }, media, viewport);
    expect(zoom.x).toBe(Math.max(0, (media.width * 2.5 - width) / 2));
    expect(Math.abs(zoom.y)).toBe(Math.max(0, (media.height * 2.5 - 700) / 2));
  });
});

it("preserves the image coordinate at the focal point while zooming", () => {
  const size = { width: 400, height: 400 };
  const zoom = zoomAt(INITIAL_ZOOM, 2.5, { x: 100, y: -50 }, size, size);
  expect(zoom).toEqual({ scale: 2.5, x: -150, y: 75 });
  expect((100 - zoom.x) / zoom.scale).toBe(100);
  expect((-50 - zoom.y) / zoom.scale).toBe(-50);
  expect(zoomAt(zoom, 1, { x: 100, y: -50 }, size, size)).toEqual(INITIAL_ZOOM);
});

it("handles unloaded media without invalid coordinates", () => {
  expect(fitMedia({ width: 0, height: 0 }, { width: 400, height: 700 })).toEqual({ width: 0, height: 0 });
});

const tap: Tap = { x: 100, y: 100, time: 1000, scale: 1 };
it("classifies nearby taps within 250ms as a double tap", () => {
  expect(classifyTap(tap, null, 2, 100, false)).toBe("single");
  expect(classifyTap({ ...tap, time: 1250, x: 110 }, tap, 0, 100, false)).toBe("double");
  expect(classifyTap({ ...tap, time: 1251 }, tap, 0, 100, false)).toBe("single");
  expect(classifyTap({ ...tap, x: 200 }, tap, 0, 100, false)).toBe("single");
});

it.each([[9, 100, false], [0, 501, false], [0, 100, true]] as const)("never classifies a drag, long press or pinch as a tap", (movement, duration, pinched) => {
  expect(classifyTap(tap, null, movement, duration, pinched)).toBe("none");
});
