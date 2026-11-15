export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Zoom extends Point { scale: number }
export interface Tap extends Point { time: number; scale: number }

export const INITIAL_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };
export const DOUBLE_TAP_MS = 250;
export const TAP_SLOP = 8;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function fitMedia(media: Size, viewport: Size): Size {
  if (!media.width || !media.height) return { width: 0, height: 0 };
  const ratio = Math.min(viewport.width / media.width, viewport.height / media.height);
  return { width: media.width * ratio, height: media.height * ratio };
}

/** Translation is relative to the centre of the contained, untransformed image. */
export function clampZoom(zoom: Zoom, media: Size, viewport: Size): Zoom {
  const scale = clamp(zoom.scale, 1, 5);
  const maxX = Math.max(0, (media.width * scale - viewport.width) / 2);
  const maxY = Math.max(0, (media.height * scale - viewport.height) / 2);
  return { scale, x: maxX ? clamp(zoom.x, -maxX, maxX) : 0, y: maxY ? clamp(zoom.y, -maxY, maxY) : 0 };
}

/** Keep the image coordinate under the focal point stationary, until an edge clamps. */
export function zoomAt(zoom: Zoom, scale: number, focal: Point, media: Size, viewport: Size): Zoom {
  const nextScale = clamp(scale, 1, 5);
  const ratio = nextScale / zoom.scale;
  return clampZoom({ scale: nextScale, x: focal.x - (focal.x - zoom.x) * ratio, y: focal.y - (focal.y - zoom.y) * ratio }, media, viewport);
}

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function classifyTap(tap: Tap, previous: Tap | null, movement: number, duration: number, pinched: boolean): "none" | "single" | "double" {
  if (pinched || movement > TAP_SLOP || duration > 500) return "none";
  return previous && tap.time - previous.time <= DOUBLE_TAP_MS && distance(tap, previous) <= 32 ? "double" : "single";
}
