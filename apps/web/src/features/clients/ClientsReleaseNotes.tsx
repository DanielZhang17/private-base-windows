import { useState } from "react";
import { t, useLocale } from "../../i18n/index.js";
import { formatDate } from "../../i18n/format.js";
import { Badge, Button, Disclosure, Notice, Skeleton } from "../../ui/index.js";
import { PLATFORM_NAME_KEY } from "./format.js";
import { fetchReleaseJson, NOTES_URL } from "./manifest.js";
import { parseReleaseNotes, type ReleaseNoteEntry } from "./releaseNotes.js";
import { ReleaseNotesMarkdown } from "./ReleaseNotesMarkdown.js";
import { useReleaseManifest } from "./useReleaseManifest.js";

const CARD = "rounded-card border border-line bg-surface shadow-raised";

async function loadReleaseNotes(signal: AbortSignal) {
  return parseReleaseNotes(await fetchReleaseJson(NOTES_URL, signal));
}

function ReleaseDate({ published }: { published: string }) {
  return (
    <time dateTime={published} className="text-sm font-normal text-ink-muted">
      {formatDate(new Date(published), { dateStyle: "long" })}
    </time>
  );
}

function ReleasePlatforms({ platforms }: Pick<ReleaseNoteEntry, "platforms">) {
  return (
    <div className="flex flex-wrap gap-2">
      {platforms.map((platform) => <Badge key={platform}>{t(PLATFORM_NAME_KEY[platform])}</Badge>)}
    </div>
  );
}

function OlderRelease({ entry }: { entry: ReleaseNoteEntry }) {
  const [hasOpened, setHasOpened] = useState(false);

  return (
    <Disclosure
      className={`${CARD} px-4 sm:px-6`}
      summary={
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="tabular-nums [overflow-wrap:anywhere]">{entry.version}</span>
          <ReleaseDate published={entry.published} />
        </span>
      }
      summaryClassName="min-h-12 py-2"
      onToggle={(open) => { if (open) setHasOpened(true); }}
    >
      {hasOpened && (
        <div className="space-y-3 border-t border-line py-4">
          <ReleasePlatforms platforms={entry.platforms} />
          <ReleaseNotesMarkdown markdown={entry.notes} />
        </div>
      )}
    </Disclosure>
  );
}

export function ClientsReleaseNotes() {
  const { locale } = useLocale();
  const { state, retry } = useReleaseManifest(loadReleaseNotes);

  if (state.status === "loading") {
    return (
      <div aria-busy="true" className={`${CARD} space-y-4 p-4 sm:p-6`}>
        <span role="status" className="sr-only">{t("clients.notesLoading")}</span>
        <Skeleton className="w-1/4" />
        <Skeleton className="w-3/4" />
        <Skeleton className="w-2/3" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <Notice tone="warning" title={t("clients.notesError")}>
        <Button variant="secondary" loading={state.retrying} className="mt-3" onClick={retry}>
          {t("clients.tryAgain")}
        </Button>
      </Notice>
    );
  }

  const [latest, ...older] = state.data.entries;
  if (!latest) return <Notice>{t("clients.notesEmpty")}</Notice>;

  return (
    <div className="space-y-3">
      {locale !== "en" && <p className="text-sm text-ink-muted">{t("clients.notesEnglish")}</p>}
      <article className={`${CARD} p-4 sm:p-6`}>
        <div className="mb-4 space-y-2 border-b border-line pb-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold tabular-nums [overflow-wrap:anywhere]">{latest.version}</h2>
            <ReleaseDate published={latest.published} />
          </div>
          <ReleasePlatforms platforms={latest.platforms} />
        </div>
        <ReleaseNotesMarkdown markdown={latest.notes} />
      </article>
      {older.map((entry) => <OlderRelease key={entry.version} entry={entry} />)}
    </div>
  );
}
