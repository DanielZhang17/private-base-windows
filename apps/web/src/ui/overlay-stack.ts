// Keep these ranks aligned with the z-order in docs/design/ui-spec.md.
export const OVERLAY_RANK = {
  dialog: 50,
  incomingCall: 70,
  mediaViewer: 80,
} as const;

export type Overlay = ({ kind: "viewer"; id: string } | { kind: "modal" }) & { rank: number };

const stack: Overlay[] = [];
const listeners = new Set<(top: Overlay | undefined) => void>();

export function getTopOverlay(): Overlay | undefined {
  return stack.at(-1);
}

export function subscribeToTopOverlay(listener: (top: Overlay | undefined) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function registerOverlay(overlay: Overlay): () => void {
  stack.push(overlay);
  // Stable sorting keeps later registrations above earlier ones of the same rank.
  stack.sort((first, second) => first.rank - second.rank);
  if (getTopOverlay() === overlay) listeners.forEach((listener) => listener(overlay));
  return () => {
    const index = stack.indexOf(overlay);
    stack.splice(index, 1);
    if (index === stack.length) listeners.forEach((listener) => listener(getTopOverlay()));
  };
}
