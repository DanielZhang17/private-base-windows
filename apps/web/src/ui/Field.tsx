import { t, useLocale } from "../i18n/index.js";
import { createContext, useContext, useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps {
  label: ReactNode;
  /** Guidance shown under the control. */
  help?: ReactNode;
  /** Validation message. When set, the control is marked invalid and the message is announced. */
  error?: ReactNode;
  required?: boolean;
  /** Keeps the label for screen readers but hides it visually (use only when a visible heading already names the control). */
  hideLabel?: boolean;
  className?: string;
  /** One Input, Textarea or other control. Input and Textarea pick up id and aria attributes automatically. */
  children: ReactNode;
}

/** Label + control + help/error, wired together with for/id and aria-describedby. */
export function Field({ label, help, error, required = false, hideLabel = false, className, children }: FieldProps) {
  useLocale();
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, help ? helpId : null].filter(Boolean).join(" ") || undefined;

  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error), required }}>
      <div className={cx("flex flex-col gap-1.5", className)}>
        <label htmlFor={id} className={cx("text-[0.8125rem] font-semibold text-ink", hideLabel && "sr-only")}>
          {label}
          {required && <span className="text-ink-subtle font-normal"> {t("fieldRequiredLabel")}</span>}
        </label>
        {children}
        {error && (
          <p id={errorId} role="alert" className="flex items-start gap-1.5 text-[0.8125rem] text-danger">
            <Icon name="alert-circle" size={16} className="mt-0.5" />
            <span>{error}</span>
          </p>
        )}
        {help && <p id={helpId} className="text-[0.8125rem] text-ink-muted">{help}</p>}
      </div>
    </FieldContext.Provider>
  );
}

/** Props a custom control should spread to join the surrounding Field. */
export function useFieldControl(): { id?: string; "aria-describedby"?: string; "aria-invalid"?: true; required?: true } {
  const field = useContext(FieldContext);
  if (!field) return {};
  return {
    id: field.id,
    "aria-describedby": field.describedBy,
    "aria-invalid": field.invalid || undefined,
    required: field.required || undefined,
  };
}

const CONTROL =
  "w-full min-w-0 bg-surface text-ink placeholder:text-ink-subtle rounded-control border border-line-strong " +
  "transition-[border-color,box-shadow] duration-[var(--duration-fast)] " +
  "focus-within:border-brand focus-within:shadow-[0_0_0_3px_var(--primary-soft)] " +
  "has-aria-invalid:border-danger has-aria-invalid:focus-within:shadow-[0_0_0_3px_var(--danger-soft)] " +
  "has-disabled:opacity-60 has-disabled:bg-sunken";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Marks the control invalid without a Field. Inside a Field, pass `error` to the Field instead. */
  invalid?: boolean;
  /** Element shown inside the control before the text, usually an Icon. */
  leading?: ReactNode;
  /** Element shown inside the control after the text, usually an IconButton (show/hide password, clear). */
  trailing?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ invalid, leading, trailing, className, ...rest }: InputProps) {
  const field = useFieldControl();
  return (
    <span className={cx(CONTROL, "flex items-center gap-2 h-11 px-3", trailing ? "pe-1" : null, className)}>
      {leading && <span className="flex text-ink-subtle">{leading}</span>}
      <input
        {...field}
        {...rest}
        aria-invalid={invalid || field["aria-invalid"] || rest["aria-invalid"] || undefined}
        className="grow min-w-0 h-full bg-transparent outline-none"
      />
      {trailing}
    </span>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ invalid, className, rows = 3, ...rest }: TextareaProps) {
  const field = useFieldControl();
  return (
    <span className={cx(CONTROL, "flex", className)}>
      <textarea
        rows={rows}
        {...field}
        {...rest}
        aria-invalid={invalid || field["aria-invalid"] || rest["aria-invalid"] || undefined}
        className="grow min-w-0 bg-transparent outline-none px-3 py-2.5 resize-y min-h-11"
      />
    </span>
  );
}

/** Native select connected to its surrounding Field label and guidance. */
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const field = useFieldControl();
  return <select {...field} {...props} />;
}
