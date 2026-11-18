import type { ReactNode } from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";
import type { IconName } from "./icons/paths.js";

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger";

const SOFT: Record<BadgeTone, string> = {
  neutral: "bg-sunken text-ink-muted",
  brand: "bg-brand-soft text-on-brand-soft",
  success: "bg-ok-soft text-ok",
  warning: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
};

const SOLID: Record<BadgeTone, string> = {
  neutral: "bg-ink-muted text-surface",
  brand: "bg-brand text-on-brand",
  success: "bg-ok text-on-ok",
  warning: "bg-warn text-on-warn",
  danger: "bg-danger text-on-danger",
};

export interface BadgeProps {
  tone?: BadgeTone;
  variant?: "soft" | "solid";
  icon?: IconName;
  wrap?: boolean;
  className?: string;
  children: ReactNode;
}

/** Short status label. State is always carried by the text (and icon), never by colour alone. */
export function Badge({ tone = "neutral", variant = "soft", icon, wrap = false, className, children }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 text-[0.75rem] font-semibold",
        wrap ? "min-h-6 whitespace-normal [overflow-wrap:anywhere]" : "h-6 whitespace-nowrap",
        variant === "soft" ? SOFT[tone] : SOLID[tone],
        className,
      )}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

export interface CountBadgeProps {
  count: number;
  /** Counts above this show as "99+". */
  max?: number;
  /** Noun for screen readers, e.g. "unread messages". */
  label: string;
  /** Full pluralized announcement, when the caller knows the counted noun. */
  announcement?: string;
  className?: string;
}

/** Unread counter. Renders nothing at zero. */
export function CountBadge({ count, max = 99, label, announcement, className }: CountBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={announcement ?? `${count} ${label}`}
      className={cx(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[0.6875rem] font-bold tabular-nums text-on-brand",
        className,
      )}
    >
      <span aria-hidden="true">{count > max ? `${max}+` : count}</span>
    </span>
  );
}
