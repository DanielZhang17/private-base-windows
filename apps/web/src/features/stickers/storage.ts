import { getAppDB } from "../../db/index.js";
import type { HistoryTransferStickerPreferences } from "@e2ee-chat/shared";
import { ownsHistoryTransferLease, type HistoryTransferLease } from "../../db/history-transfer-progress.js";

export type StickerTab = "unicode" | "custom" | "stickers";
export const FAVOURITES_LIMIT = 200;
export const RECENT_LIMIT = 30;
export interface Favourite { id: string; addedAt: number }
export interface StickerState {
  tab: StickerTab;
  page: string;
  recent: string[];
  favourites: Favourite[];
}
export const defaultStickerState: StickerState = { tab: "unicode", page: "genshin-1", recent: [], favourites: [] };

export function stickerStateKey(userId: string, deviceId: string) {
  return `stickerPickerState:${encodeURIComponent(userId)}:${encodeURIComponent(deviceId)}`;
}

export async function readStickerState(key: string): Promise<StickerState> {
  return (await (await getAppDB()).get("accountState", key))?.stickerPickerState ?? defaultStickerState;
}

const favouriteListeners = new Map<string, Set<(favourites: Favourite[]) => void>>();
const favouriteSignal = (key: string) => `privatebase:favourites:${key}`;

export function subscribeToFavourites(key: string, listener: (favourites: Favourite[]) => void) {
  const listeners = favouriteListeners.get(key) ?? new Set();
  listeners.add(listener);
  favouriteListeners.set(key, listeners);
  let active = true;
  const refresh = () => {
    void readStickerState(key).then(({ favourites }) => { if (active) listener(favourites); }, () => undefined);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === favouriteSignal(key) && event.newValue) refresh();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", refresh);
  return () => {
    active = false;
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", refresh);
    listeners.delete(listener);
    if (!listeners.size) favouriteListeners.delete(key);
  };
}

export async function updateStickerState(key: string, update: (state: StickerState) => StickerState,
  transfer?: { lease: HistoryTransferLease; current: () => boolean }): Promise<StickerState> {
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const previous = (await tx.store.get(key))?.stickerPickerState ?? defaultStickerState;
  if (transfer && (!await ownsHistoryTransferLease(tx.store, transfer.lease) || !transfer.current())) {
    await tx.done;
    throw new Error("History transfer belongs to another tab or session");
  }
  const next = update(previous);
  if (next !== previous) await tx.store.put({ id: key, value: 1, updatedAt: Date.now(), stickerPickerState: next });
  await tx.done;
  if (next.favourites !== previous.favourites) {
    favouriteListeners.get(key)?.forEach((listener) => listener(next.favourites));
    try {
      const signal = favouriteSignal(key);
      localStorage.setItem(signal, crypto.randomUUID());
      localStorage.removeItem(signal);
    } catch { /* Tabs refresh from IndexedDB when focused if storage is unavailable. */ }
  }
  return next;
}

export function mergeTransferredStickers(state: StickerState, incoming: HistoryTransferStickerPreferences): StickerState {
  const favourites = new Map(state.favourites.map((entry) => [entry.id, entry]));
  for (const entry of [...incoming.favourites].sort((a, b) => b.addedAt - a.addedAt)) {
    if (favourites.size >= FAVOURITES_LIMIT) break;
    if (!favourites.has(entry.id)) favourites.set(entry.id, entry);
  }
  return { ...state, favourites: favourites.size === state.favourites.length ? state.favourites : [...favourites.values()].sort((a, b) => b.addedAt - a.addedAt),
    recent: [...new Set([...state.recent, ...incoming.recent])].slice(0, RECENT_LIMIT) };
}

export function recordRecent(state: StickerState, id: string): StickerState {
  return { ...state, recent: [id, ...state.recent.filter((entry) => entry !== id)].slice(0, RECENT_LIMIT) };
}

export function addFavourite(state: StickerState, entry: Favourite): StickerState {
  if (state.favourites.length >= FAVOURITES_LIMIT || state.favourites.some(({ id }) => id === entry.id)) return state;
  const favourites = [entry, ...state.favourites].sort((left, right) => right.addedAt - left.addedAt);
  return { ...state, favourites };
}

export function removeFavourite(state: StickerState, id: string): StickerState {
  const favourites = state.favourites.filter((entry) => entry.id !== id);
  return favourites.length === state.favourites.length ? state : { ...state, favourites };
}
