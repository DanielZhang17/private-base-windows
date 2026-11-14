import { t, useLocale } from "../../i18n/index.js";
import { useEffect, useRef, type ReactNode } from "react";
import type { PendingConfirmation } from "../../features/shared/useFeedback.js";

/**
 * Opened with showModal() so it sits in the browser's top layer: the dialog that asked for the
 * feedback (e.g. Group Settings) shares DaisyUI's modal z-index and would otherwise cover it.
 */
function FeedbackDialog({ onCancel, children }: { onCancel: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element || element.open) return;
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
  }, []);
  return <dialog ref={dialog} className="modal" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <div className="modal-box">{children}</div>
  </dialog>;
}

export default function FlowFeedback({ pendingConfirmation, notice, dismissNotice }: {
  pendingConfirmation: PendingConfirmation | null;
  notice: string | null;
  dismissNotice: () => void;
}) {
  useLocale();
  // These can render inside a form (AvatarPicker on the Register page): never default to submit.
  return <>
    {pendingConfirmation && <FeedbackDialog onCancel={pendingConfirmation.onCancel}>
      <h3 className="font-bold text-lg">{pendingConfirmation.title}</h3>
      <p>{pendingConfirmation.message}</p>
      <div className="modal-action">
        <button type="button" className="btn btn-ghost" onClick={pendingConfirmation.onCancel}>{t("cancel")}</button>
        <button type="button" className={`btn ${pendingConfirmation.destructive ? "btn-error" : "btn-primary"}`} onClick={pendingConfirmation.onConfirm}>{pendingConfirmation.confirmLabel}</button>
      </div>
    </FeedbackDialog>}
    {notice && <FeedbackDialog onCancel={dismissNotice}>
      <p role="alert">{notice}</p>
      <div className="modal-action"><button type="button" className="btn btn-primary" onClick={dismissNotice}>{t("ok")}</button></div>
    </FeedbackDialog>}
  </>;
}
