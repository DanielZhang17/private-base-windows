import { t, useLocale } from "../../i18n/index.js";
import { Button, type ButtonSize } from "../../ui/index.js";
import type { useUpdates } from "./useUpdates.js";

type Updates = ReturnType<typeof useUpdates>;
export function UpdateStatus({ update: u }: { update: Updates }) {
  const { locale } = useLocale();
  const { state } = u;
  if (u.deferred) return <p>{t("updates.deferred")}</p>;
  if (u.installing) return <p>{t("updates.installing")}</p>;
  if (state.error) return <p role="alert">{t(state.error === "network" ? "updates.networkError" : state.error === "unsupported" ? "updates.unsupported" : state.error === "permission_required" ? "updates.permission" : "updates.failed")}</p>;
  if (u.ready) return <p>{t(u.kind === "android" ? "updates.readyAndroid" : "updates.readyDesktop")}</p>;
  if (state.status === "checking") return <p>{t("updates.checking")}</p>;
  if (state.status === "downloading") {
    const progress = state.progress;
    return <div className="space-y-2">
      <p>{progress?.total ? t("updates.progress", { percent: new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(Math.min(1, progress.downloaded / progress.total)) }) : t("updates.downloading")}</p>
      <progress className="w-full accent-[var(--brand)]" aria-label={t("updates.downloading")} max={progress?.total || undefined} value={progress?.total ? Math.min(progress.downloaded, progress.total) : undefined} />
    </div>;
  }
  if (state.status === "available") return <div className="space-y-1">
    <p>{t("updates.available", { version: state.update?.version ?? "" })}</p>
    {u.kind === "android" && <p className="text-sm text-ink-muted">{state.update?.sizeBytes
      ? t("updates.askSize", { size: new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(state.update.sizeBytes / 1_000_000) })
      : t("updates.askDownload")}</p>}
  </div>;
  return <p>{t("updates.upToDate")}</p>;
}

export function UpdateActions({ update: u, size = "sm" }: { update: Updates; size?: ButtonSize }) {
  useLocale();
  if (u.installing || u.deferred) return <Button size={size} loading={u.installing} disabled={u.deferred}>{t(u.kind === "android" ? "updates.install" : "updates.restart")}</Button>;
  if (u.state.error === "permission_required") return <>
    <Button size={size} variant="secondary" onClick={() => void u.openPermissionSettings()}>{t("updates.openSettings")}</Button>
    <Button size={size} onClick={() => void u.install()}>{t("updates.install")}</Button>
  </>;
  if (u.state.status === "error") return <Button size={size} onClick={() => void u.retry()}>{t("retry")}</Button>;
  if (u.ready) return <Button size={size} loading={u.installing} disabled={u.deferred} onClick={() => void u.install()}>{t(u.kind === "android" ? "updates.install" : "updates.restart")}</Button>;
  if (u.state.status === "available") return <Button size={size} onClick={() => void u.download()}>{t("updates.download")}</Button>;
  return null;
}
