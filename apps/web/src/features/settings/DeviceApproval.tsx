import { useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { t } from "../../i18n/index.js";
import { localized } from "../../i18n/messages.js";
import { generateRecoveryKey } from "../../lib/device-link.js";
import { capabilities } from "../../platform/capabilities.js";
import { copyText } from "../../platform/clipboard.js";
import { saveFile } from "../../platform/files.js";
import { api } from "../../services/api.js";
import { ConfirmDialog, Notice, Spinner, useToast } from "../../ui/index.js";
import { RecoveryKeyDialog } from "./RecoveryKeyDialog.js";
import type { usePrivacySettings } from "./usePrivacySettings.js";

export function DeviceApproval({ privacy, compact = false }: { privacy: ReturnType<typeof usePrivacySettings>; compact?: boolean }) {
  const help = useId();
  const query = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<"off" | "recovery" | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const acceptedKey = useRef<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enabledHere, setEnabledHere] = useState(false);
  const checked = privacy.data?.requireDeviceApproval === true;

  async function change(enabled: boolean, recoveryKey?: string) {
    setBusy(true);
    setError(false);
    try {
      if (recoveryKey && acceptedKey.current !== recoveryKey) {
        await api.post("/api/device-links/recovery-key", { recoveryKey });
        acceptedKey.current = recoveryKey;
        await query.invalidateQueries({ queryKey: ["recoveryKeyStatus"] });
      }
      if (enabled && !recoveryKey) {
        const status = await api.get<{ enrolled: boolean }>("/api/device-links/recovery-key");
        if (!status.enrolled) { setDialog("recovery"); return; }
      }
      if (!await privacy.setDeviceApproval(enabled)) { setError(true); return; }
      setDialog(null);
      setKey(null);
      acceptedKey.current = null;
      if (enabled) setEnabledHere(true);
      toast.show({ tone: "success", message: localized(enabled && compact ? "deviceAlert.approvalOn" : "privacySaved") });
    } catch {
      setError(true);
    } finally { setBusy(false); }
  }

  if (compact && checked) return enabledHere ? <p role="status" className="text-sm text-success">{t("deviceAlert.approvalOn")}</p> : null;
  return <section className="space-y-2">
    {!compact && <h2 className="font-semibold">{t("privacy.newDevicesHeading")}</h2>}
    <label aria-busy={busy} className="flex min-h-11 cursor-pointer items-center gap-3">
      <input type="checkbox" role="switch" className="toggle" checked={checked}
        disabled={busy || !privacy.data || privacy.disabled} aria-describedby={help}
        onChange={event => { if (event.target.checked) void change(true); else setDialog("off"); }} />
      <span className="min-w-0 grow font-semibold">{t("privacy.requireApproval")}</span>
      {busy && <Spinner label={t("loadingStatus")} />}
    </label>
    <p id={help} className="text-sm text-ink-muted">{t(compact ? "privacy.requireApprovalShort" : "privacy.requireApprovalHelp")}</p>
    {error && !dialog && !key && <Notice tone="danger">{t("privacySaveFailed")}</Notice>}
    <ConfirmDialog open={dialog === "off"} title={t("privacy.turnOffApprovalTitle")} description={t("privacy.turnOffApprovalBody")}
      confirmLabel={t("privacy.turnOff")} busy={busy} error={error && t("privacySaveFailed")}
      onCancel={() => { setDialog(null); setError(false); }} onConfirm={() => void change(false)} />
    <ConfirmDialog open={dialog === "recovery"} title={t("privacy.needRecoveryTitle")} description={t("privacy.needRecoveryBody")}
      confirmLabel={t("privacy.createRecoveryKey")} onCancel={() => setDialog(null)}
      onConfirm={() => { setDialog(null); setKey(generateRecoveryKey()); }} />
    <RecoveryKeyDialog recoveryKey={key} canSave={capabilities.saveFile} busy={busy} saveError={error ? t("privacySaveFailed") : undefined}
      onCancel={() => { setKey(null); acceptedKey.current = null; setError(false); }} onContinue={() => { if (key) void change(true, key); }}
      onCopy={async () => { if (key) await copyText(key); }}
      onSave={async () => { if (key) await saveFile(new Blob([key], { type: "text/plain" }), "private-base-recovery-key.txt"); }} />
  </section>;
}
