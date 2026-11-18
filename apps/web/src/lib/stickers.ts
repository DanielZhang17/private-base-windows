import ranges from "../features/stickers/catalog.ids.json";

const token = /^\[\[sticker:genshin:(genshin_hoyolab_([1-9][0-9]*))\]\]$/;

export function parseStickerToken(content: string): string | null {
  const match = token.exec(content);
  // The JS $ anchor can match before a trailing line terminator.
  if (!match || match[0] !== content) return null;
  const number = Number(match[2]);
  return ranges.some(([first, last]) => number >= first && number <= last) ? match[1] : null;
}

export function isSticker(message: { type: string; content: string; deletedAt?: number | null }): boolean {
  return message.type === "text" && !message.deletedAt && parseStickerToken(message.content) !== null;
}

export function stickerToken(id: string): string {
  return `[[sticker:genshin:${id}]]`;
}
