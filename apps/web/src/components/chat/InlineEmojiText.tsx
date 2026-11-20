import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { useEmojiText } from "../../features/chat/useEmojiText.js";
import { tokenizeLinks } from "../../features/chat/message-links.js";

export interface MessageTextLinks {
  /** Opens a link. Omitted while links are inert, e.g. in selection mode. */
  onOpen?: (href: string) => void;
}

/**
 * Message text with custom emoji. With `links`, http(s) and www. URLs render as
 * links that show the text exactly as typed; activation goes through `onOpen`
 * (never the browser's own navigation).
 *
 * Privacy: the URL is never in the DOM. A real href lets browsers preload or
 * preconnect on hover/pointerdown (leaking the host and the reader's IP before
 * any tap), so links are role="link" elements without href, and the URL lives
 * only in the click/Enter/middle-click handlers.
 */
export default function InlineEmojiText({ content, links }: { content: string; links?: MessageTextLinks }) {
  const segments = useEmojiText(content);
  const linkify = !!links;
  // Segments derive only from `content`; emoji resolution never changes their text.
  const parts = useMemo(() => segments.map((segment) => segment.type === "emoji" || !linkify ? null : tokenizeLinks(segment.value)), [content, linkify]);
  const onOpen = links?.onOpen;
  const activate = (event: MouseEvent<HTMLElement>, href: string) => {
    event.preventDefault();
    if (!onOpen) return;
    // A drag that selected link text is a selection, not an activation.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.containsNode(event.currentTarget, true)) return;
    onOpen(href);
  };
  // Middle-click fires auxclick, not click. There is no href for a browser
  // default, so it opens through the same helper (a noopener tab on the web).
  const activateAux = (event: MouseEvent<HTMLElement>, href: string) => {
    if (event.button !== 1) return;
    event.preventDefault();
    onOpen?.(href);
  };
  // Without this, a middle press starts autoscroll on Windows and no auxclick follows.
  const pressMiddle = (event: MouseEvent<HTMLElement>) => { if (event.button === 1) event.preventDefault(); };
  // role="link" activates on Enter only (Space scrolls, as for native links).
  const activateKey = (event: KeyboardEvent<HTMLElement>, href: string) => {
    if (event.key !== "Enter" || event.repeat || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onOpen?.(href);
  };
  return <span className="whitespace-pre-wrap break-words">{segments.map((segment, index) => segment.src
    ? <img key={index} src={segment.src} alt={segment.value} title={segment.value} className="mx-0.5 inline-block size-5 align-text-bottom" />
    : <span key={index}>{parts[index]?.map((token, tokenIndex) => token.type === "link"
      // The destination is part of the key: an edit that changes a URL yields a
      // fresh, unfocused element, so a held focus never activates the new URL.
      ? <a key={`${tokenIndex}:${token.href}`} role="link" tabIndex={onOpen ? 0 : -1} data-message-link="" className="message-link" dir="ltr" draggable={false}
        onClick={(event) => activate(event, token.href)} onAuxClick={(event) => activateAux(event, token.href)}
        onMouseDown={pressMiddle} onKeyDown={(event) => activateKey(event, token.href)}>{token.value}</a>
      : token.value) ?? segment.value}</span>)}</span>;
}
