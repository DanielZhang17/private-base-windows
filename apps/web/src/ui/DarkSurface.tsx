import type { HTMLAttributes } from "react";
import { cx } from "./cx.js";
import "./DarkSurface.css";

/** A dark layer, independent of the app's theme preference. */
export function DarkSurface({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section {...props} data-theme="dark" className={cx("ui-dark-surface", className)} />;
}
