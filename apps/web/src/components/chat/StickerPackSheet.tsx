import { useId, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../../i18n/index.js";
import { Button, Dialog, Icon, Notice } from "../../ui/index.js";
import { packTitle, stickerCount, stickerName, stickerNumber, type Sticker } from "../../features/stickers/catalog.js";
import { gridTarget } from "../../features/stickers/picker-model.js";
import { FAVOURITES_LIMIT } from "../../features/stickers/storage.js";
import { useStickerPicker } from "../../features/stickers/useStickerPicker.js";
import { StickerArt, useStickerImage } from "./StickerArt.js";
import StickerTile from "./StickerTile.js";

export interface PackSelection {
  title: string;
  ids: string[];
  selected?: string;
  favourites?: boolean;
}

export function StickerPackSheet({ pack, stickers, onClose }: {
  pack: PackSelection; stickers: Map<string, Sticker>; onClose: () => void;
}) {
  const picker = useStickerPicker();
  const [favourites, setFavourites] = useState(!!pack.favourites);
  const [selected, setSelected] = useState(pack.selected ?? pack.ids[0]);
  const [focusId, setFocusId] = useState<string>();
  const [limit, setLimit] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [undo, setUndo] = useState<() => void>();
  const grid = useRef<HTMLDivElement>(null);
  const limitAction = useRef<HTMLButtonElement>(null);
  const hint = useId();
  const entries = picker?.state.favourites ?? [];
  const ids = favourites ? entries.map(({ id }) => id) : pack.ids;
  const title = favourites ? t("stickerFavourites") : pack.title;
  const count = favourites ? t("stickerFavouritesCount", { current: stickerNumber(entries.length), max: stickerNumber(FAVOURITES_LIMIT) }) : stickerCount(ids.length);
  const activeId = selected && ids.includes(selected) ? selected : ids[0];
  const sticker = stickers.get(activeId);
  const thumbnails = useStickerImage(sticker, "thumb");
  const favourited = entries.some(({ id }) => id === activeId);
  const tabStop = focusId && ids.includes(focusId) ? focusId : activeId;
  const showLimit = () => {
    setLimit(true);
    requestAnimationFrame(() => limitAction.current?.focus());
  };
  const navigate = (event: KeyboardEvent, index: number) => {
    const next = gridTarget(event.key, index, ids.length, document.documentElement.dir === "rtl", event.ctrlKey);
    if (!next || next.page) return;
    event.preventDefault();
    grid.current?.querySelector<HTMLElement>(`[data-sticker-tile="${Math.max(0, next.index)}"]`)?.focus();
  };
  return <Dialog open dismissOnBack={window.matchMedia?.("(max-width: 639px)").matches} onClose={onClose} title={title} description={count}
    closeButtonSize={window.matchMedia?.("(max-width: 639px)").matches ? "md" : "sm"}>
    {limit && <Notice className="mb-3" action={!favourites && <Button ref={limitAction} variant="secondary" size="sm" onClick={() => {
      setFavourites(true);
      requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus());
    }}>{t("stickerFavourites")}</Button>} onDismiss={() => setLimit(false)}>
      {t("stickerFavouritesFull", { max: stickerNumber(FAVOURITES_LIMIT) })}
    </Notice>}
    {saveError && <Notice tone="danger" className="mb-3" onDismiss={() => setSaveError(false)}>{t("stickerFavouritesSaveFailed")}</Notice>}
    {undo && <Notice className="mb-3" onDismiss={() => setUndo(undefined)}
      action={<Button size="sm" variant="secondary" onClick={() => { setUndo(undefined); undo(); }}>{t("undo")}</Button>}>
      {t("stickerRemovedFromFavourites")}
    </Notice>}
    {activeId && <div className="sticker-pack-hero">
      {sticker ? <StickerArt key={sticker.id} sticker={sticker} size="full" retryable alt={stickerName(sticker)} className="size-28 sm:size-32" />
        : <span className="grid size-28 place-items-center text-ink-muted sm:size-32"><Icon name="image" size={28} />{t("stickerUnavailable")}</span>}
      <div className="flex min-w-0 flex-[1_1_13.5rem] flex-col gap-2">
        {sticker && picker?.canSend && <Button leadingIcon="send" fullWidth onClick={() => { if (picker.send(sticker.id)) onClose(); }}>{t("stickerSend")}</Button>}
        {thumbnails.state === "failed" && <Button variant="secondary" leadingIcon="retry" fullWidth onClick={() => void thumbnails.retry()}>
          {t("stickerRetryThumbnails")}
        </Button>}
        {picker && <Button variant="secondary" leadingIcon={favourited ? "star-off" : "star"} fullWidth onClick={() => {
          setSaveError(false);
          void picker.setFavourite(activeId, favourited ? "remove" : "add", {
            onFull: showLimit,
            onError: () => setSaveError(true),
            onRemoved: (restore) => setUndo(() => restore),
          });
        }}>{t(favourited ? "stickerRemoveFavourite" : "stickerAddFavourite")}</Button>}
      </div>
    </div>}
    {!ids.length && <p className="p-4 text-center text-ink-muted">{t("stickerFavouritesEmptyTitle")}</p>}
    <p className="sr-only" id={hint}>{t("stickerSelectToPreview")}</p>
    <div ref={grid} role="group" aria-label={t("stickerPackGrid", { pack: title })} aria-describedby={hint} className="sticker-sheet-grid" data-favourites={favourites || undefined}>
      {ids.map((id, index) => {
        const entry = stickers.get(id);
        return entry ? <StickerTile key={id} sticker={entry} index={index} tabIndex={tabStop === id ? 0 : -1}
          selected={activeId === id} favourited={entries.some((item) => item.id === id)}
          onFocus={() => setFocusId(id)} onActivate={setSelected} onKeyDown={(event) => navigate(event, index)} />
          : <button type="button" key={id} className="sticker-tile bg-sunken text-ink-muted" data-sticker-tile={index} tabIndex={tabStop === id ? 0 : -1}
            aria-pressed={activeId === id} onFocus={() => setFocusId(id)} onClick={() => setSelected(id)} onKeyDown={(event) => navigate(event, index)}
            aria-label={t("stickerUnavailableEntry", { number: stickerNumber(index + 1) })}><Icon name="image" size={24} /></button>;
      })}
    </div>
  </Dialog>;
}

export function packSelection(sticker: Sticker): PackSelection {
  return { title: packTitle(sticker.pack), ids: sticker.pack.stickers.map(({ id }) => id), selected: sticker.id };
}
