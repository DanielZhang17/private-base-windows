import { localized, renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { useLocale } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";

interface ConfirmationMessage {
  title: LocalizedMessage;
  message: LocalizedMessage;
  confirmLabel: LocalizedMessage;
  destructive: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export type PendingConfirmation = Omit<ConfirmationMessage, "title" | "message" | "confirmLabel"> & {
  title: string; message: string; confirmLabel: string;
};

/** A cancellable replacement for native blocking confirmations. */
export function useFeedback() {
  useLocale();
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationMessage | null>(null);
  const [notice, setNotice] = useState<LocalizedMessage | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  useEffect(() => () => resolveRef.current?.(false), []);
  const requestConfirmation = (message: LocalizedMessage, title = localized("confirm"), confirmLabel = localized("confirm"), destructive = true) => {
    resolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      const finish = (confirmed: boolean) => {
        if (resolveRef.current !== resolve) return;
        resolveRef.current = null;
        setPendingConfirmation(null);
        resolve(confirmed);
      };
      setPendingConfirmation({ title, message, confirmLabel, destructive, onConfirm: () => finish(true), onCancel: () => finish(false) });
    });
  };
  return {
    pendingConfirmation: pendingConfirmation && {
      ...pendingConfirmation,
      title: renderMessage(pendingConfirmation.title),
      message: renderMessage(pendingConfirmation.message),
      confirmLabel: renderMessage(pendingConfirmation.confirmLabel),
    },
    notice: notice ? renderMessage(notice) : null,
    noticeMessage: notice,
    setNotice, requestConfirmation, dismissNotice: () => setNotice(null),
  };
}
