import { useNavigate } from "react-router-dom";
import { t, useLocale } from "../../i18n/index.js";
import { formatMegabytes } from "../../i18n/format.js";
import { isKnownUnmeteredConnection } from "./useUpdates.js";
import { Button } from "../../ui/index.js";
import { useAppUpdates } from "./UpdateProvider.js";
import { UpdateActions } from "./UpdateStatus.js";

/** The enclosing chat-list column controls visibility, including on phone detail screens. */
export function UpdateBanner() {
  useLocale();
  const u = useAppUpdates();
  const navigate = useNavigate();
  if (!u?.kind || u.dismissed || u.state.update?.mandatory ||
      !(u.ready || u.state.status === "available" || u.state.status === "error")) return null;
  const title = t(u.state.error ? "updates.bannerError" : u.ready ? "updates.bannerReady" : "updates.bannerAvailable", { version: u.state.update?.version ?? "" });
  const bytes = u.state.update?.sizeBytes;
  const size = bytes !== undefined && Number.isFinite(bytes) && bytes > 0 ? formatMegabytes(bytes) : undefined;
  const metered = u.kind === "android" && !isKnownUnmeteredConnection();
  const availableSummary = metered
    ? size ? t("updates.bannerSizeMetered", { size }) : t("updates.bannerMetered")
    : size;
  const secondary = u.deferred ? t("updates.deferred") : u.installing ? t("updates.installing") :
    u.state.error ? t("updates.failed") : u.state.status === "available" ? availableSummary : undefined;
  return <div className="shrink-0 px-3 py-3 sm:order-last">
    <section role="status" aria-label={t("updates.bannerLabel")} className="min-w-0 rounded-control border border-line bg-brand-soft p-3 text-on-brand-soft">
      <p className="truncate text-sm font-semibold" title={title}>{title}</p>
      {secondary && <p className="mt-1 truncate text-xs" title={secondary}>{secondary}</p>}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={u.later}>{t("updates.later")}</Button>
        {u.state.error && !u.deferred && !u.installing
          ? <Button size="sm" onClick={() => navigate("/settings?section=about")}>{t("updates.about")}</Button>
          : <UpdateActions update={u} />}
      </div>
    </section>
  </div>;
}
