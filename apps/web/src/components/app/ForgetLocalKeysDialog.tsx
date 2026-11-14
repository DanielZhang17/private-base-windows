import { t, useLocale } from "../../i18n/index.js";
import { ConfirmDialog } from "../../ui/index.js";

export default function ForgetLocalKeysDialog({ open, loading, error, onForget, onCancel }: {
  open: boolean;
  loading: boolean;
  error: string;
  onForget: () => void;
  onCancel: () => void;
}) {
  useLocale();
  return (
    <ConfirmDialog
      open={open}
      tone="danger"
      title={t("forgetKeysOnThisDevice2")}
      description={t("messageHistoryOnThisDeviceWillBeLost")}
      acknowledgeLabel={t("iUnderstandThisCannotBeUndone")}
      confirmLabel={t("forgetKeys")}
      busy={loading}
      error={error}
      onConfirm={onForget}
      onCancel={onCancel}
    />
  );
}
