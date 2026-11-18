import { useCallback, useLayoutEffect, type ReactNode } from "react";
import { dismissSaveFeedback, presentSaveFeedback, useSaveFeedbackStore } from "../../features/chat/save-feedback.js";
import { localized } from "../../i18n/messages.js";
import { ToastProvider } from "../../ui/index.js";

function focusFallback(document: Document) {
  for (const target of [document.querySelector<HTMLElement>("main, [role=main]"), document.getElementById("root")]) {
    if (!target) continue;
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) return;
  }
}

export default function SaveFeedbackToastProvider({ children }: { children: ReactNode }) {
  const feedback = useSaveFeedbackStore(({ topOverlay, notice }) => topOverlay && topOverlay.kind !== "popover" ? null : notice);
  const announcement = useSaveFeedbackStore(({ announcement }) => announcement?.viewer === undefined ? announcement ?? undefined : undefined);
  useLayoutEffect(() => {
    if (feedback) presentSaveFeedback(feedback);
  }, [feedback]);
  const dismissRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    let previousFocus: HTMLElement | null = null;
    const rememberFocus = (event: FocusEvent) => {
      previousFocus = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
    };
    button.addEventListener("focus", rememberFocus);
    return () => {
      button.removeEventListener("focus", rememberFocus);
      const document = button.ownerDocument;
      if (document.activeElement !== button) return;
      if (previousFocus?.isConnected && previousFocus !== document.body) {
        previousFocus.focus({ preventScroll: true });
        if (document.activeElement === previousFocus) return;
      }
      focusFallback(document);
    };
  }, []);
  return (
    <ToastProvider announcement={announcement} controlledToast={feedback ? {
      tone: feedback.tone,
      title: feedback.fileName ? localized(feedback.key) : undefined,
      message: feedback.fileName ? <span className="line-clamp-2 break-words">{feedback.fileName}</span> : localized(feedback.key),
      onDismiss: () => dismissSaveFeedback(feedback),
      dismissRef,
    } : undefined}>
      {children}
    </ToastProvider>
  );
}
