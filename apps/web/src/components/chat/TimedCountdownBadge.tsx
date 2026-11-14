import { t, useLocale } from "../../i18n/index.js";
import { useExpiryLabel } from "../../features/chat/presentation.js";
import { Icon } from "../../ui/index.js";

export default function TimedCountdownBadge({ expiresAt }: { expiresAt: number }) {
  useLocale();
  const label = useExpiryLabel(expiresAt);
  if (!label) return null;
  return <span className="inline-flex items-center gap-1 text-xs tabular-nums" aria-live="off" title={t("expiresIn", { label: label })} aria-label={t("expiresIn", { label: label })}>
    <Icon name="timer" size={14} />{label}
  </span>;
}
