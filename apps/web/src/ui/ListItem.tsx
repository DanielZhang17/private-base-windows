import type { MouseEventHandler, ReactNode } from "react";
import { cx } from "./cx.js";

export interface ListItemProps {
  /** Avatar or icon at the start. */
  leading?: ReactNode;
  title: ReactNode;
  /** Second line: last message, device details. Truncates to one line. */
  subtitle?: ReactNode;
  /** Small text at the top of the end column, usually a time. */
  meta?: ReactNode;
  /** Badge, chevron, or control at the end. Controls here stay separately clickable. */
  trailing?: ReactNode;
  /** Marks the row for the open conversation or current section. */
  selected?: boolean;
  /** Makes the row a button. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Makes the row a link. Takes precedence over onClick. */
  href?: string;
  disabled?: boolean;
  /** Use for destructive rows such as "Delete account". */
  tone?: "default" | "danger";
  className?: string;
}

/** One row in a list. Wrap rows in <ul role="list"> with each inside an <li>. */
export function ListItem({ leading, title, subtitle, meta, trailing, selected = false, onClick, href, disabled, tone = "default", className }: ListItemProps) {
  const interactive = Boolean(href || onClick);
  const main = (
    <>
      {leading && <span className="flex shrink-0 items-center">{leading}</span>}
      <span className="flex min-w-0 grow flex-col text-start">
        <span className={cx("truncate font-semibold", tone === "danger" ? "text-danger" : "text-ink")}>{title}</span>
        {subtitle && <span className="truncate text-[0.8125rem] text-ink-muted">{subtitle}</span>}
      </span>
    </>
  );
  const mainClass = cx(
    "flex min-w-0 grow items-center gap-3 self-stretch px-3 py-2 rounded-control",
    interactive && "cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
  );

  return (
    <div
      data-selected={selected || undefined}
      className={cx(
        "flex min-h-14 items-center rounded-control transition-colors duration-[var(--duration-fast)]",
        selected ? "bg-brand-soft" : interactive && "hover:bg-sunken",
        className,
      )}
    >
      {href ? (
        <a href={href} className={mainClass} aria-current={selected ? "page" : undefined}>{main}</a>
      ) : onClick ? (
        <button type="button" className={mainClass} onClick={onClick} disabled={disabled} aria-current={selected ? "true" : undefined}>{main}</button>
      ) : (
        <div className={mainClass}>{main}</div>
      )}
      {(meta || trailing) && (
        <span className="flex shrink-0 flex-col items-end justify-center gap-1 pe-3 ps-1">
          {meta && <span className="text-[0.75rem] text-ink-subtle tabular-nums">{meta}</span>}
          {trailing}
        </span>
      )}
    </div>
  );
}
