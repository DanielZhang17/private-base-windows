import { useSyncExternalStore } from "react";

let now = Date.now();
let intervalId: number | null = null;
const listeners = new Set<() => void>();

function emit() {
  now = Date.now();
  for (const listener of listeners) {
    listener();
  }
}

function ensureTicker() {
  if (intervalId !== null || listeners.size === 0) return;
  now = Date.now();
  intervalId = window.setInterval(() => emit(), 1000);
}

function cleanupTicker() {
  if (listeners.size > 0 || intervalId === null) return;
  window.clearInterval(intervalId);
  intervalId = null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  ensureTicker();
  return () => {
    listeners.delete(listener);
    cleanupTicker();
  };
}

function getSnapshot() {
  return now;
}

export function useSecondTicker(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => Date.now());
}
