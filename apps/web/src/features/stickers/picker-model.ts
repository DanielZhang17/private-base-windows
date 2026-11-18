export const COLUMNS = 4;
export const TAP_TOLERANCE = 8;

export function withinTap(start: { x: number; y: number }, x: number, y: number): boolean {
  return Math.hypot(x - start.x, y - start.y) < TAP_TOLERANCE;
}

export function allowStickerSend(last: number | undefined, at: number): boolean {
  return last === undefined || at - last >= 400;
}

export function pageOffset(page: number, width: number, rtl: boolean): number {
  return page * width * (rtl ? -1 : 1);
}

export function pageAt(offset: number, width: number, count: number): number {
  return width ? Math.min(count - 1, Math.round(Math.abs(offset) / width)) : 0;
}

export function directionStep(key: string, rtl: boolean): number {
  return key === "ArrowRight" ? (rtl ? -1 : 1) : key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
}

export function tabTarget(key: string, index: number, length: number, rtl: boolean): number | undefined {
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  const step = directionStep(key, rtl);
  if (step) return (index + step + length) % length;
}

export function gridTarget(key: string, index: number, length: number, rtl: boolean, ctrl = false) {
  const col = index % COLUMNS;
  const rowStart = index - col;
  const last = length - 1;
  const step = directionStep(key, rtl);
  if (step === 1 && (col === COLUMNS - 1 || index === last)) return { page: 1, index: rowStart };
  if (step === -1 && col === 0) return { page: -1, index: rowStart + COLUMNS - 1 };
  if (step) return { page: 0, index: index + step };
  if (key === "ArrowUp") return { page: 0, index: index - COLUMNS };
  if (key === "ArrowDown") return { page: 0, index: Math.min(last, index + COLUMNS) };
  if (key === "Home") return { page: 0, index: ctrl ? 0 : rowStart };
  if (key === "End") return { page: 0, index: ctrl ? last : Math.min(last, rowStart + COLUMNS - 1) };
  if (key === "PageUp" || key === "PageDown") return { page: key === "PageDown" ? 1 : -1, index: 0 };
}

export function keyboardHeight(baseline: number, inner: number, visual = inner, offset = 0): number {
  return Math.max(0, baseline - inner, inner - visual - offset);
}

export function panelHeight(viewport: number, landscape: boolean, measured?: number): number {
  const maximum = landscape ? viewport * .45 : Math.min(400, viewport * .5);
  return Math.min(maximum, Math.max(landscape ? 180 : 260, measured ?? (landscape ? 200 : 320)));
}
