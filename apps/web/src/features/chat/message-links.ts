/**
 * Link detection for message text.
 *
 * A single left-to-right scan with no backtracking regular expressions (every
 * regular expression here tests one character), so the cost is linear in the
 * text length. Only http://, https:// and bare "www." hosts (opened as
 * https://) are ever linked; every other scheme stays plain text.
 *
 * Rules:
 * - A link starts at the text start or after a character that cannot be part of
 *   a word or URL (space, brackets, quotes, emoji, CJK text...). "xhttp://" and
 *   "foo.www.x.com" do not start a link.
 * - The host is letters, digits, "-", "_" and "." (Unicode letters for IDN,
 *   including CJK inner labels such as "sub.cafe東京.jp"), at most 253
 *   characters with labels of at most 63, checked before any URL parsing. An
 *   optional ":port" follows. "/", "?" or "#" then starts a path that runs
 *   until whitespace, a control/format character, an emoji (flags and skin
 *   tones included), < > " ` or CJK/curly-quote punctuation.
 * - Trailing sentence punctuation (. , ! ? : ;) is dropped, as are closing
 *   brackets without a matching opener, matched in order with a stack (ASCII
 *   and full-width: "/foo)(bar)" and "/archive（draft）/x" are kept whole).
 *   Trailing _ * ~ ' are only dropped when the same character directly
 *   precedes the link ("_https://x.example/a_").
 *
 * Invariant: a link never silently points somewhere other than its text. The
 * text between a link's end and the next visible boundary (whitespace, a
 * control character, emoji or the end) may only be trailing punctuation such
 * as "example.com)," or "/a。". Anything else would make the URL parser, given
 * the whole run, read a different host, port or path than the link
 * ("docs.example。test", "%2Etest", "@evil.example", ":/guide", ":000443",
 * "example.com很好", "/a「b」/c"), so the whole run stays plain. The href is
 * always `new URL()` of the visible text over http(s), and an IPv4 host must
 * be shown in its canonical dotted-decimal form ("192.168.001.1" is octal).
 * IPv6 literal hosts and user-info are not linked.
 *
 * CJK prose often glues a link to punctuation or text with no space; there the
 * visible boundary is the punctuation or the script change, so the underline
 * still shows exactly the destination:
 * - 。 、 ， ！ ？ ； ： 」 』 】 〉 》 ） ］ ｝ end a link when followed by
 *   whitespace, the end, CJK text, CJK punctuation or emoji
 *   ("访问https://example.com。谢谢"), and after a path before anything
 *   ("见https://example.jp/a、b"). 。．｡ directly before an ASCII letter or
 *   digit stay ambiguous ("docs.example。test"): the parser reads a host dot.
 * - CJK text straight after a host whose last label is an ASCII TLD-shaped
 *   run of 2-63 letters ends it ("看这个https://example.com很好"); any other
 *   ASCII/CJK mix in the last label, or a port/path after the CJK, is plain.
 * - Zero-width and bidi controls (and U+FEFF, which JS counts as \s) after a
 *   link are never a boundary.
 * - A break or emoji followed by text that continues the URL stays plain:
 *   "/files/📁/guide", "docs.example。会社。jp/guide" (。 between hostname-like
 *   labels reads as a dot).
 */

import { parseEmojiTextSegments } from "../../lib/custom-emojis.js";

export type LinkToken = { type: "text"; value: string } | { type: "link"; value: string; href: string };

const SCHEMES = ["https://", "http://"] as const;
const WWW = "www.";
const MAX_PORT = 65535;
// DNS limits, checked on the raw text before any URL parsing (and IDNA work).
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

// Characters that may not directly precede a link start.
const BLOCKING_PREFIX = new Set(".-@/:+%&=#$\\");
// Formatting delimiters: allowed directly before a link only at a boundary,
// and stripped from its end only when they also open it.
const DELIMITERS = new Set("_*~'");
const WORD_PREFIX = /[\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}\p{sc=Armenian}\p{N}\p{M}]/u;
// Visible separators that end a URL and are never host characters: curly
// quotes, guillemets, ellipsis, CJK commas/brackets/quotes and full-width
// punctuation. Deliberately not the whole U+3000 block (々 〆 〇 ゝ ヽ are
// text), and not full-width （ ） ［ ］ ｛ ｝, which paths match like ASCII brackets.
const SEPARATORS = "\u2018-\u201F\u00AB\u00BB\u2039\u203A\u2026\u3001\u3008-\u301F\uFF01\uFF02\uFF07\uFF0C\uFF1A-\uFF1F\uFF5F-\uFF60\uFF62-\uFF64";
// Ideographic and full-width full stops (the URL parser reads them as host dots).
const IDNA_DOTS = "\u3002\uFF0E\uFF61";
// Emoji, including flags (regional-indicator pairs) and skin-tone modifiers.
const EMOJI = "\\p{Extended_Pictographic}\\p{Regional_Indicator}\\p{Emoji_Modifier}";
// Non-ASCII characters that always end a URL: spaces, controls, format/bidi
// characters, emoji and the separators above.
const HARD_STOP = new RegExp(`[\\s\\p{Cc}\\p{Cf}\\p{Z}${EMOJI}${SEPARATORS}${IDNA_DOTS}]`, "u");
// Visible boundaries that end the text continuing a link (see the invariant).
// Not JS \\s: it includes U+FEFF, an invisible format character, which must
// never count as a boundary. Controls and \\p{Z} cover every other \\s member.
const WHITESPACE = /[\p{Cc}\p{Z}]/u;
const EMOJI_CHAR = new RegExp(`[${EMOJI}]`, "u");
const RUN_BOUNDARY = new RegExp(`[\\p{Cc}\\p{Z}${EMOJI}]`, "u");
// Parts of an emoji sequence: emoji, ZWJ, variation selector 16, keycap, tags.
const EMOJI_PART = new RegExp(`[${EMOJI}\\u200D\\uFE0F\\u20E3\\u{E0020}-\\u{E007F}]`, "u");
const LABEL_CHAR = /[\p{L}\p{M}\p{N}-]/u;
// Text that may sit between a link and the next boundary without changing
// where the link points: sentence punctuation, closing brackets and quotes.
const TRAILING_CHAR = /^[.,!?:;'"`*_~)\]}>\u2019\u201D\u00BB\u203A\u2026\u3001\u3002\u3009\u300B\u300D\u300F\u3011\u3015\u3017\u3019\u301B\u301E\u301F\uFF01\uFF02\uFF07\uFF09\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF3D\uFF5D\uFF60\uFF61\uFF63\uFF64]$/u;
// CJK sentence punctuation and full-width closers that end a link before CJK
// prose: 。 、 ， ！ ？ ； ： 」 』 】 〉 》 ） ］ ｝.
const CJK_BREAKS = new Set("\u3002\u3001\uFF0C\uFF01\uFF1F\uFF1B\uFF1A\u300D\u300F\u3011\u3009\u300B\uFF09\uFF3D\uFF5D");
// CJK and full-width punctuation (and curly quotes) that may follow a CJK break.
const CJK_PUNCTUATION = /[\u2018-\u201F\u2026\u3001-\u3003\u3008-\u3011\u3014-\u301F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/u;
const HOST_CHAR = /[\p{L}\p{M}\p{N}]/u;
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
const LETTER = /\p{L}/u;
const PORT_FOLLOWER = /[\p{L}\p{N}_@]/u;
const TRAILING = new Set(".,!?:;");
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{", "）": "（", "］": "［", "｝": "｛" };
const OPENERS = new Set(Object.values(CLOSERS));

const isAsciiAlnum = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isDigit = (code: number) => code >= 48 && code <= 57;
const isPathStart = (char: string | undefined) => char === "/" || char === "?" || char === "#";

function charAt(text: string, index: number): string {
  return String.fromCodePoint(text.codePointAt(index)!);
}

function charBefore(text: string, index: number): string | null {
  if (index <= 0) return null;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text[index - 1];
}

function canStartAt(text: string, index: number, allowDelimiter = true): boolean {
  const before = charBefore(text, index);
  if (before === null) return true;
  if (DELIMITERS.has(before)) {
    if (!allowDelimiter) return false;
    let runStart = index - 1; // "**https://..." opens with a run of one delimiter.
    while (runStart > 0 && text[runStart - 1] === before) runStart -= 1;
    return canStartAt(text, runStart, false);
  }
  if (before.length === 1 && (isAsciiAlnum(before.charCodeAt(0)) || BLOCKING_PREFIX.has(before))) return false;
  return !WORD_PREFIX.test(before);
}

/** The formatting delimiter that opens the link at `start`, if any. */
function openingDelimiter(text: string, start: number): string | null {
  const before = start > 0 ? text[start - 1] : null;
  return before !== null && DELIMITERS.has(before) ? before : null;
}

const strippable = (char: string, delimiter: string | null) => TRAILING.has(char) || char === delimiter;

function startsWithIgnoreCase(text: string, index: number, prefix: string): boolean {
  if (index + prefix.length > text.length) return false;
  for (let offset = 0; offset < prefix.length; offset += 1) {
    let code = text.charCodeAt(index + offset);
    if (code >= 65 && code <= 90) code += 32;
    if (code !== prefix.charCodeAt(offset)) return false;
  }
  return true;
}

/** Scans host characters from `index`; returns the index after the host. */
function scanHost(text: string, index: number): number {
  let end = index;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (isAsciiAlnum(code) || code === 45 || code === 46 || code === 95) { end += 1; continue; } // alnum - . _
    if (code < 128) break;
    const char = charAt(text, end);
    if (HARD_STOP.test(char) || !HOST_CHAR.test(char)) break;
    end += char.length;
  }
  return end;
}

/**
 * CJK text glued to the end of a host ("example.com很好"). The script change is
 * the visible boundary when the last label starts with an ASCII TLD-shaped run
 * (letters only, 2-63) directly followed by an ideograph, kana or hangul: a real
 * top-level label is never part ASCII and part CJK, so the underline is the
 * destination. Returns the index where the prose starts, -1 when the host has
 * no such mix, or "ambiguous" for any other ASCII/CJK mix in the last label.
 * Inner labels such as "cafe東京" in "sub.cafe東京.jp" are legitimate IDN.
 */
function proseSuffixStart(text: string, start: number, end: number): number | "ambiguous" {
  while (end > start && text.charCodeAt(end - 1) === 46) end -= 1; // "example.com很好." ends a sentence.
  let labelStart = end;
  while (labelStart > start && text.charCodeAt(labelStart - 1) !== 46) labelStart -= 1; // Bounded by the host.
  if (labelStart >= end) return -1;
  let cjk = -1;
  let ascii = false;
  for (let index = labelStart; index < end; index += charAt(text, index).length) {
    if (text.charCodeAt(index) < 128) ascii = true;
    else if (cjk < 0 && CJK.test(charAt(text, index))) cjk = index;
  }
  if (cjk < 0 || !ascii) return -1;
  const tld = text.slice(labelStart, cjk);
  if (labelStart > start && /^[A-Za-z]{2,63}$/.test(tld)) {
    for (let index = cjk; index < end; index += charAt(text, index).length) {
      if (text.charCodeAt(index) < 128) return "ambiguous"; // "example.com很好abc"
    }
    return cjk;
  }
  return "ambiguous";
}

function isIPv4(labels: string[]): boolean {
  return labels.length === 4 && labels.every((label) => /^\d{1,3}$/.test(label) && Number(label) <= 255);
}

function validHost(host: string, www: boolean): boolean {
  if (host.length > MAX_HOST_LENGTH + 1) return false;
  const labels = host.split(".");
  if (labels.length > 1 && labels.at(-1) === "") labels.pop(); // A fully qualified trailing dot.
  if (labels.some((label) => label === "" || label.length > MAX_LABEL_LENGTH || label.startsWith("-") || label.endsWith("-"))) return false;
  const tld = labels.at(-1)!;
  if (www) return labels.length >= 3 && LETTER.test(tld);
  if (labels.length === 1) return tld.toLowerCase() === "localhost";
  return isIPv4(labels) || LETTER.test(tld);
}

/**
 * Scans a path/query/fragment from `index` (which holds "/", "?" or "#") and
 * trims it, in one pass: brackets are matched in order with a stack while
 * scanning, so the scan stops exactly where the link will end and every
 * character is examined once.
 * - The scan stops at whitespace, controls, < > " `, emoji and separators, and
 *   at the first full-width closer without a matching opener (an unmatched "）"
 *   closes the prose around the link).
 * - Trailing punctuation and ASCII closers without a matching opener are then
 *   dropped; the final ")" in "/foo)(bar)" closes "(bar" and is kept.
 */
function scanPath(text: string, index: number, delimiter: string | null): number {
  const openers: string[] = [];
  const unmatched = new Set<number>();
  let end = index;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (code < 128) {
      if (code <= 32 || code === 127 || code === 60 || code === 62 || code === 34 || code === 96) break; // space, controls, < > " `
    } else if (HARD_STOP.test(charAt(text, end))) break;
    const char = charAt(text, end);
    if (OPENERS.has(char)) openers.push(char);
    else if (CLOSERS[char]) {
      if (openers.at(-1) === CLOSERS[char]) openers.pop();
      else if (code > 127) break;
      else unmatched.add(end);
    }
    end += char.length;
  }
  while (end > index) {
    const char = text[end - 1];
    if (strippable(char, delimiter) || unmatched.has(end - 1)) { end -= 1; continue; }
    break;
  }
  return end;
}

function trimHostEnd(text: string, start: number, end: number, delimiter: string | null): number {
  while (end > start && strippable(text[end - 1], delimiter)) end -= 1;
  return end;
}

function parseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The invariant: the text between a link's end and the next visible boundary
 * (whitespace, a control character, emoji or the end) must be trailing
 * punctuation only. Anything else means the URL parser, given the whole run,
 * would read a different host, port or path than the link shows
 * ("docs.example。test", "%2Etest", "@evil", ":/guide", ":000443",
 * "/a「b」/c"), or at least that the boundary is ambiguous.
 *
 * CJK sentence punctuation (CJK_BREAKS) is itself a visible boundary when
 * followed by whitespace, the end, CJK text, CJK punctuation or emoji
 * ("访问https://example.com。谢谢"); after a path it is a boundary before any
 * character ("见https://example.jp/a、b"). 。 directly followed by an ASCII
 * letter or digit stays ambiguous: the parser reads it as a host dot. So is a
 * break followed by text that continues the URL rather than the prose
 * ("https://example.com。公司.cn/guide", "/你好，世界/index.html"; see
 * continuesUrl). A break directly before a new http(s):// or www. link is a
 * boundary. Returns where the run ends and whether the link is unambiguous.
 */
function checkContinuation(text: string, linkEnd: number, hasPath: boolean): { ok: boolean; end: number } {
  let index = linkEnd;
  while (index < text.length) {
    const char = charAt(text, index);
    // An emoji is a separator unless URL syntax follows it ("/files/📁/guide").
    if (EMOJI_CHAR.test(char)) return continuesUrl(text, index) ? { ok: false, end: skipRun(text, index + char.length) } : { ok: true, end: index };
    if (RUN_BOUNDARY.test(char)) return { ok: true, end: index };
    if (CJK_BREAKS.has(char)) {
      const nextIndex = index + char.length;
      const next = nextIndex < text.length ? charAt(text, nextIndex) : null;
      const asciiAlnum = next !== null && next.length === 1 && isAsciiAlnum(next.charCodeAt(0));
      if (char === "\u3002" && asciiAlnum) break;
      if (startsLink(text, nextIndex)) return { ok: true, end: index };
      if (hasPath || next === null || RUN_BOUNDARY.test(next) || CJK.test(next) || CJK_PUNCTUATION.test(next)) {
        if (continuesUrl(text, nextIndex)) break;
        return { ok: true, end: index };
      }
    }
    if (!TRAILING_CHAR.test(char)) break;
    index += char.length;
  }
  if (index >= text.length) return { ok: true, end: index };
  return { ok: false, end: skipRun(text, index) };
}

/** Skips an ambiguous run to the next visible boundary, which also keeps the scan linear. */
function skipRun(text: string, index: number): number {
  while (index < text.length) {
    const char = charAt(text, index);
    if (RUN_BOUNDARY.test(char)) break;
    index += char.length;
  }
  return index;
}

const LOOKAHEAD_LIMIT = 256;

function startsLink(text: string, index: number): boolean {
  return startsWithIgnoreCase(text, index, "https://") || startsWithIgnoreCase(text, index, "http://") || startsWithIgnoreCase(text, index, WWW);
}

/**
 * Whether the text after a CJK break or an emoji, up to the next whitespace or
 * other CJK break (at most LOOKAHEAD_LIMIT characters), contains URL syntax
 * that would continue this URL, before any new link starts:
 * - "/", "?", "#", "=" or "&";
 * - "." before any letter or digit, or ．｡ before an ASCII letter or digit;
 * - 。 between hostname-like labels is crossed (the parser reads it as a dot);
 *   it counts as URL syntax before an ASCII letter or digit ("会社。jp").
 * Emoji sequences are transparent. "谢谢", "下一句" and "谢谢。再见" are prose;
 * "公司.cn/guide", "会社。jp/guide" and "📁/guide" are not;
 * "谢谢https://b.example/x" is prose then a new link.
 */
function continuesUrl(text: string, index: number): boolean {
  const limit = Math.min(text.length, index + LOOKAHEAD_LIMIT);
  let labelLength = 0;
  let labelLike = true;
  for (let at = index; at < limit;) {
    const char = charAt(text, at);
    const nextAt = at + char.length;
    const next = nextAt < text.length ? charAt(text, nextAt) : "";
    const nextAscii = next.length === 1 && isAsciiAlnum(next.charCodeAt(0));
    if (EMOJI_PART.test(char)) { labelLike = false; at = nextAt; continue; }
    if (WHITESPACE.test(char)) return false;
    // URL syntax from a later link ("谢谢https://b.example/x") is not this link's.
    if (startsLink(text, at) && canStartAt(text, at)) return false;
    if (char === "/" || char === "?" || char === "#" || char === "=" || char === "&") return true;
    if (char === "." && /[\p{L}\p{N}]/u.test(next)) return true;
    if ((char === "\uFF0E" || char === "\uFF61") && nextAscii) return true;
    if (char === "\u3002") {
      if (!labelLike || !labelLength || !/[\p{L}\p{N}]/u.test(next)) return false; // A sentence break.
      if (nextAscii) return true;
      labelLength = 0;
      labelLike = true;
      at = nextAt;
      continue;
    }
    if (CJK_BREAKS.has(char)) return false;
    if (LABEL_CHAR.test(char)) labelLength += 1;
    else labelLike = false;
    at = nextAt;
  }
  return false;
}

const IPV4_HOSTNAME = /^\d{1,3}(?:\.\d{1,3}){3}$/;

interface Match { start: number; end: number; href: string }

/**
 * Tries to read a link at `start`. Returns the match, or where scanning may
 * resume. Failures resume past everything already scanned, which keeps the
 * whole tokenizer linear: no position inside a scheme or host can start a link.
 */
function matchAt(text: string, start: number): Match | { resume: number } {
  const scheme = SCHEMES.find((prefix) => startsWithIgnoreCase(text, start, prefix));
  const www = !scheme && startsWithIgnoreCase(text, start, WWW);
  if (!scheme && !www) return { resume: start + 1 };
  const hostStart = start + (scheme ? scheme.length : 0);
  const scanned = scanHost(text, hostStart);
  const fail = { resume: Math.max(start + 1, scanned) };
  let hostEnd = scanned;
  const prose = proseSuffixStart(text, hostStart, scanned);
  if (prose === "ambiguous") return fail;
  if (prose >= 0) {
    // "example.com很好/x" or "example.com很好:80" reads as one host: leave it plain.
    // Anything else after the CJK ("@x", "%2E") meets the continuation check below.
    const after = text.charCodeAt(scanned);
    if (after === 58 || after === 47 || after === 63 || after === 35 || after === 92) return fail;
    hostEnd = prose;
  }
  const delimiter = openingDelimiter(text, start);
  let end = hostEnd;
  if (text.charCodeAt(end) === 58) { // ":port"
    let portEnd = end + 1;
    while (portEnd < text.length && portEnd - end <= 6 && isDigit(text.charCodeAt(portEnd))) portEnd += 1;
    const digits = portEnd - end - 1;
    const next = portEnd < text.length ? charAt(text, portEnd) : undefined;
    if (digits >= 1 && digits <= 5 && Number(text.slice(end + 1, portEnd)) <= MAX_PORT && (next === undefined || !PORT_FOLLOWER.test(next))) end = portEnd;
  }
  const pathFollows = isPathStart(text[end]);
  // Without a port or path, "example.com." ends a sentence rather than the host.
  const hostLimit = end === hostEnd && !pathFollows ? trimHostEnd(text, hostStart, hostEnd, delimiter) : hostEnd;
  const host = text.slice(hostStart, hostLimit);
  if (!host || !validHost(host, www)) return fail;
  if (end === hostEnd && !pathFollows) end = hostLimit;
  if (pathFollows) end = scanPath(text, end, delimiter);
  // After "example.com很好" the script change is the boundary, but what follows
  // the CJK text must still pass the invariant ("…中文@example.org", "…中文%2Ecn").
  const continuation = checkContinuation(text, prose >= 0 ? scanned : end, pathFollows);
  // Skip the whole ambiguous run, which also keeps the scan linear.
  if (!continuation.ok) return { resume: Math.max(fail.resume, continuation.end) };
  const value = text.slice(start, end);
  const url = parseUrl(scheme ? value : `https://${value}`);
  if (!url) return { resume: continuation.end };
  // "192.168.001.1" or "1.2.3.0x4" parse to a different address than they show.
  if (IPV4_HOSTNAME.test(url.hostname) && url.hostname !== host.toLowerCase().replace(/\.$/, "")) return { resume: continuation.end };
  return { start, end, href: url.href };
}

function couldStart(code: number): boolean {
  return code === 104 || code === 72 || code === 119 || code === 87; // h H w W
}

/** Splits text into plain text and link tokens. Concatenated values equal the input. */
export function tokenizeLinks(text: string): LinkToken[] {
  const tokens: LinkToken[] = [];
  let textStart = 0;
  let index = 0;
  while (index < text.length) {
    if (!couldStart(text.charCodeAt(index)) || !canStartAt(text, index)) { index += 1; continue; }
    const match = matchAt(text, index);
    if ("resume" in match) { index = match.resume; continue; }
    if (match.start > textStart) tokens.push({ type: "text", value: text.slice(textStart, match.start) });
    tokens.push({ type: "link", value: text.slice(match.start, match.end), href: match.href });
    textStart = index = match.end;
  }
  if (textStart < text.length) tokens.push({ type: "text", value: text.slice(textStart) });
  return tokens;
}

/**
 * Every link in message text, in order, as rendered: custom emoji tokens are
 * split out first, so a link never spans one.
 */
export function messageLinks(text: string): Array<{ value: string; href: string }> {
  return parseEmojiTextSegments(text).flatMap((segment) => segment.type === "text"
    ? tokenizeLinks(segment.value).flatMap((token) => token.type === "link" ? [{ value: token.value, href: token.href }] : [])
    : []);
}

export { openExternal as openMessageLink } from "../../platform/external.js";
