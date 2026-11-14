import { useState } from "react";
import { useAvatarUpload } from "./useAvatarUpload.js";
import { resolveAvatarImageUrl } from "./avatar.js";
import { getLocale, useLocale, type Locale } from "../../i18n/index.js";
import genshinNames from "./genshin-names.json";

// Names come from the HoYoWiki Character Archive. Both Portuguese UI locales use
// the game's Portuguese names. Slugs are stable across locales and identify the R2 images.
const GENSHIN_NAMES: Record<string, Record<Locale, string>> = genshinNames;

function normalizeCharacterSearch(value: string, locale: Locale) {
  return value.toLocaleLowerCase(locale).normalize("NFKD").replace(/\p{Diacritic}/gu, "");
}

const DICEBEAR_STYLES = [
  "adventurer", "avataaars", "bottts", "fun-emoji",
  "lorelei", "notionists", "pixel-art", "thumbs",
];

function generateSeeds(count: number): string[] {
  return Array.from({ length: count }, () =>
    Math.random().toString(36).slice(2, 10)
  );
}

export function useAvatarPicker(value: string | null, onChange: (avatarUrl: string) => void, onLocalFile?: (file: File) => void) {
  useLocale();
  const locale = getLocale();
  const [tab, setTab] = useState<"genshin" | "dicebear" | "upload">("genshin");
  const [seeds, setSeeds] = useState(() => generateSeeds(8));
  const [search, setSearch] = useState("");
  const { uploading, handleFileUpload, notice, noticeMessage, dismissNotice } = useAvatarUpload(onChange, onLocalFile);

  const query = normalizeCharacterSearch(search.trim(), locale);
  const characters = Object.entries(GENSHIN_NAMES)
    .filter(([slug, names]) => [names[locale], names.en, slug]
      .some((text) => normalizeCharacterSearch(text, locale).includes(query)))
    .map(([slug, names]) => {
      const value = `genshin://${slug}`;
      return { value, name: names[locale], src: resolveAvatarImageUrl(value) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale));

  return {
    tab, setTab, seeds, randomize: () => setSeeds(generateSeeds(8)), search, setSearch,
    uploading, handleFileUpload, notice, noticeMessage, dismissNotice,
    characters,
    generated: DICEBEAR_STYLES.flatMap((style) => seeds.slice(0, 4).map((seed) => ({ value: `dicebear://${style}/${seed}`, name: style, src: resolveAvatarImageUrl(`dicebear://${style}/${seed}`) }))),
    uploadedSrc: resolveAvatarImageUrl(value),
  };
}
