type Inline =
  | { kind: "text" | "bold"; text: string }
  | { kind: "link"; text: string; href: string };

interface Block {
  kind: "heading" | "paragraph" | "list";
  lines: Inline[][];
}

// Underscore delimiters must start and end outside a word, including Unicode identifiers.
const UNDERSCORE_EMPHASIS = /(?:^|[^\p{L}\p{N}\p{M}_])_+(?=[^_\s])[^_]*[^_\s]_+(?![\p{L}\p{N}\p{M}_])/u;
const STRIKETHROUGH = /~~[^~]+~~/;

// Consume unsupported inline constructs as a unit so their contents stay literal.
const INLINE = new RegExp([
  /\\[^\w\s]/, // Escapes
  /`+[^`]+`+/, // Code spans
  /<!--[\s\S]*?(?:-->|$)|<[^<>]*>/, // HTML, comments and autolinks
  /!?\[(?:[^\[\]]|\[[^\[\]]*\])*\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\[\]]*\])?/, // Links, images and references
  /\*+(?=[^*\s])[^*]+\*+/,
  UNDERSCORE_EMPHASIS,
  STRIKETHROUGH,
].map((pattern) => pattern.source).join("|"), "gu");
const BOLD = /^\*\*([^*\[\]`<>\\]+)\*\*$/;
const LINK = /^\[([^\[\]*`<>\\]+)\]\((https:\/\/(?:[^\s\\<>()]|\([^\s\\<>()]*\))+)\)$/i;
const LITERAL_LINE = /^(?:\s|>|#{1,6}(?:[ \t]|$)|[-*+]\s|\d+[.)]\s|\[[^\]]+\]:|(?:[-*_]\s*){3,}$)/;

function hasNestedEmphasis(text: string) {
  return UNDERSCORE_EMPHASIS.test(text) || STRIKETHROUGH.test(text);
}

function httpsUrl(value: string): string | null {
  if (/[\p{Cc}]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function parseInline(line: string, literal = false): { parts: Inline[]; opensComment: boolean } {
  const parts: Inline[] = [];
  let consumed = 0;
  let opensComment = false;
  for (const { 0: token, index } of line.matchAll(INLINE)) {
    if (token.startsWith("<!--") && token.indexOf("-->", 4) === -1) opensComment = true;
    if (literal) continue;
    if (consumed < index) parts.push({ kind: "text", text: line.slice(consumed, index) });
    const bold = BOLD.exec(token)?.[1];
    const link = LINK.exec(token);
    const href = link && httpsUrl(link[2]);
    if (bold && line[index - 1] !== "*" && bold.trim() === bold && !hasNestedEmphasis(bold)) {
      parts.push({ kind: "bold", text: bold });
    } else if (link && href && link[1].trim() && !hasNestedEmphasis(link[1])) {
      parts.push({ kind: "link", text: link[1], href });
    } else {
      parts.push({ kind: "text", text: token });
    }
    consumed = index + token.length;
  }
  if (consumed < line.length) parts.push({ kind: "text", text: line.slice(consumed) });
  return { parts, opensComment };
}

/** Flat blocks and inline spans. Unsupported syntax stays visible as text. */
export function parseNotesMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | undefined;
  let fence: string | undefined;
  let comment: { parts: Inline[]; literal: boolean } | undefined;
  for (const line of markdown.split(/\r\n?|\n/)) {
    if (comment) {
      // A comment can span lines within a paragraph, heading, or list item.
      const end = line.indexOf("-->");
      const { parts, literal } = comment;
      parts.push({ kind: "text", text: "\n" + (end === -1 ? line : line.slice(0, end + 3)) });
      if (end !== -1) {
        const suffix = parseInline(line.slice(end + 3), literal);
        parts.push(...suffix.parts);
        if (!suffix.opensComment) comment = undefined;
      }
      continue;
    }

    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && !marker && !line.trim()) {
      current = undefined;
      continue;
    }

    let kind: Block["kind"] = "paragraph";
    let contents: Inline[];
    if (fence || marker) {
      if (!fence) fence = marker;
      else if (marker && marker.startsWith(fence) && line.trim() === marker) fence = undefined;
      contents = [{ kind: "text", text: line }];
    } else {
      let text = line;
      if (line.startsWith("## ") && line.slice(3).trim()) {
        kind = "heading";
        text = line.slice(3);
      } else if (line.startsWith("- ") && line.slice(2).trim()) {
        kind = "list";
        text = line.slice(2);
      }
      const literal = kind !== "heading" && LITERAL_LINE.test(text);
      const parsed = parseInline(text, literal);
      contents = parsed.parts;
      if (parsed.opensComment) comment = { parts: contents, literal };
    }

    if (kind !== "heading" && current?.kind === kind) current.lines.push(contents);
    else {
      current = { kind, lines: [contents] };
      blocks.push(current);
    }
  }
  return blocks;
}

export function plainTextNotes(markdown: string): string {
  return parseNotesMarkdown(markdown).map(({ kind, lines }) => lines.map((line) =>
    (kind === "list" ? "- " : "") + line.map((part) => part.text).join("")
  ).join("\n")).join("\n\n");
}
