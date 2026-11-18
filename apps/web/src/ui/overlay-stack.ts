// Keep these ranks aligned with the z-order in docs/design/ui-spec.md.
export const OVERLAY_RANK = {
  picker: 40,
  actionMenu: 45,
  dialog: 50,
  incomingCall: 70,
  mediaViewer: 80,
} as const;

export type Overlay = ({ kind: "viewer"; id: string } | { kind: "modal" | "popover" }) & { rank: number; onBack?: () => void; dismissOnBack?: boolean };

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
  if (overlay.dismissOnBack) syncCloseWatcher();
  if (getTopOverlay() === overlay) listeners.forEach((listener) => listener(overlay));
  return () => {
    const index = stack.indexOf(overlay);
    if (index < 0) return;
    stack.splice(index, 1);
    if (overlay.dismissOnBack || index === stack.length) syncCloseWatcher();
    if (index === stack.length) listeners.forEach((listener) => listener(getTopOverlay()));
  };
}

type CloseWatcher = EventTarget & { destroy(): void };
let closeWatcher: CloseWatcher | undefined;
let openAtIndex: number | undefined;
let canArmFirstEntry = false;
let firstEntryToken: string | undefined;
let retiringEntry = false;
let pendingNavigation: (() => void) | undefined;

function isOverlayEntry(state: { privateBaseOverlay?: string; messageActionMenu?: string } | null) {
  return !!(state?.privateBaseOverlay || state?.messageActionMenu);
}

function retireOverlayEntry() {
  if (retiringEntry || !isOverlayEntry(history.state)) return;
  if (!firstEntryToken) canArmFirstEntry = false;
  retiringEntry = true;
  history.back();
}

function syncCloseWatcher() {
  if (!stack.some((layer) => layer.dismissOnBack)) {
    closeWatcher?.destroy();
    closeWatcher = undefined;
    openAtIndex = undefined;
    if (firstEntryToken) retireOverlayEntry();
    return;
  }
  openAtIndex ??= history.state?.idx;
  const Watcher = (window as Window & { CloseWatcher?: new () => CloseWatcher }).CloseWatcher;
  if (!Watcher) {
    // A direct first entry has no app route behind it to intercept on Back.
    // Only arm it before a real traversal, when no real Forward entries can be lost.
    if (canArmFirstEntry && openAtIndex === 0 && !retiringEntry && !firstEntryToken) {
      firstEntryToken = crypto.randomUUID();
      history.pushState({ ...history.state, privateBaseOverlay: firstEntryToken }, "");
    }
    return;
  }
  if (closeWatcher) return;
  closeWatcher = new Watcher();
  closeWatcher.addEventListener("close", () => {
    closeWatcher = undefined;
    getTopOverlay()?.onBack?.();
    syncCloseWatcher();
  }, { once: true });
}

function dismissPhoneOverlays() {
  for (const layer of [...stack].reverse()) if (layer.dismissOnBack) layer.onBack?.();
}

export function navigatePastOverlays(navigate: () => void) {
  retireOverlayEntry();
  dismissPhoneOverlays();
  if (retiringEntry) pendingNavigation = navigate;
  else navigate();
}

export function watchOverlayHistory() {
  const arrival = window.performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  canArmFirstEntry = history.length === 1 || arrival?.type === "navigate";
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) canArmFirstEntry = false; };
  function onPop(event: PopStateEvent) {
    if (firstEntryToken && event.state?.privateBaseOverlay === firstEntryToken) return;
    if (isOverlayEntry(event.state)) {
      retireOverlayEntry();
      event.stopImmediatePropagation();
      return;
    }
    if (retiringEntry || firstEntryToken) {
      const closeLayer = !retiringEntry && !!firstEntryToken;
      retiringEntry = false;
      firstEntryToken = undefined;
      const navigate = pendingNavigation;
      pendingNavigation = undefined;
      if (closeLayer) getTopOverlay()?.onBack?.();
      else queueMicrotask(navigate ?? syncCloseWatcher);
      return;
    }
    canArmFirstEntry = false;
    if (openAtIndex === undefined) return;
    const target: number | undefined = event.state?.idx;
    if (typeof target === "number" && target < openAtIndex) {
      // Keep the router on the current view and return to its existing entry.
      const delta = openAtIndex - target;
      event.stopImmediatePropagation();
      getTopOverlay()?.onBack?.();
      history.go(delta);
    } else if (target !== openAtIndex) dismissPhoneOverlays();
  }
  window.addEventListener("popstate", onPop, true);
  window.addEventListener("pageshow", onPageShow);
  if (!firstEntryToken) retireOverlayEntry();
  if (!retiringEntry) syncCloseWatcher();
  return () => {
    window.removeEventListener("popstate", onPop, true);
    window.removeEventListener("pageshow", onPageShow);
    canArmFirstEntry = false;
  };
}
