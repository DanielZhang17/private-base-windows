import { t, useLocale } from "../../i18n/index.js";
import { emojiImageUrl, type CustomEmoji } from "../../features/chat/presentation.js";
import { useMemo, useState } from "react";

interface Props {
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

export default function EmojiPickerPopover({ customEmojis, onSelectUnicode, onSelectCustom }: Props) {
  useLocale();
  const [tab, setTab] = useState<"unicode" | "custom">("unicode");
  const sortedCustomEmojis = useMemo(
    () => [...customEmojis].sort((left, right) => left.shortcode.localeCompare(right.shortcode)),
    [customEmojis],
  );

  return (
    <div className="absolute bottom-full end-0 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-card border border-line bg-raised shadow-overlay p-3 z-20">
      <div className="mb-3 flex rounded-control bg-sunken p-1">
        <button
          type="button"
          aria-pressed={tab === "unicode"} className={`min-h-11 flex-1 rounded-control ${tab === "unicode" ? "bg-surface text-ink" : "text-ink-muted"}`}
          onClick={() => setTab("unicode")}
        >
          {t("emoji")}</button>
        <button
          type="button"
          aria-pressed={tab === "custom"} className={`min-h-11 flex-1 rounded-control ${tab === "custom" ? "bg-surface text-ink" : "text-ink-muted"}`}
          onClick={() => setTab("custom")}
        >
          {t("customEmojiTab")}</button>
      </div>

      {tab === "unicode" ? (
        <div className="space-y-3 max-h-72 overflow-y-auto pe-1">
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
      ) : (
        <div className="max-h-72 overflow-y-auto pe-1">
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
      )}
    </div>
  );
}
