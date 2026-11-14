export function isNative(): boolean {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) return true;
  const { protocol, hostname } = window.location;
  return protocol === "tauri:" ||
    ((protocol === "http:" || protocol === "https:") && hostname === "tauri.localhost");
}

export function platformName(): "web" | "macos" | "windows" | "android" | "ios" {
  if (!isNative()) return "web";
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  // iPadOS can report a desktop Mac user agent.
  if (/iPad|iPhone|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
    return "ios";
  }
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "macos";
  return "web";
}
