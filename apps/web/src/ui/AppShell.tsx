import { t, useLocale } from "../i18n/index.js";
import type { MouseEventHandler, ReactNode } from "react";
import { IconButton } from "./Button.js";
import { CountBadge } from "./Badge.js";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";
import type { IconName } from "./icons/paths.js";

export interface AppShellProps {
  /** List pane: the chat list with its own TopBar. */
  list: ReactNode;
  /** Detail pane: conversation, settings, devices. Omit to show `placeholder` on wide screens. */
  detail?: ReactNode;
  /**
   * Phones show one pane at a time: the detail pane when true, the list otherwise.
   * Tablet and desktop always show both. Defaults to whether `detail` is set.
   */
  detailActive?: boolean;
  /** Shown in the detail pane on wide screens when nothing is open. */
  placeholder?: ReactNode;
  /** Navigation under the list pane on phone and tablet (a BottomBar). Hidden while a detail is open on phones. */
  bottomBar?: ReactNode;
  /** Navigation rail at the start edge on desktop (a NavRail). When set, the bottom bar is hidden on desktop. */
  rail?: ReactNode;
  /** Full-width strip above both panes: offline, reconnecting, update available. */
  banner?: ReactNode;
  className?: string;
}

/**
 * Responsive frame. <640px: one pane. ≥640px: list + detail. ≥1024px: optional rail + list + detail.
 * Handles left/right safe-area insets and the native title-bar strip; TopBar and BottomBar
 * handle top and bottom insets.
 */
export function AppShell({ list, detail, detailActive = detail != null, placeholder, bottomBar, rail, banner, className }: AppShellProps) {
  useLocale();
  return (
    <div className={cx("flex h-dvh flex-col overflow-clip bg-canvas text-ink px-safe", className)}>
      <div
        data-tauri-drag-region=""
        aria-hidden="true"
        className="drag-region h-[var(--titlebar-height)] shrink-0 bg-canvas"
      />
      {banner}
      <div className="flex min-h-0 grow">
        {rail && <div className="hidden lg:flex">{rail}</div>}
        <aside
          aria-label={t("conversations")}
          className={cx(
            "min-w-0 w-full flex-col bg-canvas sm:flex sm:w-72 sm:shrink-0 sm:border-e sm:border-line lg:w-80",
            detailActive ? "hidden" : "flex",
          )}
        >
          <div className="flex min-h-0 grow flex-col">{list}</div>
          {bottomBar && <div className={rail ? "lg:hidden" : undefined}>{bottomBar}</div>}
        </aside>
        <main className={cx("min-w-0 grow flex-col bg-surface sm:flex", detailActive ? "flex" : "hidden")}>
          {detail ?? placeholder}
        </main>
      </div>
    </div>
  );
}

export interface TopBarProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Shows a back button with this handler. Hidden from `sm` up when `backOnPhoneOnly` is set. */
  onBack?: () => void;
  backLabel?: string;
  /** For detail panes in the two-pane layout, where the list is already visible on wide screens. */
  backOnPhoneOnly?: boolean;
  /** Avatar or icon before the title. */
  leading?: ReactNode;
  /** IconButtons at the end. Keep to three; put the rest in a Sheet. */
  actions?: ReactNode;
  /** Makes the title block a button, e.g. to open conversation details. */
  onTitleClick?: () => void;
  className?: string;
}

/** Header for a pane or page. Adds the top safe-area inset. */
export function TopBar({ title, subtitle, onBack, backLabel = t("back"), backOnPhoneOnly = false, leading, actions, onTitleClick, className }: TopBarProps) {
  useLocale();
  const titleBlock = (
    <>
      {leading && <span className="flex shrink-0">{leading}</span>}
      <span className="flex min-w-0 flex-col text-start">
        <span className="truncate text-[1.0625rem] leading-tight font-semibold">{title}</span>
        {subtitle && <span className="truncate text-[0.75rem] leading-tight text-ink-muted">{subtitle}</span>}
      </span>
    </>
  );
  return (
    <header className={cx("shrink-0 border-b border-line bg-inherit pt-safe", className)}>
      <div className="flex h-14 items-center gap-1 px-2">
        {onBack && (
          <IconButton icon="chevron-left" label={backLabel} onClick={onBack} className={backOnPhoneOnly ? "sm:hidden" : undefined} />
        )}
        {onTitleClick ? (
          <button type="button" onClick={onTitleClick} className="flex min-w-0 grow items-center gap-3 self-stretch rounded-control px-2 cursor-pointer hover:bg-sunken">
            {titleBlock}
          </button>
        ) : (
          <div className="flex min-w-0 grow items-center gap-3 px-2">
            <h1 className="contents">{titleBlock}</h1>
          </div>
        )}
        {actions && <div className="flex shrink-0 items-center">{actions}</div>}
      </div>
    </header>
  );
}

export interface NavItemProps {
  icon: IconName;
  label: string;
  active?: boolean;
  /** Unread count shown on the icon. */
  count?: number;
  href?: string;
  onClick?: MouseEventHandler<HTMLElement>;
}

/** One destination inside a BottomBar or NavRail. */
export function NavItem({ icon, label, active = false, count = 0, href, onClick }: NavItemProps) {
  useLocale();
  const className = cx(
    "relative flex min-h-12 min-w-16 grow flex-col items-center justify-center gap-0.5 rounded-control px-2 py-1.5 text-[0.6875rem] font-semibold cursor-pointer",
    "transition-colors duration-[var(--duration-fast)]",
    active ? "text-brand" : "text-ink-muted hover:text-ink",
  );
  const content = (
    <>
      <span className={cx("relative flex h-7 w-12 items-center justify-center rounded-full", active && "bg-brand-soft text-on-brand-soft")}>
        <Icon name={icon} size={22} />
        {count > 0 && <CountBadge count={count} label={t("unread")} announcement={t("unreadBadgeCount", { count: count })} className="absolute -top-1 end-0" />}
      </span>
      <span>{label}</span>
    </>
  );
  return href ? (
    <a href={href} onClick={onClick} className={className} aria-current={active ? "page" : undefined}>{content}</a>
  ) : (
    <button type="button" onClick={onClick} className={className} aria-current={active ? "page" : undefined}>{content}</button>
  );
}

export interface BottomBarProps {
  /** Accessible name for the navigation landmark. */
  label?: string;
  children: ReactNode;
  className?: string;
}

/** Bottom navigation for phone and tablet. Adds the bottom safe-area inset (home indicator, gesture bar). */
export function BottomBar({ label = t("mainNavigation"), children, className }: BottomBarProps) {
  useLocale();
  return (
    <nav aria-label={label} className={cx("shrink-0 border-t border-line bg-canvas pb-safe", className)}>
      <div className="flex items-stretch gap-1 px-2 py-1">{children}</div>
    </nav>
  );
}

export interface NavRailProps {
  label?: string;
  children: ReactNode;
  /** Pinned to the bottom of the rail: the signed-in user's avatar. */
  footer?: ReactNode;
  className?: string;
}

/** Vertical navigation for desktop. */
export function NavRail({ label = t("mainNavigation"), children, footer, className }: NavRailProps) {
  useLocale();
  return (
    <nav aria-label={label} className={cx("flex w-[4.5rem] shrink-0 flex-col items-center gap-1 border-e border-line bg-canvas px-1 py-2", className)}>
      <div className="flex grow flex-col gap-1 [&>*]:grow-0">{children}</div>
      {footer}
    </nav>
  );
}
