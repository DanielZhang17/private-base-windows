import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), video[controls], audio[controls], [tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

let openOverlays = 0;
let previousOverflow = "";
const overlayStack: HTMLElement[] = [];

/** Shared modal stack, focus containment, restoration and scroll lock. */
export function useModalFocus({ open, onClose, dismissible = true, panelRef, bodyRef, initialFocusRef }: {
  open: boolean;
  onClose: () => void;
  dismissible?: boolean;
  panelRef: RefObject<HTMLElement | null>;
  bodyRef?: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  // Move focus in on open, restore it on close, and lock page scroll meanwhile.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel) return;
    overlayStack.push(panel);
    const target =
      initialFocusRef?.current ??
      (bodyRef?.current && focusableWithin(bodyRef.current)[0]) ??
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
}
