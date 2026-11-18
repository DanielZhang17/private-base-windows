import type { NavigateFunction, NavigateOptions } from "react-router-dom";

let routerNavigate: NavigateFunction | undefined;

export function registerNavigate(navigate: NavigateFunction): () => void {
  routerNavigate = navigate;
  return () => {
    if (routerNavigate === navigate) routerNavigate = undefined;
  };
}

/** Use the mounted router; startup calls fall back to a normal same-origin navigation. */
export function navigate(path: string, options?: NavigateOptions): void {
  if (routerNavigate) {
    if (options) void routerNavigate(path, options);
    else void routerNavigate(path);
  } else {
    window.location.href = path;
  }
}
