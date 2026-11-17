import { t, useLocale } from "../../i18n/index.js";
import { openExternal } from "../../platform/external.js";
import { Button, Disclosure, Field, Select } from "../../ui/index.js";
import { useState } from "react";
import { useAppUpdates } from "./UpdateProvider.js";
import { UpdateActions, UpdateStatus } from "./UpdateStatus.js";

export function AboutUpdates() {
  useLocale();
  const u = useAppUpdates();
  const [linkError, setLinkError] = useState(false);
  if (!u?.kind) return null;
  return <div className="space-y-4">
    <p>{t("updates.currentVersion", { version: u.version ?? t("loadingStatus") })}</p>
    <Field label={t("updates.channel")} help={u.channelLocked ? t("updates.channelLocked") : t("updates.betaHint")}>
      <Select className="min-h-11 rounded-control border border-line bg-surface px-3 text-ink" value={u.channel} disabled={u.channelLocked}
        onChange={event => u.setChannel(event.target.value === "beta" ? "beta" : "stable")}>
        <option value="stable">{t("updates.stable")}</option>
        <option value="beta">{t("updates.beta")}</option>
      </Select>
    </Field>
    <div role="status" aria-live="polite"><UpdateStatus update={u} /></div>
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={u.state.status === "downloading" || u.installing || u.deferred} loading={u.state.status === "checking"} onClick={() => void u.check()}>{t("updates.check")}</Button>
      <UpdateActions update={u} size="md" />
    </div>
    <Disclosure summary={t("updates.releaseNotes")}>
      {u.state.update?.notes && <p className="whitespace-pre-wrap break-words text-sm text-ink-muted">{u.state.update.notes}</p>}
      <a href="https://chat.718788.xyz/clients" className="inline-flex min-h-11 items-center text-sm text-brand underline underline-offset-2"
        onClick={event => { event.preventDefault(); void openExternal("https://chat.718788.xyz/clients").catch(() => setLinkError(true)); }}>{t("updates.releasePage")}</a>
      {linkError && <p role="alert" className="text-danger">{t("updates.linkError")}</p>}
    </Disclosure>
  </div>;
}
