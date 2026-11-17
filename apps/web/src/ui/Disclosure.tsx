import { useState, type ReactNode } from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";

export interface DisclosureProps {
  /** Always-visible label of the 44px summary row. */
  summary: ReactNode;
  /** Content shown when open. */
  children: ReactNode;
  /** Initial state. The disclosure is closed by default. */
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  className?: string;
  /** Classes for the summary row, e.g. to extend it to the card edge. */
  summaryClassName?: string;
}

/**
 * Show/hide section built on native <details>/<summary>: keyboard, screen reader
 * and find-in-page behaviour come from the browser. The chevron turns 180° when open.
 */
export function Disclosure({ summary, children, defaultOpen = false, onToggle, className, summaryClassName }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className={cx("group/disclosure", className)}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        onToggle?.(next);
      }}
    >
      <summary
        className={cx(
          "flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-control",
          "text-[0.8125rem] font-semibold text-brand [&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        <span className="min-w-0">{summary}</span>
        <Icon
          name="chevron-down"
          size={18}
          className="transition-transform duration-[var(--duration-fast)] ease-standard group-open/disclosure:rotate-180"
        />
      </summary>
      {children}
    </details>
  );
}
