import { useEmojiText } from "../../features/chat/useEmojiText.js";

export default function InlineEmojiText({ content }: { content: string }) {
  const segments = useEmojiText(content);
  return <span className="whitespace-pre-wrap break-words">{segments.map((segment, index) => segment.src
    ? <img key={index} src={segment.src} alt={segment.value} title={segment.value} className="mx-0.5 inline-block size-5 align-text-bottom" />
    : <span key={index}>{segment.value}</span>)}</span>;
}
