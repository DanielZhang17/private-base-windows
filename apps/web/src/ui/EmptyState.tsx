import type { ReactNode } from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";
import type { IconName } from "./icons/paths.js";

export interface EmptyStateProps {
  icon?: IconName;
  title: ReactNode;
  /** One or two sentences saying what will appear here and how to start. */
  description?: ReactNode;
  /** Usually one primary Button. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cx("flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center", className)}>
      {icon && (
        <span className="flex size-14 items-center justify-center rounded-full bg-brand-soft text-on-brand-soft">
          <Icon name={icon} size={26} />
        </span>
      )}
      <h2 className="text-[1.125rem] font-semibold text-balance">{title}</h2>
      {description && <p className="max-w-xs text-ink-muted text-pretty">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
