import { Fragment, useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Portal } from "./Portal.js";
import { Sheet } from "./Dialog.js";
import { Icon } from "./Icon.js";
import type { IconName } from "./icons/paths.js";

export interface ActionMenuItem { id: string; label: string; onSelect: () => void; icon?: IconName; hint?: string; separatorBefore?: boolean; danger?: boolean; disabled?: boolean }
export interface ActionMenuPosition { x: number; y: number; top?: number; source?: "button" | "pointer"; align?: "start" | "end"; keyboard?: boolean }

/** Pointer popover on wide screens; the shared modal Sheet on phones. */
export function ActionMenu({ open, position, title, items, onClose, children, preview }: {
  open: boolean; position: ActionMenuPosition; title: string;
  items: ActionMenuItem[]; onClose: () => void; children?: ReactNode; preview?: ReactNode;
}) {
  const [phone, setPhone] = useState(() => window.matchMedia?.("(max-width: 639px)").matches ?? false);
  const panel = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), first = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const search = useRef({ value: "", at: 0 });
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 639px)");
    if (!query) return;
    const change = () => setPhone(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useLayoutEffect(() => {
    if (!open || phone || !panel.current) return;
    const element = panel.current, previous = document.activeElement as HTMLElement | null;
    const box = element.getBoundingClientRect();
    const end = position.align === "end";
    const x = position.source === "button" ? position.x - (end ? box.width : 0) : position.x + (end ? -4 - box.width : 4);
    let y = position.y + 4;
    if (y + box.height > window.innerHeight - 8) y = (position.top ?? position.y) - box.height - 4;
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
    (position.keyboard ? first.current : menu.current)?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [open, phone, position.x, position.y, position.top, position.align, position.keyboard]);
  useEffect(() => {
    if (!open || phone) return;
    const dismiss = (event: Event) => { if (!panel.current?.contains(event.target as Node)) closeRef.current(); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); closeRef.current(); }
    };
    const resize = () => closeRef.current();
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", resize);
    };
  }, [open, phone]);
  // Android/WebView back consumes this same-URL entry before leaving the conversation.
  useEffect(() => {
    if (!open || !phone) return;
    const token = crypto.randomUUID();
    history.pushState({ ...history.state, messageActionMenu: token }, "");
    const back = () => closeRef.current();
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("popstate", back);
      if (history.state?.messageActionMenu === token) history.back();
    };
  }, [open, phone]);
  if (!open) return null;
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index < 0 ? (event.key === "ArrowUp" ? buttons.length - 1 : 0) : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const value = (Date.now() - search.current.at < 700 ? search.current.value : "") + event.key.toLocaleLowerCase();
      search.current = { value, at: Date.now() };
      const ordered = [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)];
      ordered.find((button) => button.dataset.label?.toLocaleLowerCase().startsWith(value))?.focus();
    }
  }
  const firstId = items.find((item) => !item.disabled)?.id;
  const content = <div ref={menu} role="menu" tabIndex={-1} aria-label={title} onKeyDown={navigate} className="outline-none">
    {children}
    {items.map((item) => <Fragment key={item.id}>
      {item.separatorBefore && <div role="separator" className="my-1 border-t border-line" />}
      <button ref={item.id === firstId ? first : undefined} role="menuitem" type="button" disabled={item.disabled} data-label={item.label} aria-label={item.label} aria-describedby={item.hint ? `${hintId}-${item.id}` : undefined}
        className={`flex w-full items-center gap-3 rounded-control px-3 py-1 text-start focus-visible:outline-2 focus-visible:outline-brand hover:bg-sunken disabled:opacity-50 ${phone ? "min-h-[52px]" : "min-h-9 pointer-coarse:min-h-11"} ${item.danger ? "text-danger" : "text-ink"}`}
        onClick={() => { onClose(); item.onSelect(); }}>
        {item.icon && <Icon name={item.icon} size={phone ? 20 : 18} className="shrink-0" />}
        <span className={`flex min-w-0 flex-1 ${phone ? "flex-col" : "items-center justify-between gap-6"}`}><span>{item.label}</span>{item.hint && <span id={`${hintId}-${item.id}`} className="text-xs text-ink-subtle">{item.hint}</span>}</span>
      </button>
    </Fragment>)}
  </div>;
  if (phone) return <Sheet open onClose={onClose} title={preview ?? title} ariaLabel={title} closeButtonSize="md" initialFocusRef={position.keyboard ? first : menu} className="message-action-sheet">{content}</Sheet>;
  return <Portal><div ref={panel} className="message-action-popover fixed z-40 max-h-[calc(100dvh-1rem)] min-w-52 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-card border border-line bg-raised p-1 text-ink shadow-overlay" style={{ left: position.x, top: position.y }}>{content}</div></Portal>;
}
