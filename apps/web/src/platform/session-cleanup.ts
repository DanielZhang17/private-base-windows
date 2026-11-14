// Dependency-free bridge: authStore must not import the stores used by session cleanup.
let cleanup: (() => void) | undefined;

export function registerAccountScopedCleanup(callback: () => void): void {
  cleanup = callback;
}

export function clearRegisteredAccountState(): void {
  cleanup?.();
}
