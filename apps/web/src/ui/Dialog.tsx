import { t, useLocale } from "../i18n/index.js";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton } from "./Button.js";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";
import type { IconName } from "./icons/paths.js";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

let openOverlays = 0;
let previousOverflow = "";
const overlayStack: HTMLElement[] = [];

interface OverlayProps {
  open: boolean;
  /** Called on Esc, scrim click and the close button. Not called while `dismissible` is false. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** When false, Esc and the scrim do nothing and no close button is shown: the user must pick an action. */
  dismissible?: boolean;
  /** Element to focus on open. Defaults to the first focusable element in the body, then the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  role?: "dialog" | "alertdialog";
  /** Buttons, right-aligned on wide screens and stacked full-width on phones. */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

interface OverlayInternalProps extends OverlayProps {
  placement: "center" | "bottom" | "end";
}

function Overlay({
  open,
  onClose,
  title,
  description,
  dismissible = true,
  initialFocusRef,
  role = "dialog",
  footer,
  children,
  className,
  placement,
}: OverlayInternalProps) {
  useLocale();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Move focus in on open, restore it on close, and lock page scroll meanwhile.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel) return;
    overlayStack.push(panel);
    const target =
      initialFocusRef?.current ??
      (bodyRef.current && focusableWithin(bodyRef.current)[0]) ??
      (panel && focusableWithin(panel).find((el) => !el.hasAttribute("data-overlay-close"))) ??
      panel;
    target?.focus();

    if (openOverlays === 0) previousOverflow = document.body.style.overflow;
    openOverlays += 1;
    document.body.style.overflow = "hidden";
    return () => {
      overlayStack.splice(overlayStack.indexOf(panel), 1);
      openOverlays -= 1;
      if (openOverlays === 0) document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
    // Focus is managed once per open; later prop changes must not steal it.
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const isTopmost = () => overlayStack[overlayStack.length - 1] === panel;
    const handleFocusIn = (event: FocusEvent) => {
      if (isTopmost() && !panel.contains(event.target as Node)) {
        (focusableWithin(panel)[0] ?? panel).focus();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        if (dismissible) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableWithin(panel);
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !panel.contains(active);
      if (event.shiftKey && (outside || active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [open, dismissible, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={cx(
        "fixed inset-0 z-50 flex animate-ui-fade bg-scrim",
        placement === "center" && "items-end sm:items-center justify-center sm:p-6",
        placement === "bottom" && "items-end justify-center",
        placement === "end" && "items-stretch justify-end",
      )}
      data-overlay-scrim=""
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx(
          "flex flex-col bg-raised text-ink shadow-modal outline-none max-h-full w-full",
          placement === "center" && "rounded-t-[1.25rem] sm:rounded-card sm:max-w-md animate-ui-sheet sm:animate-ui-pop pb-safe sm:pb-0",
          placement === "bottom" && "rounded-t-[1.25rem] sm:max-w-xl animate-ui-sheet pb-safe",
          placement === "end" && "sm:max-w-sm animate-ui-fade pt-safe pb-safe pr-safe",
          className,
        )}
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-2">
          <div className="grow min-w-0">
            <h2 id={titleId} className="text-[1.125rem] leading-snug font-semibold text-balance">{title}</h2>
            {description && <p id={descriptionId} className="mt-1 text-ink-muted">{description}</p>}
          </div>
          {dismissible && (
            <IconButton icon="close" label={t("close")} size="sm" onClick={onClose} data-overlay-close="" className="-me-2 -mt-1" />
          )}
        </div>
        {children && <div ref={bodyRef} className="grow min-h-0 overflow-y-auto px-5 py-2">{children}</div>}
        {footer && (
          <div className="flex flex-col-reverse gap-2 px-5 pt-3 pb-5 sm:flex-row sm:justify-end">{footer}</div>
        )}
        {!footer && <div className="h-3" />}
      </div>
    </div>,
    document.body,
  );
}

export type DialogProps = OverlayProps;

/** Modal dialog. Centred on tablet and desktop; slides up from the bottom edge on phones. */
export function Dialog(props: DialogProps) {
  return <Overlay {...props} placement="center" />;
}

export interface SheetProps extends OverlayProps {
  /** "bottom" (default) for action lists and pickers; "end" for a side panel such as conversation details. */
  side?: "bottom" | "end";
}

/** Modal sheet attached to a screen edge. Same focus and dismissal behaviour as Dialog. */
export function Sheet({ side = "bottom", ...props }: SheetProps) {
  return <Overlay {...props} placement={side} />;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** What will happen, in plain words, including what cannot be undone. */
  description: ReactNode;
  /** Verb phrase naming the action, e.g. "Remove device". Never "OK" or "Yes". */
  confirmLabel: string;
  cancelLabel?: string;
  /** "danger" styles the confirm button as destructive and focuses Cancel first. */
  tone?: "default" | "danger";
  icon?: IconName;
  /** When set, a checkbox with this label must be ticked before confirming. Use for irreversible key or account loss. */
  acknowledgeLabel?: ReactNode;
  /** Confirm is in flight: shows a spinner and blocks both dismissal and a second click. */
  busy?: boolean;
  /** Failure from the last attempt, shown inside the dialog so the user can retry. */
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}

/** Replacement for window.confirm. The caller owns `open` and performs the action in onConfirm. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = t("cancel"),
  tone = "default",
  icon,
  acknowledgeLabel,
  busy = false,
  error,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  useLocale();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const danger = tone === "danger";

  useEffect(() => {
    if (!open) setAcknowledged(false);
  }, [open]);

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      role="alertdialog"
      placement="center"
      dismissible={!busy}
      initialFocusRef={cancelRef}
      title={
        <span className="flex items-center gap-2.5">
          {(icon || danger) && (
            <span className={cx("flex size-9 shrink-0 items-center justify-center rounded-full", danger ? "bg-danger-soft text-danger" : "bg-brand-soft text-on-brand-soft")}>
              <Icon name={icon ?? "alert"} size={20} />
            </span>
          )}
          <span>{title}</span>
        </span>
      }
      description={description}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={onConfirm}
            loading={busy}
            disabled={Boolean(acknowledgeLabel) && !acknowledged}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {(children || acknowledgeLabel || error) && (
        <div className="flex flex-col gap-3">
          {children}
          {acknowledgeLabel && (
            <label className="flex items-start gap-3 rounded-control bg-sunken p-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 size-5 shrink-0 accent-[var(--danger)]"
                checked={acknowledged}
                disabled={busy}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span className="text-[0.8125rem]">{acknowledgeLabel}</span>
            </label>
          )}
          {error && <p role="alert" className="text-[0.8125rem] text-danger">{error}</p>}
        </div>
      )}
    </Overlay>
  );
}
