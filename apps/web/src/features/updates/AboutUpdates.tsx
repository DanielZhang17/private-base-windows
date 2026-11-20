import { t, useLocale } from "../../i18n/index.js";
import { localized } from "../../i18n/messages.js";
import { capabilities } from "../../platform/capabilities.js";
import { platformName } from "../../platform/environment.js";
import { openExternal } from "../../platform/external.js";
import { uiBundles, UiRestartError, type UiBundleInfo, type UpdateChannel } from "../../platform/updates.js";
import { Button, ConfirmDialog, Disclosure, Field, Notice, Select, useToast } from "../../ui/index.js";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { useHistoryTransfer } from "../transfer/useHistoryTransfer.js";
import { useAppUpdates } from "./UpdateProvider.js";
import { UpdateActions, UpdateStatus } from "./UpdateStatus.js";

export const PENDING_POLL_MS = 30_000;

/**
 * Reads on each About visit, after every saved channel change (native withdraws the staged
 * bundle then) and, on writable OTA shells, every 30 s and on focus while About is visible.
 */
function useUiBundlePending(channel: UpdateChannel | undefined): [boolean, () => void] {
  const [pending, setPending] = useState(false);
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads(count => count + 1), []);
  useEffect(() => {
    let current = true;
    void uiBundles.getPending().then(version => { if (current) setPending(!!version); });
    return () => { current = false; };
  }, [channel, reads]);
  useEffect(() => {
    if (!capabilities.otaUi) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => { clearInterval(timer); timer = undefined; };
    const start = () => { stop(); timer = setInterval(refresh, PENDING_POLL_MS); };
    const onVisibility = () => { if (document.hidden) stop(); else { refresh(); start(); } };
    const onFocus = () => { if (!document.hidden) refresh(); };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  return [pending, refresh];
}

const TRANSFER_RUNNING = new Set(["transferring", "paused", "reconnecting"]);

/**
 * Desktop only (otaUiRestart). Unavailable while a history transfer runs, so a failed
 * restart can never cost the transfer; asks first when it would end a call.
 */
function RestartNow({ callActive, onNotReady }: { callActive: boolean; onNotReady: () => void }) {
  const toast = useToast();
  const transfer = useHistoryTransfer();
  const transferActive = TRANSFER_RUNNING.has(transfer.phase);
  const hintId = useId();
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  async function restart() {
    setConfirming(false);
    if (transferActive) return;
    setRestarting(true);
    try {
      await uiBundles.restart();
    } catch (error) {
      if (error instanceof UiRestartError && error.code === "not_ready") onNotReady();
      else toast.show({ tone: "danger", message: localized("updates.restartFailed") });
    } finally { setRestarting(false); }
  }
  return <div className="flex shrink-0 flex-col items-end gap-1">
    <Button size="sm" variant="secondary" loading={restarting} disabled={transferActive}
      aria-describedby={transferActive ? hintId : undefined}
      onClick={() => callActive ? setConfirming(true) : void restart()}>{t("updates.restartNow")}</Button>
    {transferActive && <span id={hintId} className="max-w-48 text-end text-xs text-ink-muted">{t("updates.restartTransferHint")}</span>}
    <ConfirmDialog open={confirming && !transferActive} title={t("updates.restartConfirmTitle")}
      description={t("updates.restartEndsCall")}
      confirmLabel={t("updates.restartNow")} onCancel={() => setConfirming(false)} onConfirm={() => void restart()} />
  </div>;
}

function VersionRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-h-11 items-center justify-between gap-3 border-t border-line py-2 first:border-t-0">
    <dt className="text-ink-muted">{label}</dt>
    <dd className="flex flex-wrap items-baseline justify-end gap-x-2 text-end">{children}</dd>
  </div>;
}

function Versions({ appVersion, active, pending, action }: { appVersion: string; active?: UiBundleInfo; pending: boolean; action?: ReactNode }) {
  // Desktop reopening starts a new process; on phones a resume can keep the old one.
  const mobile = platformName() === "android" || platformName() === "ios";
  return <div className="space-y-3">
    <dl>
      <VersionRow label={t("updates.appVersion")}>
        <span className="font-semibold tabular-nums [overflow-wrap:anywhere]">{appVersion}</span>
      </VersionRow>
      {active && <VersionRow label={t("updates.uiVersion")}>
        <span className="font-semibold tabular-nums [overflow-wrap:anywhere]">{active.uiVersion}</span>
        <span className="text-sm text-ink-muted">{t(active.uiSource === "ota" ? "updates.uiUpdated" : "updates.uiBuiltIn")}</span>
      </VersionRow>}
    </dl>
    {pending && <Notice tone="info" action={action}>{t(mobile ? "updates.uiPending" : "updates.uiPendingDesktop")}</Notice>}
  </div>;
}

export function AboutUpdates() {
  useLocale();
  const u = useAppUpdates();
  const [linkError, setLinkError] = useState(false);
  const [pending, refreshPending] = useUiBundlePending(u?.channel);
  const active = uiBundles.getActive();
  const restart = capabilities.otaUiRestart && <RestartNow callActive={!!u?.callActive} onNotReady={refreshPending} />;
  const versions = <Versions appVersion={active?.appVersion ?? u?.version ?? t("loadingStatus")} active={active} pending={pending} action={restart || undefined} />;
  if (!u || (!u.kind && !capabilities.otaUiAvailable)) {
    return active ? versions : null;
  }
  return <div className="space-y-4">
    {versions}
    <Field label={t("updates.channel")} help={uiBundles.isReadOnly() ? undefined : u.channelLocked ? t("updates.channelLocked") : t("updates.betaHint")}>
      <Select className="min-h-11 rounded-control border border-line bg-surface px-3 text-ink" value={u.channel ?? "stable"} disabled={u.channelLocked}
        onChange={event => void u.setChannel(event.target.value === "beta" ? "beta" : "stable")}>
        <option value="stable">{t("updates.stable")}</option>
        <option value="beta">{t("updates.beta")}</option>
      </Select>
    </Field>
    {(u.kind || u.state.error) && <div role="status" aria-live="polite"><UpdateStatus update={u} /></div>}
    {u.kind && <>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!u.channel || u.state.status === "downloading" || u.installing || u.deferred} loading={u.state.status === "checking"} onClick={() => void u.check()}>{t("updates.check")}</Button>
        <UpdateActions update={u} size="md" />
      </div>
      <Disclosure summary={t("updates.releaseNotes")}>
        {u.state.update?.notes && <p className="whitespace-pre-wrap break-words text-sm text-ink-muted">{u.state.update.notes}</p>}
        <a href="https://chat.718788.xyz/clients" className="inline-flex min-h-11 items-center text-sm text-brand underline underline-offset-2"
          onClick={event => { event.preventDefault(); void openExternal("https://chat.718788.xyz/clients").catch(() => setLinkError(true)); }}>{t("updates.releasePage")}</a>
        {linkError && <p role="alert" className="text-danger">{t("updates.linkError")}</p>}
      </Disclosure>
    </>}
  </div>;
}
