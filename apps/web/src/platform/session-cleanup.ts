// Dependency-free bridge: authStore must not import the stores used by session cleanup.
let cleanup: (() => void) | undefined;

export function registerAccountScopedCleanup(callback: () => void): void {
  cleanup = callback;
}

export function clearRegisteredAccountState(): void {
  cleanup?.();
}

// A separate, tab-local bridge lets key locking stop calls without clearing chat drafts.
let callCleanup: (() => void) | undefined;
export function registerLocalCallCleanup(callback: () => void): void {
  callCleanup = callback;
}
export function clearRegisteredLocalCallState(): void {
  clearUnlockedSessionState();
  callCleanup?.();
}

const unlockedCleanups = new Set<() => void>();
export function registerUnlockedSessionCleanup(callback: () => void): () => void {
  unlockedCleanups.add(callback);
  return () => { unlockedCleanups.delete(callback); };
}
export function clearUnlockedSessionState(): void {
  for (const callback of [...unlockedCleanups]) callback();
}
