import type { CustomEmoji } from "@e2ee-chat/shared";

export interface EmojiTextSegment {
  type: "text" | "emoji";
  value: string;
  emojiId?: string;
  shortcode?: string;
}

const SHORTCODE_REGEX = /:([a-z0-9_]{2,32}):/g;
const TOKEN_REGEX = /\[\[emoji:([a-z0-9]+):([a-z0-9_]{2,32})\]\]/g;

export function serializeCustomEmojiShortcodes(content: string, emojis: CustomEmoji[]): string {
  if (!content.includes(":") || emojis.length === 0) return content;
  const emojiMap = new Map(emojis.map((emoji) => [emoji.shortcode, emoji.id]));
  return content.replace(SHORTCODE_REGEX, (_match, shortcode: string) => {
    const emojiId = emojiMap.get(shortcode);
    if (!emojiId) return `:${shortcode}:`;
    return `[[emoji:${emojiId}:${shortcode}]]`;
  });
}

export function parseEmojiTextSegments(content: string): EmojiTextSegment[] {
  const segments: EmojiTextSegment[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(TOKEN_REGEX)) {
    const fullMatch = match[0];
    const emojiId = match[1];
    const shortcode = match[2];
    const index = match.index ?? 0;

    if (index > lastIndex) {
      segments.push({
        type: "text",
        value: content.slice(lastIndex, index),
      });
    }

    segments.push({
      type: "emoji",
      value: `:${shortcode}:`,
      emojiId,
      shortcode,
    });

    lastIndex = index + fullMatch.length;
  }

  if (lastIndex < content.length) {
    segments.push({
      type: "text",
      value: content.slice(lastIndex),
    });
  }

  return segments.length > 0 ? segments : [{ type: "text", value: content }];
}
