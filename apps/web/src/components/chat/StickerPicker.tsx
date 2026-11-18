import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { t, useLocale } from "../../i18n/index.js";
import { getTopOverlay, OVERLAY_RANK } from "../../ui/overlay-stack.js";
import { ActionMenu, Button, Dialog, Icon, IconButton, Spinner, type ActionMenuPosition } from "../../ui/index.js";
import { packTitle, stickerCount, stickerName, stickerNumber, useStickerCatalog, type Sticker, type StickerPack } from "../../features/stickers/catalog.js";
import { gridTarget, pageAt, pageOffset, tabTarget } from "../../features/stickers/picker-model.js";
import { FAVOURITES_LIMIT } from "../../features/stickers/storage.js";
import { useStickerPicker } from "../../features/stickers/useStickerPicker.js";
import { StickerArt, useStickerImage } from "./StickerArt.js";
import { StickerPackSheet, type PackSelection } from "./StickerPackSheet.js";
import StickerTile from "./StickerTile.js";

const motion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
const rtl = () => document.documentElement.dir === "rtl";

type Page = { id: string; title: string; pack?: StickerPack };
type Preview = { sticker: Sticker; position: ActionMenuPosition; opener: HTMLButtonElement; index: number; pageId: string };

export default function StickerPicker() {
  const picker = useStickerPicker();
  const { catalog, failed, retry } = useStickerCatalog(true);
  if (!catalog || !picker) return <div className="flex flex-1 justify-center p-4">
    {failed ? <Button variant="secondary" onClick={retry}>{t("retry")}</Button> : <Spinner label={t("stickerPacks")} />}
  </div>;
  return <StickerPages picker={picker} packs={catalog.packs} stickers={catalog.stickers} />;
}

function StickerPages({ picker, packs, stickers }: {
  picker: NonNullable<ReturnType<typeof useStickerPicker>>; packs: StickerPack[]; stickers: Map<string, Sticker>;
}) {
  const { locale } = useLocale();
  const id = useId();
  const pages: Page[] = [{ id: "favourites", title: t("stickerFavourites") }, { id: "recent", title: t("stickerRecent") },
    ...packs.map((pack) => ({ id: pack.id, title: packTitle(pack), pack }))];
  const initial = Math.max(0, pages.findIndex((page) => page.id === picker.state.page));
  const [index, setIndex] = useState(initial);
  const [recent, setRecent] = useState(picker.state.recent);
  const { snapshotRecent } = picker;
  const [tabStop, setTabStop] = useState<string>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewImage = useStickerImage(preview?.sticker, "full");
  const [sheet, setSheet] = useState<PackSelection | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const [offline, setOffline] = useState(!navigator.onLine);
  const [visibleCovers, setVisibleCovers] = useState<Set<string>>(() => new Set());
  const strip = useRef<HTMLDivElement>(null);
  const pager = useRef<HTMLDivElement>(null);
  const activePage = useRef<HTMLElement>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocus = useRef<number | "tab" | null>(null);
  const requestedPage = useRef<number | null>(null);
  const activeIndex = useRef(initial);
  const previousStripIndex = useRef(index);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollPositions = useRef(new Map<string, number>());
  const didInteract = useRef(false);
  const current = pages[index];
  const favourites = picker.state.favourites;
  const favouriteIds = new Set(favourites.map(({ id }) => id));
  const shownRecent = recent.filter((entry) => picker.state.recent.includes(entry) && stickers.has(entry));
  const idsFor = (page: Page) => page.pack ? page.pack.stickers.map(({ id: entry }) => entry)
    : page.id === "favourites" ? favourites.map(({ id: entry }) => entry) : shownRecent;
  const countFor = (page: Page) => page.pack ? stickerCount(page.pack.stickers.length) : page.id === "favourites" && favourites.length
    ? t("stickerFavouritesCount", { current: stickerNumber(favourites.length), max: stickerNumber(FAVOURITES_LIMIT) }) : "";

  const scrollTo = (page: number, behaviour: ScrollBehavior = "instant") => {
    const node = pager.current;
    if (!node) return;
    const left = pageOffset(page, node.clientWidth, rtl());
    if (node.scrollTo) node.scrollTo({ left, behavior: behaviour });
    else node.scrollLeft = left;
  };

  function activatePage(next: number, behaviour: ScrollBehavior, focus?: number | "tab") {
    const nextPage = pages[next];
    if (!nextPage) return;
    didInteract.current = true;
    if (behaviour === "smooth" && next !== activeIndex.current && pager.current?.clientWidth) {
      requestedPage.current = next;
      scrollTo(next, behaviour);
      return;
    }
    if (focus !== undefined) pendingFocus.current = focus;
    if (next !== activeIndex.current) {
      activeIndex.current = next;
      setIndex(next);
      setTabStop(undefined);
      void picker.change((state) => ({ ...state, page: nextPage.id }));
    } else if (focus !== undefined) {
      focusCurrent(focus);
      pendingFocus.current = null;
    }
    requestedPage.current = null;
    scrollTo(next);
  }

  function focusCurrent(target: number | "tab") {
    if (target === "tab") {
      tabs.current[activeIndex.current]?.focus({ preventScroll: true });
      return;
    }
    const page = activePage.current;
    if (!page) return;
    const tiles = page.querySelectorAll<HTMLElement>("[data-sticker-tile]");
    (tiles[Math.min(target, tiles.length - 1)] ?? page).focus();
  }

  // The state may arrive after the lazy chunk. Apply the saved page until the user navigates.
  useLayoutEffect(() => {
    if (didInteract.current || initial === activeIndex.current) return;
    activeIndex.current = initial;
    setIndex(initial);
    setRecent(picker.state.recent);
    scrollTo(initial);
  }, [initial, picker.state.recent]);

  useLayoutEffect(() => {
    if (current.id !== "recent") return;
    let active = true;
    void snapshotRecent().then((entries) => { if (active) setRecent(entries); });
    return () => { active = false; };
  }, [current.id, snapshotRecent]);

  useLayoutEffect(() => {
    const node = pager.current;
    if (!node) return;
    const reposition = () => {
      requestedPage.current = null;
      scrollTo(activeIndex.current);
    };
    reposition();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(reposition) : undefined;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [locale]);

  useLayoutEffect(() => {
    const animate = didInteract.current && Math.abs(index - previousStripIndex.current) === 1 && pendingFocus.current === null;
    previousStripIndex.current = index;
    const button = tabs.current[index];
    const bar = strip.current;
    if (button && bar) {
      const bounds = bar.getBoundingClientRect();
      const item = button.getBoundingClientRect();
      if (item.left - bounds.left < 48 || bounds.right - item.right < 48) {
        bar.scrollBy?.({ left: (item.left + item.right - bounds.left - bounds.right) / 2, behavior: animate ? motion() : "instant" });
      }
    }
    if (pendingFocus.current !== null) {
      focusCurrent(pendingFocus.current);
      pendingFocus.current = null;
    }
  }, [index]);

  useEffect(() => {
    const bar = strip.current;
    if (!bar) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const amount = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bar.clientWidth : 1);
      bar.scrollLeft += rtl() ? -amount : amount;
    };
    bar.addEventListener("wheel", wheel, { passive: false });
    const observer = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver((entries) => {
      setVisibleCovers((previous) => {
        const next = new Set(previous);
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.cover!;
          if (entry.isIntersecting) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    }, { root: bar }) : undefined;
    bar.querySelectorAll("[data-cover]").forEach((entry) => observer?.observe(entry));
    return () => { observer?.disconnect(); bar.removeEventListener("wheel", wheel); };
  }, []);

  const settle = () => {
    const node = pager.current;
    if (!node?.clientWidth) return;
    const next = pageAt(node.scrollLeft, node.clientWidth, pages.length);
    if (requestedPage.current !== null && next !== requestedPage.current) return;
    requestedPage.current = null;
    if (next !== activeIndex.current) {
      const wasFocused = activePage.current?.contains(document.activeElement);
      activatePage(next, "instant", wasFocused ? 0 : undefined);
    }
  };
  useEffect(() => {
    const node = pager.current;
    const onEnd = () => { clearTimeout(scrollTimer.current); settle(); };
    node?.addEventListener("scrollend", onEnd);
    return () => { node?.removeEventListener("scrollend", onEnd); };
  });

  useEffect(() => () => clearTimeout(scrollTimer.current), []);
  useEffect(() => {
    const onNetwork = () => setOffline(!navigator.onLine);
    window.addEventListener("online", onNetwork);
    window.addEventListener("offline", onNetwork);
    return () => { window.removeEventListener("online", onNetwork); window.removeEventListener("offline", onNetwork); };
  }, []);
  useEffect(() => {
    if (!didInteract.current || strip.current?.contains(document.activeElement)) return;
    const count = current.pack ? stickerCount(current.pack.stickers.length) : "";
    const announce = setTimeout(() => setAnnouncement(count ? t("stickerPageAnnouncement", { pack: current.title, quantity: count }) : current.title), 300);
    return () => clearTimeout(announce);
  }, [index, locale]);

  const removeRecent = (entry: string) => picker.change((state) => ({ ...state, recent: state.recent.filter((value) => value !== entry) }));
  // Sending updates storage. The page uses its snapshot until it is shown again.
  const send = (entry: string) => { picker.send(entry); };

  function openPreview(sticker: Sticker, position: ActionMenuPosition, opener: HTMLButtonElement, tileIndex: number) {
    opener.focus({ preventScroll: true });
    setPreview({ sticker, position, opener, index: tileIndex, pageId: current.id });
  }

  function restoreRemovedTile(previous: Preview) {
    if (previous.opener.isConnected || document.activeElement !== document.body) return;
    focusCurrent(activePage.current?.querySelector("[data-sticker-tile]") ? previous.index : "tab");
  }

  function navigateGrid(event: KeyboardEvent, tileIndex: number, length: number) {
    const target = gridTarget(event.key, tileIndex, length, rtl(), event.ctrlKey);
    if (!target) return;
    event.preventDefault();
    if (target.page) activatePage(index + target.page, "instant", target.index);
    else focusCurrent(target.index < 0 ? "tab" : target.index);
  }

  return <>
    <div ref={strip} className="sticker-strip" role="tablist" aria-label={t("stickerPacks")}>
      {pages.map((page, i) => {
        const cover = page.pack && stickers.get(page.pack.cover);
        return <Fragment key={page.id}>
          {i === 2 && <span aria-hidden="true" className="sticker-strip-divider" />}
          <button ref={(button) => { tabs.current[i] = button; }} type="button" role="tab" id={`${id}-tab-${i}`} aria-controls={`${id}-page-${i}`}
            data-cover={cover ? page.id : undefined} aria-label={page.title} title={page.title} aria-selected={i === index} tabIndex={i === index ? 0 : -1}
            onClick={(event) => activatePage(i, event.detail && Math.abs(i - index) === 1 ? motion() : "instant")}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); focusCurrent(0); return; }
              const next = tabTarget(event.key, i, pages.length, rtl());
              if (next !== undefined) { event.preventDefault(); activatePage(next, "instant", "tab"); }
            }}>
            {cover ? ((visibleCovers.has(page.id) || (typeof IntersectionObserver === "undefined" && Math.abs(i - index) <= 4)) &&
              <StickerArt sticker={cover} size="thumb" className="size-8" />)
              : <Icon name={i === 0 ? "star" : "clock"} size={22} />}
          </button>
        </Fragment>;
      })}
    </div>
    <div ref={pager} className="sticker-pager" onPointerDownCapture={() => { requestedPage.current = null; }}
      onWheelCapture={() => { requestedPage.current = null; }}
      onScroll={(event) => {
        if (event.target !== event.currentTarget) return;
        clearTimeout(scrollTimer.current);
        scrollTimer.current = setTimeout(settle, 100);
      }}>
      {pages.map((page, i) => {
        const active = i === index;
        const near = Math.abs(i - index) <= 1;
        const ids = near ? idsFor(page) : [];
        const count = countFor(page);
        const recentPage = page.id === "recent";
        return <section key={page.id} ref={(node) => {
          if (active) activePage.current = node;
          if (node && near && scrollPositions.current.has(page.id)) node.scrollTop = scrollPositions.current.get(page.id)!;
        }} className="sticker-page" data-favourites={page.id === "favourites" || undefined} id={`${id}-page-${i}`} role="tabpanel" aria-labelledby={`${id}-tab-${i}`}
          aria-hidden={!active || undefined} inert={!active} tabIndex={-1}
          onScroll={(event) => { if (near) scrollPositions.current.set(page.id, event.currentTarget.scrollTop); }}>
          {near && <>
            <div className="sticker-page-heading">
              <h3 className="min-w-0 flex-1">
                <button type="button" className="sticker-pack-title" title={page.title} aria-haspopup="dialog"
                  aria-label={t("stickerChoosePack", { pack: page.title })} onClick={(event) => {
                    event.currentTarget.focus({ preventScroll: true });
                    setListOpen(true);
                  }}><bdi className="truncate">{page.title}</bdi><Icon name="chevron-down" size={14} className="shrink-0" /></button>
              </h3>
              {count && <bdi className="text-xs tabular-nums text-ink-muted">{count}</bdi>}
              {recentPage ? ids.length > 0 && <Button size="sm" variant="ghost" onClick={(event) => { event.currentTarget.focus(); setManageOpen(true); }}>{t("stickerManageRecent")}</Button>
                : <IconButton icon="more" size="sm" label={t("stickerOpenPack", { pack: page.title })} aria-haspopup="dialog" onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  setSheet({ title: page.title, ids, favourites: !page.pack });
                }} />}
            </div>
            {active && offline && ids.some((entry) => failedImages.has(entry)) && <p role="status" className="sticker-offline"><Icon name="offline" size={16} className="shrink-0 text-warn" />{t("stickerOffline")}</p>}
            {!ids.length && !page.pack && <div className="sticker-empty">
              <span><Icon name={recentPage ? "clock" : "star"} size={24} /></span>
              <strong>{t(recentPage ? "stickerRecentEmptyTitle" : "stickerFavouritesEmptyTitle")}</strong>
              <p>{t(recentPage ? "stickerRecentEmptyBody" : "stickerFavouritesEmptyBody")}</p>
              {!recentPage && <Button size="sm" variant="ghost" onClick={() => activatePage(2, "instant", "tab")}>{t("stickerPacks")}</Button>}
            </div>}
            {ids.length > 0 && <div className="sticker-grid" role="group" aria-label={page.title} aria-describedby={`${id}-hint`}>
              {ids.map((entry, tileIndex) => {
                const sticker = stickers.get(entry);
                const focus = (active && ids.includes(tabStop ?? "") ? tabStop : ids[0]) === entry;
                return sticker ? <StickerTile key={entry} sticker={sticker} index={tileIndex} tabIndex={focus ? 0 : -1}
                  menuOpen={preview?.sticker.id === entry && preview.pageId === page.id}
                  onFocus={() => setTabStop(entry)} onActivate={send}
                  onKeyDown={(event) => navigateGrid(event, tileIndex, ids.length)}
                  onPreview={(position, opener) => openPreview(sticker, position, opener, tileIndex)}
                  canActivate={() => (getTopOverlay()?.rank ?? 0) <= OVERLAY_RANK.picker}
                  onImageState={(state) => setFailedImages((previous) => {
                    const failed = state === "failed";
                    if (previous.has(entry) === failed) return previous;
                    const next = new Set(previous);
                    if (failed) next.add(entry);
                    else next.delete(entry);
                    return next;
                  })} />
                  : <button type="button" key={entry} data-sticker-tile={tileIndex} tabIndex={focus ? 0 : -1}
                    className="sticker-tile bg-sunken text-ink-muted"
                    aria-label={t("stickerRemoveUnavailable", { number: stickerNumber(tileIndex + 1) })}
                    onFocus={() => setTabStop(entry)} onKeyDown={(event) => navigateGrid(event, tileIndex, ids.length)}
                    onClick={() => {
                      void picker.setFavourite(entry, "remove").then(() => requestAnimationFrame(() => focusCurrent(activePage.current?.querySelector("[data-sticker-tile]") ? tileIndex : "tab")));
                    }}><Icon name="image" size={22} /><Icon name="close" size={16} className="absolute bottom-1 end-1" /></button>;
              })}
            </div>}
          </>}
        </section>;
      })}
    </div>
    <p id={`${id}-hint`} className="sr-only">{t("stickerHint")}</p>
    <div role="status" className="sr-only">{announcement}</div>
    {preview && <ActionMenu open title={stickerName(preview.sticker)} position={preview.position} onClose={() => setPreview(null)} previewPlacement="always"
      preview={<div className="sticker-menu-preview">
        <StickerArt sticker={preview.sticker} size="full" className="sticker-menu-art" />
        <span>{t("stickerName", { pack: packTitle(preview.sticker.pack), number: stickerNumber(preview.sticker.n) })}</span>
      </div>} items={[
        { id: "send", icon: "send", label: t("stickerSend"), disabled: !picker.canSend, onSelect: () => send(preview.sticker.id) },
        { id: "favourite", icon: favouriteIds.has(preview.sticker.id) ? "star-off" : "star",
          label: t(favouriteIds.has(preview.sticker.id) ? "stickerRemoveFavourite" : "stickerAddFavourite"),
          onSelect: () => { void picker.setFavourite(preview.sticker.id, favouriteIds.has(preview.sticker.id) ? "remove" : "add").then(() => requestAnimationFrame(() => restoreRemovedTile(preview))); } },
        ...(preview.pageId === "recent" ? [{ id: "recent", icon: "close" as const, label: t("stickerRemoveRecent"), onSelect: () => { void removeRecent(preview.sticker.id).then(() => requestAnimationFrame(() => restoreRemovedTile(preview))); } }] : []),
        ...(previewImage.state === "failed" ? [{ id: "retry", icon: "retry" as const, label: t("retry"), keepOpen: true, onSelect: () => void previewImage.retry() }] : []),
      ]} />}
    {sheet && <StickerPackSheet pack={sheet} stickers={stickers} onClose={() => setSheet(null)} />}
    {listOpen && <Dialog open dismissOnBack={window.matchMedia?.("(max-width: 639px)").matches}
      title={t("stickerPacks")} onClose={() => setListOpen(false)}>
      <ul>{pages.map((page, i) => <li key={page.id}><Button fullWidth variant="ghost"
        className="justify-start text-start" aria-current={i === index || undefined}
        onClick={() => { setListOpen(false); activatePage(i, "instant"); requestAnimationFrame(() => focusCurrent("tab")); }}>
        <bdi>{page.title}</bdi>
      </Button></li>)}</ul>
    </Dialog>}
    {manageOpen && <Dialog open dismissOnBack={window.matchMedia?.("(max-width: 639px)").matches}
      title={t("stickerManageRecent")} onClose={() => { setManageOpen(false); requestAnimationFrame(() => {
        if (!activePage.current?.contains(document.activeElement)) focusCurrent("tab");
      }); }}>
      {!shownRecent.length && <p>{t("stickerRecentEmptyTitle")}</p>}
      <ul>{shownRecent.map((entry, i) => {
        const sticker = stickers.get(entry)!;
        return <li key={entry} className="flex items-center gap-3 border-b border-line py-1">
          <StickerArt sticker={sticker} size="thumb" className="size-11 shrink-0" />
          <span className="min-w-0 flex-1 text-sm">{stickerName(sticker)}</span>
          <IconButton icon="close" size="sm" label={t("stickerRemoveRecentNamed", { name: stickerName(sticker) })} onClick={(event) => {
            const list = event.currentTarget.closest("ul");
            void removeRecent(entry).then(() => requestAnimationFrame(() => {
              const remaining = list?.querySelectorAll("button");
              (remaining?.[Math.min(i, remaining.length - 1)] ?? list?.closest("[role=dialog]")?.querySelector<HTMLButtonElement>("[data-overlay-close]"))?.focus();
            }));
          }} />
        </li>;
      })}</ul>
    </Dialog>}
  </>;
}
