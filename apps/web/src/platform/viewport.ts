import { isNative } from "./environment.js";

/** Native pages leave pinch handling to media gestures; browsers retain page zoom. */
export function configureNativeViewport(): void {
  if (!isNative()) return;
  let viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!viewport) {
    viewport = document.createElement("meta");
    viewport.name = "viewport";
    document.head.append(viewport);
  }
  viewport.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
  const root = document.getElementById("root");
  if (root) root.style.touchAction = "manipulation";
}
