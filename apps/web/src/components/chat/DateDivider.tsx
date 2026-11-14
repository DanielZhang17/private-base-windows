import { useLocale } from "../../i18n/index.js";
import { dateLabel } from "../../features/chat/presentation.js";

export function DateDivider({ date }: { date: Date }) {
  useLocale();
  return <div className="py-2 text-center text-xs text-ink-subtle">{dateLabel(date)}</div>;
}
