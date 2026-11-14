import { t, useLocale } from "../i18n/index.js";
import { cx } from "./cx.js";

export interface SpinnerProps {
  /** Pixel diameter. Defaults to 20. */
  size?: number;
  /** Announced to screen readers. Pass null when a parent already announces the busy state. */
  label?: string | null;
  className?: string;
}

export function Spinner({ size = 20, label = t("loadingStatus"), className }: SpinnerProps) {
  useLocale();
  return (
    <span
      className={cx("inline-flex", className)}
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
    >
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        className="animate-ui-spin motion-reduce:animate-ui-pulse"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.22" />
        <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export interface SkeletonProps {
  /** "text" is a single line, "circle" an avatar, "block" a free rectangle sized by className. */
  shape?: "text" | "circle" | "block";
  className?: string;
}

/** Placeholder for content that is loading. Decorative; put aria-busy on the region that owns it. */
export function Skeleton({ shape = "text", className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "block bg-line animate-ui-pulse",
        shape === "text" && "h-3.5 rounded-full",
        shape === "circle" && "size-11 rounded-full",
        shape === "block" && "rounded-card",
        className,
      )}
    />
  );
}
