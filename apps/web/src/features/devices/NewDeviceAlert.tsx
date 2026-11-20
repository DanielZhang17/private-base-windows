import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { DeviceAlert, DeviceLimitEntry } from "@e2ee-chat/shared";
import { t, useLocale } from "../../i18n/index.js";
import { formatDate } from "../../i18n/format.js";
import { localized } from "../../i18n/messages.js";
import { api } from "../../services/api.js";
import { deviceAlertDestination } from "../../services/device-alerts.js";
import { isOnlyLocalPasskeyUnlock, localPasskeyUnlockId, removeLocalUnlockMethod } from "../../lib/key-manager.js";
import { Button, ConfirmDialog, Dialog, Icon, ListItem, Notice, Sheet, useToast } from "../../ui/index.js";
import { PasswordUnlockDialog } from "../settings/PasswordUnlockDialog.js";
import { DeviceApproval } from "../settings/DeviceApproval.js";
import { usePrivacySettings } from "../settings/usePrivacySettings.js";
import { deviceAlertTime, deviceIcon, linkMethodLabel } from "./devicePresentation.js";
import { useDeviceAlerts } from "./useDeviceAlerts.js";
import { removeLinkedDevice } from "./removeLinkedDevice.js";
import { useHoldUnlockOffer } from "../auth/unlockOfferGate.js";

function alertTitle(alert: DeviceAlert) {
  return t(alert.kind === "approval_disabled" ? "deviceAlert.titleApprovalOff"
    : alert.kind === "recovery_signin" ? "deviceAlert.titleRecovery" : "deviceAlert.title");
}

function alertDetail(alert: DeviceAlert) {
  const data = { ...alert, time: deviceAlertTime(alert.at), actingDeviceName: alert.actingDeviceName ?? alert.deviceName };
  if (alert.kind === "approval_disabled") return t("deviceAlert.detailApprovalOff", data);
  if (alert.kind === "recovery_signin") return t(alert.replacedDeviceName ? "deviceAlert.detailReplaced" : "deviceAlert.detailRecovery", data);
  return t(alert.credentialName ? "deviceAlert.detail" : "deviceAlert.detailPasskeyUnnamed", data);
}

export function NewDeviceAlerts({ placement = "banner", compact = false, filter, alerts: existing }: {
  placement?: "banner" | "devices" | "privacy"; compact?: boolean;
  filter?: (alert: DeviceAlert) => boolean; alerts?: ReturnType<typeof useDeviceAlerts>;
}) {
  useLocale();
  const queried = useDeviceAlerts(!existing);
  const security = existing ?? queried;
  const toast = useToast();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState(false);
  const [review, setReview] = useState<DeviceAlert | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const alerts = security.alerts.filter(alert => !hidden.includes(alert.alertId) && (!filter || filter(alert)));
  // A security alert always wins over the optional unlock offer.
  useHoldUnlockOffer(alerts.length > 0);
  const seen = useRef(new Set<string>());
  useEffect(() => { for (const alert of alerts) seen.current.add(alert.alertId); }, [alerts]);
  const [narrow, setNarrow] = useState(() => window.matchMedia?.("(max-width: 639px)").matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 639px)");
    const update = () => setNarrow(media.matches);
    media?.addEventListener?.("change", update);
    return () => media?.removeEventListener?.("change", update);
  }, []);
  const collapse = placement === "banner" && alerts.length > 0 && ((narrow && compact) || (narrow && alerts.length > 2));
  async function acknowledge(alert: DeviceAlert) {
    setHidden(values => [...values, alert.alertId]);
    setFailures(values => values.filter(id => id !== alert.alertId));
    try {
      await security.acknowledge(alert.alertId);
      toast.show({ tone: "success", message: localized(alert.kind === "approval_disabled" ? "deviceAlert.ackApprovalToast" : "deviceAlert.ackToast",
        { deviceName: alert.deviceName }) });
    } catch {
      setHidden(values => values.filter(id => id !== alert.alertId));
      setFailures(values => [...values, alert.alertId]);
    }
  }
  const cards = () => alerts.map(alert => <article key={alert.alertId}
    className="grid items-center gap-3 rounded-[10px] border border-warning/40 bg-warn-soft px-4 py-3 animate-ui-toast lg:grid-cols-[auto_1fr_auto]">
    <div className="flex min-w-0 items-start gap-3 lg:col-span-2">
      <span className="grid size-10 shrink-0 place-items-center rounded-control bg-surface text-warning"><Icon name={deviceIcon(alert.platform)} /></span>
      <div className="min-w-0 max-w-2xl">
        <div role={!seen.current.has(alert.alertId) ? placement === "banner" ? "alert" : "status" : undefined}>
          <h3 className="font-semibold">{alertTitle(alert)}</h3>
          <p className="break-words text-sm text-ink-muted">{alertDetail(alert)}</p>
          <p className="mt-1 text-sm">{t(alert.kind === "approval_disabled" ? "deviceAlert.warningApprovalOff" : "deviceAlert.warning")}</p>
        </div>
        {failures.includes(alert.alertId) && <p role="alert" className="mt-1 text-sm text-danger">{t("deviceAlert.ackFailed")}</p>}
      </div>
    </div>
    <div className="grid grid-cols-2 gap-2 lg:flex">
      <Button variant="secondary" aria-label={alert.kind === "approval_disabled" ? t("deviceAlert.itWasMe") : t("deviceAlert.itWasMeName", { deviceName: alert.deviceName })}
        onClick={() => void acknowledge(alert)}>{t("deviceAlert.itWasMe")}</Button>
      {alert.kind === "approval_disabled" ? <Button onClick={() => { setSheet(false); navigate(deviceAlertDestination(alert.kind)); }}>
        {t("deviceAlert.reviewPrivacy")}</Button> : <Button variant="danger"
          aria-label={t("deviceAlert.notMeName", { deviceName: alert.deviceName })}
          onClick={() => { setSheet(false); setReview(alert); }}>{t("deviceAlert.notMe")}</Button>}
    </div>
  </article>);

  return <>
    {alerts.length > 0 && <section aria-label={t("deviceAlert.regionLabel")} className={placement === "banner" ? "grid gap-2 px-3 pt-2 pb-2" : "grid gap-3"}>
      {placement === "devices" && <h2 className="font-semibold">{t("devices.newSignIns")}</h2>}
      {collapse ? <div className="flex min-h-11 items-center justify-between gap-3 rounded-control bg-warn-soft px-3">
        <span role={alerts.some(alert => !seen.current.has(alert.alertId)) ? "alert" : undefined} className="text-sm font-semibold">
          {alerts.length === 1 ? alertTitle(alerts[0]) : t("deviceAlert.manyAlerts", { count: alerts.length })}
        </span>
        <Button variant="ghost" onClick={() => setSheet(true)}>{t("deviceAlert.review")}</Button>
      </div> : cards()}
    </section>}
    <Sheet open={sheet && collapse} title={t("deviceAlert.regionLabel")} onClose={() => setSheet(false)}>
      <div className="grid gap-3">{sheet && collapse && cards()}</div>
    </Sheet>
    {review && <DeviceAlertReview alert={review} onClose={() => setReview(null)} security={security} />}
  </>;
}

function DeviceAlertReview({ alert, onClose, security }: {
  alert: DeviceAlert; onClose: () => void; security: ReturnType<typeof useDeviceAlerts>;
}) {
  const navigate = useNavigate();
  const query = useQueryClient();
  const [result, setResult] = useState<Awaited<ReturnType<typeof security.revokeAsNotMe>>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removedCredential, setRemovedCredential] = useState(false);
  const [lastCredential, setLastCredential] = useState(false);
  const [guard, setGuard] = useState(false);
  const [backup, setBackup] = useState(false);
  const [laterTarget, setLaterTarget] = useState<DeviceLimitEntry>();
  const privacy = usePrivacySettings(!!result);
  const title = useRef<HTMLSpanElement>(null);
  const credential = result?.credential;
  useEffect(() => {
    if (!credential) return;
    void isOnlyLocalPasskeyUnlock(credential.credentialId).then(setGuard).catch(() => undefined);
  }, [credential]);
  useEffect(() => { if (result) title.current?.focus(); }, [!!result]);

  async function perform(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); }
    catch { setError(t("deviceAlert.ackFailed")); }
    finally { setBusy(false); }
  }
  async function removeCredential() {
    if (!credential) return;
    if (await isOnlyLocalPasskeyUnlock(credential.credentialId)) { setGuard(true); return; }
    const enrolled = await localPasskeyUnlockId();
    await api.delete(`/api/passkeys/${encodeURIComponent(credential.id)}`);
    setRemovedCredential(true);
    await query.invalidateQueries({ queryKey: ["passkeys"] });
    const remaining = await api.get<unknown[]>("/api/passkeys");
    if (!remaining.length) setLastCredential(true);
    if (enrolled === credential.credentialId) await removeLocalUnlockMethod("passkey");
  }
  if (!result) return <ConfirmDialog open tone="danger" title={t("deviceAlert.removeTitle", { deviceName: alert.deviceName })}
    description={t("deviceAlert.removeBody")} confirmLabel={t("removeDevice")} busy={busy} error={error} onCancel={onClose}
    onConfirm={() => void perform(async () => { setResult(await security.revokeAsNotMe(alert.alertId)); })} />;

  return <Dialog open onClose={onClose} dismissible={!busy} initialFocusRef={title}
    title={<span ref={title} tabIndex={-1} className="flex items-center gap-2 outline-none"><Icon name="check-circle" className="text-success" />{t("deviceAlert.removedTitle")}</span>}
    description={t(alert.kind === "recovery_signin" ? "deviceAlert.removedBodyRecovery" : "deviceAlert.removedBody", {
      deviceName: alert.deviceName, credentialName: alert.credentialName ?? credential?.name ?? t("unlockMethods.passkey"),
    })}
    footer={<>
      <Button variant="ghost" disabled={busy} onClick={() => { onClose(); navigate("/settings?section=security"); }}>{t("deviceAlert.reviewPasskeys")}</Button>
      <Button disabled={busy} onClick={onClose}>{t("deviceAlert.done")}</Button>
    </>}>
    <div className="space-y-4">
      {error && !laterTarget && <Notice tone="danger">{error}</Notice>}
      {credential && <>
        <ListItem leading={<Icon name="passkey" />} title={credential.name}
          subtitle={removedCredential ? t("deviceAlert.passkeyRemovedState") : t("passkeyAddedDate", { value: formatDate(credential.createdAt) })}
          trailing={!removedCredential && !guard && <Button variant="danger-ghost" loading={busy}
            onClick={() => void perform(removeCredential)}>{t("removePasskey")}</Button>} />
        {lastCredential && <p className="text-sm text-ink-muted">{t("deviceAlert.removedLastPasskey")}</p>}
        {guard && !removedCredential && <Notice tone="warning" action={<Button variant="secondary" onClick={() => setBackup(true)}>
          {t("security.addPasswordAction")}</Button>}>{t("security.removeOnlyUnlockPasskey")}</Notice>}
      </>}
      <DeviceApproval privacy={privacy} compact />
      {!!result.devicesAddedSince?.length && <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("deviceAlert.alsoAdded")}</h3>
        {result.devicesAddedSince.map(device => <ListItem key={device.id} leading={<Icon name={deviceIcon(device.platform)} />} title={device.name}
          subtitle={t("deviceAlert.addedMeta", { time: deviceAlertTime(device.activatedAt ?? device.createdAt), linkMethod: linkMethodLabel(device.linkMethod) })}
          trailing={<Button variant="danger-ghost" onClick={() => { setLaterTarget(device); setError(""); }}>{t("deviceAlert.remove")}</Button>} />)}
      </section>}
      <PasswordUnlockDialog open={backup} method={t("unlockMethods.passkey")} onClose={() => setBackup(false)} onSaved={() => setGuard(false)} />
      <ConfirmDialog open={!!laterTarget} tone="danger" confirmLabel={t("removeDevice")}
        title={t("deviceAlert.removeTitle", { deviceName: laterTarget?.name })} description={t("deviceAlert.removeBody")}
        busy={busy} error={error} onCancel={() => { setLaterTarget(undefined); setError(""); }}
        onConfirm={() => void perform(async () => {
          if (!laterTarget) return;
          await removeLinkedDevice(laterTarget.id);
          setResult({ ...result, devicesAddedSince: result.devicesAddedSince?.filter(device => device.id !== laterTarget.id) });
          setLaterTarget(undefined);
          await query.invalidateQueries({ queryKey: ["myDevices"] });
        })} />
    </div>
  </Dialog>;
}
