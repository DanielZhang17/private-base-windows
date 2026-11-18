import { t, useLocale } from "../../i18n/index.js";
import { emojiImageUrl, type CustomEmoji } from "../../features/chat/presentation.js";
import { Component, lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { tabTarget } from "../../features/stickers/picker-model.js";
import type { StickerTab } from "../../features/stickers/storage.js";
import { Button, Spinner } from "../../ui/index.js";
import { loadStickerPicker } from "./loadStickerPicker.js";

let pickerChunk = lazy(loadStickerPicker);

class StickerPickerBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    return this.state.failed ? <div className="flex flex-1 flex-col items-center gap-2 p-4">
      <p role="alert" className="text-sm text-ink-muted">{t("stickerPickerUnavailable")}</p>
      <Button variant="secondary" onClick={this.props.onRetry}>{t("retry")}</Button>
    </div> : this.props.children;
  }
}

function LazyStickerPicker() {
  const [{ Picker, attempt }, setPicker] = useState({ Picker: pickerChunk, attempt: 0 });
  const retry = () => {
    pickerChunk = lazy(loadStickerPicker);
    setPicker({ Picker: pickerChunk, attempt: attempt + 1 });
  };
  return <StickerPickerBoundary key={attempt} onRetry={retry}>
    <Suspense fallback={<Spinner label={t("stickerPacks")} />}><Picker /></Suspense>
  </StickerPickerBoundary>;
}

const emojiSections = ["unicode", "custom"] as const;
const allSections = [...emojiSections, "stickers"] as const;
const sectionLabels = { unicode: "emoji", custom: "customEmojiTab", stickers: "stickersTab" } as const;

interface Props {
  id: string;
  presentation: "popover" | "panel";
  panelRef: RefObject<HTMLDivElement | null>;
  focusOnOpen: boolean;
  allowStickers?: boolean;
  tab: StickerTab;
  onTab: (tab: StickerTab) => void;

  customEmojis: CustomEmoji[];
  onSelectUnicode: (emoji: string) => void;
  onSelectCustom: (shortcode: string) => void;
}

const EMOJI_GROUPS = [
  {
    label: "smileys",
    items: ["\u{1F600}", "\u{1F603}", "\u{1F604}", "\u{1F601}", "\u{1F606}", "\u{1F609}", "\u{1F60A}", "\u{1F60D}", "\u{1F618}", "\u{1F61C}", "\u{1F642}", "\u{1F643}", "\u{1F60E}", "\u{1F973}", "\u{1F929}", "\u{1F97A}"],
  },
  {
    label: "gestures",
    items: ["\u{1F44B}", "\u{1F44D}", "\u{1F44E}", "\u{1F64C}", "\u{1F64F}", "\u{1F91D}", "\u{1F44F}", "\u{1F4AA}", "\u{270C}\u{FE0F}", "\u{1F91F}", "\u{1F44C}", "\u{1F90C}", "\u{1F525}", "\u{1F680}", "\u{2728}", "\u{1F389}"],
  },
  {
    label: "hearts",
    items: ["\u{2764}\u{FE0F}", "\u{1FA77}", "\u{1F49B}", "\u{1F49A}", "\u{1F499}", "\u{1FA75}", "\u{1F49C}", "\u{1F90E}", "\u{1F970}", "\u{1F618}", "\u{1F496}", "\u{1F495}", "\u{1F49E}", "\u{1F49D}", "\u{1F4AF}", "\u{2764}\u{FE0F}\u{200D}\u{1F525}"],
  },
  {
    label: "foodFun",
    items: ["\u{2615}", "\u{1F355}", "\u{1F354}", "\u{1F35F}", "\u{1F36A}", "\u{1F36D}", "\u{1F36B}", "\u{1F37F}", "\u{1F381}", "\u{1F3B5}", "\u{1F3AE}", "\u{1F3AF}", "\u{1F4F8}", "\u{2600}\u{FE0F}", "\u{1F3C6}", "\u{1F38A}"],
  },
] as const;

export default function ComposerPicker({ id, presentation, panelRef, focusOnOpen, allowStickers = true, tab: selectedTab, onTab, customEmojis, onSelectUnicode, onSelectCustom }: Props) {
  useLocale();
  const sections: readonly StickerTab[] = allowStickers ? allSections : emojiSections;
  const tab = !allowStickers && selectedTab === "stickers" ? "unicode" : selectedTab;
  const label = t(allowStickers ? "emojiAndStickers" : "addEmoji");
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  useLayoutEffect(() => {
    if (focusOnOpen) tabs.current[sections.indexOf(tab)]?.focus({ preventScroll: true });
  }, [focusOnOpen]);
  const sortedCustomEmojis = useMemo(
    () => [...customEmojis].sort((left, right) => left.shortcode.localeCompare(right.shortcode)),
    [customEmojis],
  );

  return (
    <div ref={panelRef} id={id} role={presentation === "panel" ? "region" : "dialog"} aria-label={label} className={`composer-picker composer-picker-${presentation}`}>
      <div role="tablist" aria-label={label} className="composer-picker-tabs">
        {sections.map((section, index) => <button key={section} type="button"
          ref={(button) => { tabs.current[index] = button; }}
          role="tab" id={`${id}-${section}-tab`} aria-controls={`${id}-${section}`} aria-selected={tab === section} tabIndex={tab === section ? 0 : -1}
          onClick={() => onTab(section)} onKeyDown={(event) => {
            const next = tabTarget(event.key, index, sections.length, document.documentElement.dir === "rtl");
            if (next === undefined) return;
            event.preventDefault();
            onTab(sections[next]);
            tabs.current[next]?.focus({ preventScroll: true });
          }}>
          {t(sectionLabels[section])}
        </button>)}
      </div>

      {sections.filter((section) => section !== tab).map((section) =>
        <div key={section} hidden id={`${id}-${section}`} role="tabpanel" aria-labelledby={`${id}-${section}-tab`} />)}
      <div className="composer-picker-content" id={`${id}-${tab}`} role="tabpanel" aria-labelledby={`${id}-${tab}-tab`}>
      {tab === "unicode" ? (
        <div className="space-y-3 overflow-y-auto p-3">
          {EMOJI_GROUPS.map((group) => (
            <div key={t(group.label)}>
              <p className="text-xs font-medium text-ink-muted mb-2">{t(group.label)}</p>
              <div className="grid grid-cols-6 gap-1">
                {group.items.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="tap-target rounded-control text-xl hover:bg-sunken" aria-label={t("insert", { emoji: emoji })}
                    onClick={() => onSelectUnicode(emoji)}
                    title={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : tab === "custom" ? (
        <div className="overflow-y-auto p-3">
          {sortedCustomEmojis.length === 0 ? (
            <p className="text-sm text-ink-muted">
              {t("noCustomEmojiYetUploadSomeInSettings")}</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {sortedCustomEmojis.map((emoji) => (
                <button
                  key={emoji.id}
                  type="button"
                  className="tap-target flex flex-col items-center gap-1 rounded-control py-2 hover:bg-sunken" aria-label={t("insert2", { shortcode: emoji.shortcode })}
                  onClick={() => onSelectCustom(emoji.shortcode)}
                  title={`:${emoji.shortcode}:`}
                >
                  <img
                    src={emojiImageUrl(emoji.downloadUrl)}
                    alt={`:${emoji.shortcode}:`}
                    className="h-8 w-8 object-contain"
                  />
                  <span className="text-[10px] leading-tight">:{emoji.shortcode}:</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : <LazyStickerPicker />}
      </div>
    </div>
  );
}
