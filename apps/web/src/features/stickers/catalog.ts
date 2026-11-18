import { useEffect, useSyncExternalStore } from "react";
import { getLocale, t } from "../../i18n/index.js";

interface Entry { id: string; n: number; w: number; h: number; alt?: Record<string, string> }
export interface StickerSprite { tileSize: number; sha256: string }
export interface StickerPack {
  id: string; set: number; cover: string; stickers: Entry[];
  sprites: { full: StickerSprite; thumb: StickerSprite };
}
export interface Sticker extends Entry { pack: StickerPack; assetBase: string }
interface Catalog { packs: StickerPack[]; stickers: Map<string, Sticker> }

type CatalogSnapshot = { catalog?: Catalog; failed: boolean };
const initial: CatalogSnapshot = { failed: false };
let snapshot = initial;
let loading = false;
const listeners = new Set<() => void>();

function publish(next: CatalogSnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function loadCatalog() {
  if (loading || snapshot.catalog) return;
  loading = true;
  if (snapshot.failed) publish(initial);
  void import("./catalog.runtime.json").then(({ default: data }) => {
    const packs: StickerPack[] = data.packs;
    const stickers = new Map<string, Sticker>();
    for (const pack of packs) {
      for (const sticker of pack.stickers) stickers.set(sticker.id, { ...sticker, pack, assetBase: data.assetBase });
    }
    loading = false;
    publish({ catalog: { packs, stickers }, failed: false });
  }).catch(() => {
    loading = false;
    publish({ failed: true });
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const getSnapshot = () => snapshot;
const getInitial = () => initial;
const ignore = () => () => undefined;

export function useStickerCatalog(enabled: boolean) {
  const current = useSyncExternalStore(enabled ? subscribe : ignore, enabled ? getSnapshot : getInitial);
  useEffect(() => { if (enabled) loadCatalog(); }, [enabled]);
  return { ...current, retry: loadCatalog };
}

export function stickerNumber(value: number): string {
  return new Intl.NumberFormat(getLocale()).format(value);
}

export function packTitle(pack: StickerPack): string {
  return t("stickerPackTitle", { number: stickerNumber(pack.set) });
}

export function stickerCount(count: number): string {
  return t("stickerCount", { count, total: stickerNumber(count) });
}

export function stickerName(sticker: Sticker): string {
  return sticker.alt?.[getLocale()] ?? sticker.alt?.en ?? t("stickerAlt", {
    pack: packTitle(sticker.pack), number: stickerNumber(sticker.n), total: stickerNumber(sticker.pack.stickers.length),
  });
}
