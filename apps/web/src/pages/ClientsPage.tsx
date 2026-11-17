import type { ReactNode } from "react";
import { t, useLocale, type TranslationKey } from "../i18n/index.js";
import { PLATFORM_NAME_KEY, type ProcessorLabel } from "../features/clients/format.js";
import type { PlatformKey } from "../features/clients/manifest.js";
import { useClientsPage, type PlatformCard } from "../features/clients/useClientsPage.js";
import { Badge, Button, cx, Disclosure, Icon, Notice, Skeleton, type IconName } from "../ui/index.js";

type Page = ReturnType<typeof useClientsPage>;
type AvailableCard = Extract<PlatformCard, { available: true }>;

const CARD = "rounded-card border border-line bg-surface shadow-raised";
const H2 = "text-lg leading-6 font-semibold";
const SMALL = "text-[0.8125rem] leading-[1.125rem]";

const PLATFORM_ICON: Record<PlatformKey, IconName> = {
  macos: "laptop",
  windows: "device-desktop",
  android: "device-phone",
  ios: "device-tablet",
};

const INSTALL_NOTE: Record<PlatformKey, { title: TranslationKey; text: TranslationKey }> = {
  macos: { title: "clients.macosNoteTitle", text: "clients.macosNote" },
  windows: { title: "clients.windowsNoteTitle", text: "clients.windowsNote" },
  android: { title: "clients.androidNoteTitle", text: "clients.androidNote" },
  ios: { title: "clients.iosInstallNoteTitle", text: "clients.iosInstallNote" },
};

const VERIFY_INTRO: Record<PlatformKey, TranslationKey> = {
  macos: "clients.verifyMacos",
  windows: "clients.verifyWindows",
  android: "clients.verifyAndroid",
  ios: "clients.verifyIos",
};

function platformName(key: PlatformKey) {
  return t(PLATFORM_NAME_KEY[key]);
}

function processorText(label: ProcessorLabel) {
  return "key" in label ? t(label.key) : label.raw;
}

function Tile({ icon, muted = false }: { icon: IconName; muted?: boolean }) {
  return (
    <span className={cx("grid size-11 shrink-0 place-items-center rounded-control", muted ? "bg-sunken text-ink-muted" : "bg-brand-soft text-on-brand-soft")}>
      <Icon name={icon} size={24} />
    </span>
  );
}

function CardHead({ platform, available, heading }: { platform: PlatformKey; available: boolean; heading: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <Tile icon={PLATFORM_ICON[platform]} muted={!available} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        {heading}
        <Badge tone="neutral">{available ? t("clients.badgeEarlyBuild") : t("clients.badgeComingSoon")}</Badge>
      </div>
    </div>
  );
}

function Facts({ card, compact }: { card: AvailableCard; compact: boolean }) {
  const facts: Array<[string, string]> = [
    [t("clients.factVersion"), card.version],
    [t("clients.factSize"), card.size],
    [t("clients.factRequires"), t("clients.requiresValue", { minOs: card.minOs })],
    [t("clients.factProcessor"), processorText(card.processor)],
  ];
  if (compact) {
    return (
      <dl className="mt-3">
        {facts.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 border-t border-line py-[5px] first:border-t-0">
            <dt className={cx(SMALL, "text-ink-muted")}>{label}</dt>
            <dd className={cx(SMALL, "text-end font-semibold tabular-nums [overflow-wrap:anywhere]")}>{value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-[repeat(4,auto)] sm:justify-start sm:gap-x-8">
      {facts.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs leading-4 text-ink-subtle">{label}</dt>
          <dd className="mt-0.5 font-semibold tabular-nums [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function InstallNote({ platform, featured }: { platform: PlatformKey; featured: boolean }) {
  const note = INSTALL_NOTE[platform];
  return (
    <p className={cx(SMALL, featured ? "mt-4 rounded-control bg-brand-soft p-3 text-on-brand-soft lg:mt-0" : "mt-3 text-ink-muted")}>
      <strong className={cx("mb-0.5 block font-semibold", !featured && "text-ink")}>{t(note.title)}</strong>
      {t(note.text)}
    </p>
  );
}

function IosNote() {
  return (
    <p className={cx(SMALL, "mt-3 text-ink-muted")}>
      <strong className="mb-0.5 block font-semibold text-ink">{t("clients.notAvailableYet")}</strong>
      {t("clients.iosNote")}
    </p>
  );
}

function Verify({ card, page }: { card: AvailableCard; page: Page }) {
  return (
    <Disclosure
      summary={t("clients.verifyDownload")}
      className="-mx-4 -mb-4 mt-4 border-t border-line px-4 sm:-mx-6 sm:-mb-6 sm:px-6 lg:col-span-2"
    >
      <div className={cx(SMALL, "pb-4 text-ink-muted")}>
        <p className="font-semibold text-ink">{t("clients.checksumLabel")}</p>
        <div className="mt-1.5 flex items-start gap-2 rounded-control bg-sunken py-2 pe-2 ps-3">
          <p className="secret-text flex min-w-0 flex-1 flex-wrap gap-x-[0.75em] py-1 text-[0.8125rem] leading-5 text-ink">
            {card.checksumGroups.map((group, index) => <span key={index}>{group}</span>)}
          </p>
          <Button
            variant="secondary"
            leadingIcon="copy"
            className="shrink-0 px-3 text-[0.8125rem]"
            aria-label={t("clients.copyChecksumFor", { platform: platformName(card.key) })}
            onClick={() => void page.copyChecksum(card.key)}
          >
            {t("copy")}
          </Button>
        </div>
        <p className="mt-2.5">
          {t(VERIFY_INTRO[card.key])}
          {card.verifyCommand && <code className="mt-0.5 block font-mono text-xs text-ink [overflow-wrap:anywhere]">{card.verifyCommand}</code>}
        </p>
        <p className="mt-2.5">{t("clients.verifyResult")}</p>
      </div>
    </Disclosure>
  );
}

function DownloadButton({ card, page, featured }: { card: AvailableCard; page: Page; featured: boolean }) {
  const name = platformName(card.key);
  return (
    <Button
      href={card.url}
      variant={featured ? "primary" : "secondary"}
      size={featured ? "lg" : "md"}
      leadingIcon="download"
      className={featured ? "w-full sm:w-auto" : "w-full"}
      aria-label={t("clients.downloadLabel", { platform: name, size: card.size })}
      onClick={(event) => page.onDownloadClick(event, card.url)}
    >
      {t("clients.download", { platform: name })}
    </Button>
  );
}

function FeaturedCard({ card, page }: { card: PlatformCard; page: Page }) {
  const heading = (
    <h2 id="clients-featured" className={H2}>{t("clients.featuredTitle", { platform: platformName(card.key) })}</h2>
  );
  if (!card.available) {
    return (
      <section aria-labelledby="clients-featured" className={cx(CARD, "p-4 sm:p-6")}>
        <CardHead platform={card.key} available={false} heading={heading} />
        {card.key === "ios" ? (
          <>
            <IosNote />
            <div className="mt-4">
              <Button href={page.webAppHref} size="lg" className="w-full sm:w-auto">{t("clients.openWebApp")}</Button>
            </div>
          </>
        ) : <p className={cx(SMALL, "mt-3 text-ink-muted")}>{t("clients.notAvailableYet")}</p>}
      </section>
    );
  }
  return (
    <section aria-labelledby="clients-featured" className={cx(CARD, "p-4 sm:p-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:gap-x-8")}>
      <div className="lg:col-start-1">
        <CardHead platform={card.key} available heading={heading} />
        <Facts card={card} compact={false} />
        <div className="mt-4"><DownloadButton card={card} page={page} featured /></div>
      </div>
      <div className="lg:col-start-2 lg:row-start-1">
        <InstallNote platform={card.key} featured />
      </div>
      <Verify card={card} page={page} />
    </section>
  );
}

function PlatformTile({ card, page }: { card: PlatformCard; page: Page }) {
  const heading = <h3 className="font-semibold leading-[1.375rem]">{platformName(card.key)}</h3>;
  if (!card.available) {
    return (
      <article className={cx(CARD, "flex flex-col p-4 sm:p-6")}>
        <CardHead platform={card.key} available={false} heading={heading} />
        {card.key === "ios" ? (
          <>
            <IosNote />
            <div className="flex-1" />
            <div className="mt-4">
              <Button href={page.webAppHref} variant="secondary" className="w-full">{t("clients.openWebApp")}</Button>
            </div>
          </>
        ) : <p className={cx(SMALL, "mt-3 text-ink-muted")}>{t("clients.notAvailableYet")}</p>}
      </article>
    );
  }
  return (
    <article className={cx(CARD, "flex flex-col p-4 sm:p-6")}>
      <CardHead platform={card.key} available heading={heading} />
      <Facts card={card} compact />
      <InstallNote platform={card.key} featured={false} />
      <div className="flex-1" />
      <div className="mt-4"><DownloadButton card={card} page={page} featured={false} /></div>
      <Verify card={card} page={page} />
    </article>
  );
}

function WebAppSection({ page, featured }: { page: Page; featured: boolean }) {
  return (
    <section aria-labelledby="clients-web" className={featured ? undefined : "mt-8"}>
      <h2 id="clients-web" className={cx(H2, "mb-3")}>{t("clients.noDownloadNeeded")}</h2>
      <div className={cx(CARD, "flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:p-6")}>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Tile icon="globe" />
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold leading-[1.375rem]">{t("clients.webAppTitle")}</h3>
            <p className={cx(SMALL, "mt-0.5 text-ink-muted")}>{t("clients.webAppText")}</p>
          </div>
        </div>
        <Button href={page.webAppHref} variant={featured ? "primary" : "secondary"} className="w-full sm:w-auto">
          {t("clients.webAppButton")}
        </Button>
      </div>
    </section>
  );
}

function SkeletonHead({ width }: { width: string }) {
  return (
    <div className="flex items-center gap-3">
      <Skeleton shape="block" className="size-11 rounded-control" />
      <div className="flex-1"><Skeleton className={width} /></div>
    </div>
  );
}

function LoadingFeatured() {
  return (
    <section aria-busy="true" className={cx(CARD, "p-4 sm:p-6")}>
      <span role="status" className="sr-only">{t("clients.loading")}</span>
      <SkeletonHead width="w-3/5" />
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        <div><Skeleton className="w-1/2" /><Skeleton className="mt-2 w-4/5" /></div>
        <div><Skeleton className="w-1/2" /><Skeleton className="mt-2 w-3/5" /></div>
      </div>
      <Skeleton shape="block" className="mt-4 h-11 rounded-control" />
    </section>
  );
}

function LoadingGrid({ title, announce }: { title: string; announce: boolean }) {
  return (
    <section aria-busy="true" className="mt-8">
      {announce && <span role="status" className="sr-only">{t("clients.loading")}</span>}
      <h2 className={cx(H2, "mb-3")}>{title}</h2>
      <div aria-hidden="true" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className={cx(CARD, "p-4 sm:p-6")}><SkeletonHead width="w-2/5" /></div>
        <div className={cx(CARD, "p-4 sm:p-6")}><SkeletonHead width="w-[45%]" /></div>
      </div>
    </section>
  );
}

function ErrorNotice({ page, className }: { page: Page; className?: string }) {
  return (
    <Notice tone="warning" title={t("clients.errorTitle")} className={className}>
      <p className={SMALL}>{t("clients.errorText")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" loading={page.retrying} onClick={page.retry}>{t("clients.tryAgain")}</Button>
        <Button href={page.webAppHref} variant="ghost">{t("clients.openWebApp")}</Button>
      </div>
    </Notice>
  );
}

function TrustSection() {
  const items = [
    ["clients.trust1Title", "clients.trust1Text"],
    ["clients.trust2Title", "clients.trust2Text"],
    ["clients.trust3Title", "clients.trust3Text"],
  ] as const;
  return (
    <section aria-labelledby="clients-trust" className="mt-8">
      <h2 id="clients-trust" className={cx(H2, "mb-3")}>{t("clients.privacyAndSafety")}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6">
        {items.map(([title, text]) => (
          <div key={title}>
            <h3 className="font-semibold leading-[1.375rem]">{t(title)}</h3>
            <p className={cx(SMALL, "mt-1 text-ink-muted")}>{t(text)}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function PlatformsSection({ page, title }: { page: Page; title: string }) {
  if (!page.cards) return null;
  const cards = page.cards;
  return (
    <section aria-labelledby="clients-platforms" className="mt-8">
      <h2 id="clients-platforms" className={cx(H2, "mb-3")}>{title}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {page.others.map((key) => <PlatformTile key={key} card={cards[key]} page={page} />)}
      </div>
    </section>
  );
}

/** Public download page (/clients). Pure view: all logic lives in features/clients. */
export default function ClientsPage() {
  useLocale();
  const page = useClientsPage();
  const webFeatured = page.featured === "web";
  const gridTitle = webFeatured ? t("clients.allPlatforms") : t("clients.otherPlatforms");

  let body: ReactNode;
  if (page.status === "loading") {
    body = webFeatured ? (
      <><WebAppSection page={page} featured /><LoadingGrid title={gridTitle} announce /></>
    ) : (
      <><LoadingFeatured /><LoadingGrid title={gridTitle} announce={false} /><WebAppSection page={page} featured={false} /></>
    );
  } else if (page.status === "error" || !page.cards) {
    body = webFeatured ? (
      <><WebAppSection page={page} featured /><ErrorNotice page={page} className="mt-8" /><TrustSection /></>
    ) : (
      <><ErrorNotice page={page} /><WebAppSection page={page} featured={false} /><TrustSection /></>
    );
  } else {
    body = page.featured === "web" ? (
      <><WebAppSection page={page} featured /><PlatformsSection page={page} title={gridTitle} /><TrustSection /></>
    ) : (
      <>
        <FeaturedCard card={page.cards[page.featured]} page={page} />
        <PlatformsSection page={page} title={gridTitle} />
        <WebAppSection page={page} featured={false} />
        <TrustSection />
      </>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink">
      <div data-tauri-drag-region="" aria-hidden="true" className="drag-region h-[var(--titlebar-height)] shrink-0 bg-canvas" />
      <div className="min-h-0 flex-1 overflow-y-auto px-safe pt-safe pb-safe">
        {/* Gutters sit outside the 60rem column, as in the mockup. */}
        <div className="px-4 pb-8 sm:px-6 sm:pb-12">
        <div className="mx-auto w-full max-w-[60rem]">
          <header className="flex min-h-14 items-center justify-between gap-3">
            <a href={page.homeHref} className="flex min-h-11 items-center gap-2.5 rounded-control text-base font-semibold text-ink">
              <img src="/brand/icon-rounded.svg" alt="" className="size-8" />
              Private Base
            </a>
            <Button href={page.webAppHref} variant="ghost">{t("clients.signIn")}</Button>
          </header>
          <main>
            <div className="pb-5 pt-4 sm:pb-6 sm:pt-8">
              <h1 className="text-[1.75rem] leading-[2.125rem] font-semibold tracking-[-0.01em]">{t("clients.heading")}</h1>
              <p className="mt-2 max-w-[36rem] text-base leading-6 text-ink-muted">{t("clients.intro")}</p>
            </div>
            {body}
          </main>
          {page.footer && (
            <footer className="mt-8 border-t border-line pt-4 text-xs text-ink-subtle tabular-nums">
              {t("clients.footer", { version: page.footer.version, date: page.footer.date })}
            </footer>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
