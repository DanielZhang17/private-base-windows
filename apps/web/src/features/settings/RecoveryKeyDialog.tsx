import { localized, renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { t, useLocale } from "../../i18n/index.js";
import { useState } from "react";
import { Button, Dialog, Notice, useToast } from "../../ui/index.js";

export function RecoveryKeyDialog({ recoveryKey, onContinue, onCopy, onSave, canSave, onCancel, busy, saveError }: {
  recoveryKey: string | null; onContinue: () => void; onCopy: () => Promise<void>;
  onSave: () => Promise<void>; canSave: boolean; onCancel?: () => void; busy?: boolean; saveError?: string;
}) {
  useLocale();
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const toast = useToast();
  async function perform(action: () => Promise<void>, message?: LocalizedMessage) {
    try { await action(); setError(null); if (message) toast.show({ tone: "success", message }); }
    catch (failure) { setError(toErrorMessage(failure, "couldNotSaveRecoveryKey")); }
  }
  return <Dialog
    open={!!recoveryKey}
    onClose={() => { setAcknowledged(false); onCancel?.(); }}
    dismissible={!!onCancel && !busy}
    title={t("saveYourRecoveryKey")}

    description={t("thisKeyIsTheOnlyWayBackInto")}

    footer={<>
      {onCancel && <Button variant="secondary" disabled={busy} onClick={() => { setAcknowledged(false); onCancel(); }}>{t("cancel")}</Button>}
      <Button loading={busy} disabled={!acknowledged} onClick={() => { onContinue(); if (!onCancel) setAcknowledged(false); }}>{t("continue")}</Button>
    </>}
  >

    <div className="space-y-4">

      <div className="mockup-code rounded-control bg-sunken p-4 before:hidden">
        <code className="secret-text flex flex-wrap gap-x-3 gap-y-2 text-lg" data-testid="recovery-key">
          {(recoveryKey?.split(/(?<=-)/) ?? []).map((chunk, i) => <span key={i}>
            {chunk}
          </span>)}
        </code>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          leadingIcon="copy"
          onClick={() => void perform(onCopy, localized("recoveryKeyCopied"))}
        >{t("copy")}</Button>
        {canSave && <Button
          variant="ghost"
          leadingIcon="download"
          onClick={() => void perform(onSave)}
        >{t("saveAsFile")}</Button>}
      </div>

      {saveError && <Notice tone="danger">{saveError}</Notice>}
      {error && <Notice tone="danger">
        {renderMessage(error)}
      </Notice>}

      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"><input
        type="checkbox"
        className="size-5 accent-[var(--brand)]"
        checked={acknowledged}
        onChange={(event) => setAcknowledged(event.target.checked)}
      />{t("iHaveSavedMyRecoveryKeySomewhereSafe")}</label>

    </div>

  </Dialog>;
}
