import { isLocalizedMessage, renderMessage, type LocalizedMessage } from "../i18n/messages.js";
import { t, useLocale } from "../i18n/index.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button.js";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";
import type { IconName } from "./icons/paths.js";

export type Tone = "info" | "success" | "warning" | "danger";

const TONE_ICON: Record<Tone, IconName> = {
  info: "info",
  success: "check-circle",
  warning: "alert",
  danger: "alert-circle",
};

const TONE_SOFT: Record<Tone, string> = {
  info: "bg-brand-soft text-on-brand-soft",
  success: "bg-ok-soft text-ink",
  warning: "bg-warn-soft text-ink",
  danger: "bg-danger-soft text-ink",
};

const TONE_ICON_COLOR: Record<Tone, string> = {
  info: "text-on-brand-soft",
  success: "text-ok",
  warning: "text-warn",
  danger: "text-danger",
};

export interface NoticeProps {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  /** Button or link placed after the text, e.g. "Retry". */
  action?: ReactNode;
  onDismiss?: () => void;
  icon?: IconName;
  className?: string;
}

/** Inline message that stays in the layout: form errors, connection state, security notes. */
export function Notice({ tone = "info", title, children, action, onDismiss, icon, className }: NoticeProps) {
  useLocale();
  const urgent = tone === "danger" || tone === "warning";
  return (
    <div
      role={urgent ? "alert" : "status"}
      className={cx("flex items-start gap-3 rounded-control px-3.5 py-3 text-[0.875rem]", TONE_SOFT[tone], className)}
    >
      <Icon name={icon ?? TONE_ICON[tone]} size={20} className={cx("mt-px", TONE_ICON_COLOR[tone])} />
      <div className="grow min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5" : undefined}>{children}</div>}
      </div>
      {action}
      {onDismiss && <IconButton icon="close" label={t("dismiss")} size="sm" onClick={onDismiss} className="-my-1.5 -me-2" />}
    </div>
  );
}

export interface ToastOptions {
  tone?: Tone;
  title?: ReactNode | LocalizedMessage;
  message: ReactNode | LocalizedMessage;
  /** Milliseconds before auto-dismiss. 0 keeps it until dismissed. Defaults to 5000, or 0 for danger. */
  duration?: number;
  action?: { label: string | LocalizedMessage; onClick: () => void };
}

interface ToastEntry extends ToastOptions {
  id: number;
}

interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Replacement for window.alert. Mount once near the root; call useToast().show(...) anywhere below. */
export function ToastProvider({ children }: { children: ReactNode }) {
  useLocale();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((options: ToastOptions) => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-2), { ...options, id }]);
    const duration = options.duration ?? (options.tone === "danger" ? 0 : 5000);
    if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
    return id;
  }, [dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          aria-label={t("notifications")}
          role="region"
          className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4 pt-[calc(var(--safe-top)+var(--titlebar-height)+0.75rem)] sm:items-end"
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role={toast.tone === "danger" || toast.tone === "warning" ? "alert" : "status"}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card bg-raised px-3.5 py-3 text-[0.875rem] text-ink shadow-overlay border border-line animate-ui-toast"
            >
              <Icon name={TONE_ICON[toast.tone ?? "info"]} size={20} className={cx("mt-px", TONE_ICON_COLOR[toast.tone ?? "info"])} />
              <div className="grow min-w-0">
                {toast.title && <p className="font-semibold">{isLocalizedMessage(toast.title) ? renderMessage(toast.title) : toast.title}</p>}
                <div>{isLocalizedMessage(toast.message) ? renderMessage(toast.message) : toast.message}</div>
                {toast.action && (
                  <button
                    type="button"
                    className="mt-1.5 font-semibold text-brand underline-offset-2 hover:underline cursor-pointer"
                    onClick={() => {
                      toast.action?.onClick();
                      dismiss(toast.id);
                    }}
                  >
                    {isLocalizedMessage(toast.action.label) ? renderMessage(toast.action.label) : toast.action.label}
                  </button>
                )}
              </div>
              <IconButton icon="close" label={t("dismiss")} size="sm" onClick={() => dismiss(toast.id)} className="-my-1.5 -me-2" />
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}
