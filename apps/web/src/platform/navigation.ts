import type { NavigateFunction } from "react-router-dom";

let routerNavigate: NavigateFunction | undefined;

export function registerNavigate(navigate: NavigateFunction): () => void {
  routerNavigate = navigate;
  return () => {
    if (routerNavigate === navigate) routerNavigate = undefined;
  };
}

/** Use the mounted router; startup calls fall back to a normal same-origin navigation. */
export function navigate(path: string): void {
  if (routerNavigate) {
    void routerNavigate(path);
  } else {
    window.location.href = path;
  }
}
