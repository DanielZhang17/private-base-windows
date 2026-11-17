import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { t, useLocale } from "../../i18n/index.js";
import { formatDate, formatMegabytes } from "../../i18n/format.js";
import { localized } from "../../i18n/messages.js";
// Direct adapter imports keep the public page free of session/store modules.
import { copyText } from "../../platform/clipboard.js";
import { isNative } from "../../platform/environment.js";
import { openExternal } from "../../platform/external.js";
import { useToast } from "../../ui/index.js";
import { checksumGroups, processorLabel, verifyCommand, type ProcessorLabel } from "./format.js";
import { fetchReleaseManifest, isTrustedDownloadUrl, PLATFORM_ORDER, type PlatformKey, type ReleaseManifest } from "./manifest.js";
import { detectPlatform, platformLayout, readPlatformEnvironment, type DetectedPlatform, type PlatformEnvironment } from "./platform.js";
import { useReleaseManifest } from "./useReleaseManifest.js";

/** Same-origin web app entry points. Plain links: the public page never mounts the session. */
export const WEB_APP_HREF = "/login";
export const HOME_HREF = "/";

export type PlatformCard =
  | { key: PlatformKey; available: false }
  | {
    key: PlatformKey;
    available: true;
    version: string;
    size: string;
    minOs: string;
    processor: ProcessorLabel;
    url: string;
    file: string;
    checksum: string;
    checksumGroups: string[];
    /** null on Android and iOS: there is no built-in checksum tool. */
    verifyCommand: string | null;
  };

export function buildPlatformCards(manifest: ReleaseManifest): Record<PlatformKey, PlatformCard> {
  return Object.fromEntries(PLATFORM_ORDER.map((key): [PlatformKey, PlatformCard] => {
    const build = manifest.platforms[key];
    // Defence in depth: never render a link outside the download origin.
    if (!build || !isTrustedDownloadUrl(build.url)) return [key, { key, available: false }];
    return [key, {
      key,
      available: true,
      version: manifest.version,
      size: formatMegabytes(build.size),
      minOs: build.minOs,
      processor: processorLabel(key, build.arch),
      url: build.url,
      file: build.file,
      checksum: build.sha256,
      checksumGroups: checksumGroups(build.sha256),
      verifyCommand: verifyCommand(key, build.file),
    }];
  })) as Record<PlatformKey, PlatformCard>;
}

export interface ClientsPageOptions {
  environment?: PlatformEnvironment;
  loadManifest?: typeof fetchReleaseManifest;
}

/** All logic of the public /clients page: detection, manifest, formatting, copy and links. */
export function useClientsPage({ environment, loadManifest }: ClientsPageOptions = {}) {
  const { locale } = useLocale();
  const toast = useToast();
  // Evaluated once on mount (spec 2).
  const [detected] = useState<DetectedPlatform>(() => detectPlatform(environment ?? readPlatformEnvironment()));
  const layout = useMemo(() => platformLayout(detected), [detected]);
  const { state, retry } = useReleaseManifest(loadManifest);

  useEffect(() => { document.title = t("clients.documentTitle"); }, [locale]);

  const manifest = state.status === "ready" ? state.manifest : null;
  const cards = useMemo(() => (manifest ? buildPlatformCards(manifest) : null), [manifest, locale]);
  const footer = useMemo(
    () => (manifest ? { version: manifest.version, date: formatDate(manifest.published, { dateStyle: "long" }) } : null),
    [manifest, locale],
  );

  const copyChecksum = useCallback(async (key: PlatformKey) => {
    const card = cards?.[key];
    if (!card?.available) return;
    try {
      await copyText(card.checksum);
      toast.show({ tone: "success", message: localized("clients.checksumCopied") });
    } catch {
      toast.show({ tone: "danger", message: localized("clients.copyFailed") });
    }
  }, [cards, toast]);

  /** Native shells hand downloads to the system browser instead of navigating the app window. */
  const onDownloadClick = useCallback((event: MouseEvent<HTMLAnchorElement>, url: string) => {
    if (!isNative() || !isTrustedDownloadUrl(url)) return;
    event.preventDefault();
    void openExternal(url).catch(() => toast.show({ tone: "danger", message: localized("clients.openFailed") }));
  }, [toast]);

  return {
    detected,
    featured: layout.featured,
    others: layout.others,
    status: state.status,
    retrying: state.status === "error" && state.retrying,
    retry,
    cards,
    footer,
    copyChecksum,
    onDownloadClick,
    webAppHref: WEB_APP_HREF,
    homeHref: HOME_HREF,
  };
}
