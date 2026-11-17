import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";
import type { IconName } from "./icons/paths.js";
import { Spinner } from "./Spinner.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex min-w-0 items-center justify-center gap-2 rounded-control font-semibold select-none whitespace-normal [overflow-wrap:anywhere] " +
  "transition-[background-color,border-color,color,opacity] duration-[var(--duration-fast)] ease-standard " +
  "disabled:opacity-50 disabled:cursor-not-allowed aria-busy:cursor-progress cursor-pointer";

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand text-on-brand hover:not-disabled:bg-brand-hover",
  secondary: "bg-surface text-ink border border-line-strong hover:not-disabled:bg-sunken",
  ghost: "bg-transparent text-brand hover:not-disabled:bg-brand-soft hover:not-disabled:text-on-brand-soft",
  danger: "bg-danger text-on-danger hover:not-disabled:bg-danger-hover",
  "danger-ghost": "bg-transparent text-danger hover:not-disabled:bg-danger-soft",
};

/* sm grows to the 44px touch target on coarse pointers. */
const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3 text-[0.8125rem] pointer-coarse:min-h-11",
  md: "min-h-11 px-4 text-[0.9375rem]",
  lg: "min-h-12 px-5 text-base",
};

interface ButtonOwnProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and blocks clicks. The label stays for screen readers. */
  loading?: boolean;
  leadingIcon?: IconName;
  trailingIcon?: IconName;
  fullWidth?: boolean;
  children: ReactNode;
}

export interface ButtonAsButtonProps extends ButtonOwnProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  href?: undefined;
  ref?: Ref<HTMLButtonElement>;
}

/** With href the button renders a real link (<a>) with the same look. */
export interface ButtonAsLinkProps extends ButtonOwnProps, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> {
  href: string;
  download?: AnchorHTMLAttributes<HTMLAnchorElement>["download"];
  target?: string;
  /** Defaults to "noopener noreferrer" when target is "_blank". */
  rel?: string;
  ref?: Ref<HTMLAnchorElement>;
}

export type ButtonProps = ButtonAsButtonProps | ButtonAsLinkProps;

function ButtonContent({ loading, leadingIcon, trailingIcon, children }: Pick<ButtonOwnProps, "loading" | "leadingIcon" | "trailingIcon" | "children">) {
  return (
    <>
      {loading ? <Spinner size={18} label={null} /> : leadingIcon && <Icon name={leadingIcon} size={18} />}
      <span className="truncate">{children}</span>
      {trailingIcon && !loading && <Icon name={trailingIcon} size={18} />}
    </>
  );
}

export function Button(props: ButtonProps) {
  if (props.href !== undefined) {
    const {
      variant = "primary", size = "md", loading = false, leadingIcon, trailingIcon, fullWidth = false,
      className, children, href, target, rel, onClick, ...rest
    } = props;
    return (
      <a
        href={href}
        target={target}
        rel={rel ?? (target === "_blank" ? "noopener noreferrer" : undefined)}
        className={cx(BASE, "no-underline", BUTTON_VARIANTS[variant], SIZES[size], fullWidth && "w-full", loading && "pointer-events-none", className)}
        aria-busy={loading || undefined}
        aria-disabled={loading || undefined}
        onClick={(event) => {
          if (loading) { event.preventDefault(); return; }
          onClick?.(event);
        }}
        {...rest}
      >
        <ButtonContent loading={loading} leadingIcon={leadingIcon} trailingIcon={trailingIcon}>{children}</ButtonContent>
      </a>
    );
  }
  const {
    variant = "primary", size = "md", loading = false, leadingIcon, trailingIcon, fullWidth = false,
    className, disabled, type = "button", children, href: _href, ...rest
  } = props;
  return (
    <button
      type={type}
      className={cx(BASE, BUTTON_VARIANTS[variant], SIZES[size], fullWidth && "w-full", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      <ButtonContent loading={loading} leadingIcon={leadingIcon} trailingIcon={trailingIcon}>{children}</ButtonContent>
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  icon: IconName;
  /** Required accessible name; also shown as the tooltip. */
  label: string;
  variant?: "ghost" | "secondary" | "primary" | "danger" | "danger-ghost";
  /** md is 44px. sm is 36px and grows to 44px on touch devices. */
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

const ICON_SIZES = {
  sm: "size-9 pointer-coarse:size-11",
  md: "size-11",
  lg: "size-14",
} as const;

export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  loading = false,
  className,
  disabled,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        BASE,
        "rounded-full shrink-0",
        variant === "ghost" ? "bg-transparent text-ink-muted hover:not-disabled:bg-sunken hover:not-disabled:text-ink" : BUTTON_VARIANTS[variant],
        ICON_SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={18} label={null} /> : <Icon name={icon} size={size === "lg" ? 24 : 20} />}
    </button>
  );
}
