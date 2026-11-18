import { expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/index.js";
import { setupDom } from "../../ui/test-utils.js";
import { ReleaseNotesMarkdown } from "./ReleaseNotesMarkdown.js";
import { openExternal } from "../../platform/external.js";

vi.mock("../../platform/external.js", () => ({ openExternal: vi.fn(async () => undefined) }));

const { render, container } = setupDom();
const open = (markdown: string) => render(<ToastProvider><ReleaseNotesMarkdown markdown={markdown} /></ToastProvider>);

it("renders only the supported blocks and inline styles with hardened HTTPS links", async () => {
  await open("## What’s **new**\r\n- One\r\n- Two\r\n\r\nRead [the guide](https://example.com/path?x=1&y=2).\r\nAnother line.");
  const view = container();
  expect(view.querySelector("h3 strong")?.textContent).toBe("new");
  expect(Array.from(view.querySelectorAll("ul > li"), (item) => item.textContent)).toEqual(["One", "Two"]);
  expect(view.querySelector("p")?.textContent).toBe("Read the guide.\nAnother line.");
  const link = view.querySelector("a")!;
  expect(link.href).toBe("https://example.com/path?x=1&y=2");
  expect(link.target).toBe("_blank");
  expect(link.rel).toBe("noopener noreferrer");
  expect(link.className).toContain("min-h-11");
});

it("renders raw HTML, executable URL attempts and unsupported syntax as text", async () => {
  const paragraphs = [
    '<img src=x onerror="alert(1)"> <script>alert(1)</script> &lt;b&gt;',
    "[run](javascript:alert(1)) [data](data:text/html,alert) [insecure](http://example.com) [relative](/example)",
    "[spoof](https://example.com@elsewhere.example) [broken](https://) <https://example.com>",
    "![image](https://example.com/image.png) `[code](https://example.com)` ~~[struck](https://example.com)~~",
    "***triple*** **bold *italic* nested** **~~struck~~** [**bold link**](https://example.com) **[nested](https://example.com)**",
    "> **quoted**\n1. [ordered](https://example.com)\n### **third level**\n    - **indented**",
    "```html\n## Heading inside fence\n- **code**\n```",
  ];
  await open(paragraphs.join("\n\n"));
  const view = container();
  expect(view.querySelector("a, strong, img, script, h3, ul, blockquote, ol, pre, code")).toBeNull();
  expect(Array.from(view.querySelectorAll("p"), (paragraph) => paragraph.textContent)).toEqual(paragraphs);
});

it("preserves underscores inside bold text and link labels while keeping unsupported emphasis literal", async () => {
  await open("Run **new_release_command** or read [release_setup_guide](https://example.com/guide). Keep _literal_ and **a _nested_ span**.");
  const view = container();
  expect(view.querySelector("strong")?.textContent).toBe("new_release_command");
  expect(view.querySelector("a")?.textContent).toBe("release_setup_guide");
  expect(view.querySelectorAll("strong, a")).toHaveLength(2);
  expect(view.textContent).toContain("_literal_ and **a _nested_ span**");
});

it("formats issue references inline and recognises only the supported heading marker", async () => {
  await open("## Changes\n- #123: Fixed **downloads**\n\n#456: Read [the guide](https://example.com/guide).\n### **Unsupported heading**");
  const view = container();
  expect(Array.from(view.querySelectorAll("h3"), (heading) => heading.textContent)).toEqual(["Changes"]);
  expect(view.querySelector("li")?.textContent).toBe("#123: Fixed downloads");
  expect(view.querySelector("li strong")?.textContent).toBe("downloads");
  expect(view.querySelector("p a")?.textContent).toBe("the guide");
  expect(view.querySelector("p")?.textContent).toContain("### **Unsupported heading**");
});

it("renders multiline HTML comments literally and resumes formatting after the closing delimiter", async () => {
  const comment = "<!-- hidden\u2028text\n## Still literal\n\n- [The link](https://example.com) and **bold**\n```\n-->";
  await open(`Before ${comment} **after**\n\n## Visible heading`);
  const view = container();
  expect(view.querySelector("p")?.textContent).toBe(`Before ${comment} after`);
  expect(view.querySelector("a, ul")).toBeNull();
  expect(Array.from(view.querySelectorAll("strong"), (text) => text.textContent)).toEqual(["after"]);
  expect(Array.from(view.querySelectorAll("h3"), (heading) => heading.textContent)).toEqual(["Visible heading"]);
});

it("passes a notes link to the system browser from a native shell", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  await open("[See more](https://example.com/notes)");
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  container().querySelector("a")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(openExternal).toHaveBeenCalledWith("https://example.com/notes");
});
