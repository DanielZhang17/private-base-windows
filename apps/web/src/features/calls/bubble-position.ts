export interface Point { x: number; y: number }
export interface Bounds { width: number; height: number }

/** Positions are relative to the usable rectangle, excluding app controls. */
export function clampBubble(position: Point, bubble: Bounds, viewport: Bounds): Point {
  return {
    x: Math.max(0, Math.min(position.x, Math.max(0, viewport.width - bubble.width))),
    y: Math.max(0, Math.min(position.y, Math.max(0, viewport.height - bubble.height))),
  };
}

export function snapBubble(position: Point, bubble: Bounds, viewport: Bounds): Point {
  const clamped = clampBubble(position, bubble, viewport);
  const right = Math.max(0, viewport.width - bubble.width);
  return { x: clamped.x < right / 2 ? 0 : right, y: clamped.y };
}

export interface Rectangle { left: number; top: number; right: number; bottom: number }
export interface AvoidZone extends Rectangle { edge: "top" | "bottom" | "left" | "right" }

/** One usable rectangle: the message area (when present), minus visible control strips. */
export function getBubbleArea(viewport: Rectangle, zones: AvoidZone[], messageArea?: Rectangle, gap = 16): Rectangle {
  const area = { ...viewport };
  if (messageArea) {
    area.left = Math.min(viewport.right, Math.max(area.left, messageArea.left + gap));
    area.right = Math.max(area.left, Math.min(area.right, messageArea.right - gap));
    area.top = Math.min(viewport.bottom, Math.max(area.top, messageArea.top + gap));
    area.bottom = Math.max(area.top, Math.min(area.bottom, messageArea.bottom - gap));
  }
  for (const zone of zones) {
    if (zone.right <= zone.left || zone.bottom <= zone.top || zone.right <= area.left ||
        zone.left >= area.right || zone.bottom <= area.top || zone.top >= area.bottom) continue;
    if (zone.edge === "top") area.top = Math.min(area.bottom, Math.max(area.top, zone.bottom + gap));
    if (zone.edge === "bottom") area.bottom = Math.max(area.top, Math.min(area.bottom, zone.top - gap));
    if (zone.edge === "left") area.left = Math.min(area.right, Math.max(area.left, zone.right + gap));
    if (zone.edge === "right") area.right = Math.max(area.left, Math.min(area.right, zone.left - gap));
  }
  return area;
}
