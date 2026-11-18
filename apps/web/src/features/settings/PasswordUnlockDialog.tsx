import { useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { Button, Dialog, Field, Input, useToast } from "../../ui/index.js";
import { localized } from "../../i18n/messages.js";
import { addAccountPasswordUnlock } from "../../lib/passkey-provision.js";

export function PasswordUnlockDialog({ open, method, onClose, onSaved }: {
  open: boolean; method: string; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setPassword(""); setError(""); } }, [open]);

  return <Dialog open={open} title={t("security.addPasswordTitle")} description={t("security.addPasswordBody", { method })}
    dismissible={!busy} onClose={onClose} footer={<>
      <Button variant="secondary" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
      <Button type="submit" form="add-password-unlock" loading={busy} disabled={!password}>{t("security.addPasswordAction")}</Button>
    </>}>
    <form id="add-password-unlock" onSubmit={event => {
      event.preventDefault();
      if (busy || !password) return;
      setBusy(true);
      setError("");
      void addAccountPasswordUnlock(password).then(() => {
        toast.show({ tone: "success", message: localized("passkeySetup.passwordAdded") });
        onSaved();
        onClose();
      }).catch(err => {
        const reason = (err as { body?: { error?: string } })?.body?.error;
        setError(t(reason === "invalid_password" ? "thatPasswordIsNotCorrect" : "passkeySetup.finishFailed"));
      }).finally(() => setBusy(false));
    }}>
      <Field label={t("passkeySetup.accountPassword")} error={error}>
        <Input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />
      </Field>
    </form>
  </Dialog>;
}
