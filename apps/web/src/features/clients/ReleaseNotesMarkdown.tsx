import { Fragment, type MouseEvent } from "react";
import { localized } from "../../i18n/messages.js";
import { isNative } from "../../platform/environment.js";
import { openExternal } from "../../platform/external.js";
import { useToast } from "../../ui/index.js";
import { parseNotesMarkdown } from "./notesMarkdown.js";

export function ReleaseNotesMarkdown({ markdown }: { markdown: string }) {
  const toast = useToast();

  function openLink(event: MouseEvent<HTMLAnchorElement>, url: string) {
    if (!isNative()) return;
    event.preventDefault();
    void openExternal(url).catch(() => toast.show({ tone: "danger", message: localized("clients.notesLinkError") }));
  }

  return (
    <div lang="en" className="space-y-3 whitespace-pre-wrap text-sm leading-6 text-ink-muted [overflow-wrap:anywhere]">
      {parseNotesMarkdown(markdown).map(({ kind, lines }, blockIndex) => {
        const content = lines.map((line, index) => (
          <Fragment key={index}>
            {kind === "paragraph" && index > 0 && "\n"}
            {line.map((part, partIndex) => {
              if (part.kind === "link") {
                return (
                  <a key={partIndex} href={part.href} target="_blank" rel="noopener noreferrer"
                    className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-control align-middle text-brand underline"
                    onClick={(event) => openLink(event, part.href)}>
                    {part.text}
                  </a>
                );
              }
              if (part.kind === "bold") return <strong key={partIndex} className="font-semibold text-ink">{part.text}</strong>;
              return part.text;
            })}
          </Fragment>
        ));
        if (kind === "heading") return <h3 key={blockIndex} className="font-semibold text-ink">{content}</h3>;
        if (kind === "list") {
          return <ul key={blockIndex} className="list-disc space-y-1 ps-5">{content.map((item, index) => <li key={index}>{item}</li>)}</ul>;
        }
        return <p key={blockIndex}>{content}</p>;
      })}
    </div>
  );
}
