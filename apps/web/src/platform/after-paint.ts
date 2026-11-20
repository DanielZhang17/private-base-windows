/**
 * Runs `callback` once a frame has actually been rendered. requestAnimationFrame fires
 * before that frame paints, so the follow-up task runs after it. Returns a cancel function.
 */
export function afterPaint(callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = requestAnimationFrame(() => { timer = setTimeout(callback, 0); });
  return () => { cancelAnimationFrame(frame); if (timer !== undefined) clearTimeout(timer); };
}
