// @vitest-environment node
// Pure module: the node environment uses the platform's native URL parser, as
// browsers do, rather than jsdom's much slower JavaScript implementation.
import { describe, expect, it } from "vitest";
import { messageLinks, tokenizeLinks, type LinkToken } from "./message-links.js";

const links = (text: string) => tokenizeLinks(text).filter((token) => token.type === "link").map((token) => token.value);
const hrefs = (text: string) => messageLinks(text).map((link) => link.href);
const joined = (tokens: LinkToken[]) => tokens.map((token) => token.value).join("");

describe("tokenizeLinks", () => {
  it("splits text and links and preserves every character", () => {
    const text = "See https://example.com/a?b=1#c and www.example.org, ok?";
    const tokens = tokenizeLinks(text);
    expect(tokens).toEqual([
      { type: "text", value: "See " },
      { type: "link", value: "https://example.com/a?b=1#c", href: "https://example.com/a?b=1#c" },
      { type: "text", value: " and " },
      { type: "link", value: "www.example.org", href: "https://www.example.org/" },
      { type: "text", value: ", ok?" },
    ]);
    expect(joined(tokens)).toBe(text);
  });

  it("returns plain text untouched and handles empty input", () => {
    expect(tokenizeLinks("")).toEqual([]);
    expect(tokenizeLinks("no links here.")).toEqual([{ type: "text", value: "no links here." }]);
  });

  it.each([
    ["http://example.com", "http://example.com/"],
    ["https://example.com", "https://example.com/"],
    ["HTTPS://EXAMPLE.COM/Path", "https://example.com/Path"],
    ["HtTp://Example.com", "http://example.com/"],
    ["WWW.EXAMPLE.COM", "https://www.example.com/"],
    ["https://example.com:8443/x", "https://example.com:8443/x"],
    ["http://localhost:5173/chat", "http://localhost:5173/chat"],
    ["http://192.168.1.10:8080", "http://192.168.1.10:8080/"],
    ["https://example.com/search?q=a+b&lang=en#results", "https://example.com/search?q=a+b&lang=en#results"],
    ["https://example.com?x=1", "https://example.com/?x=1"],
    ["https://example.com#top", "https://example.com/#top"],
    ["https://sub_domain.example.com/", "https://sub_domain.example.com/"],
    ["https://example.com/a%20b/~user", "https://example.com/a%20b/~user"],
    ["https://medium.com/@user/post", "https://medium.com/@user/post"],
  ])("links %s", (text, href) => {
    expect(links(text)).toEqual([text]);
    expect(hrefs(text)).toEqual([href]);
  });

  it("keeps CJK inside inner host labels rather than linking a different host", () => {
    expect(tokenizeLinks("https://sub.cafe東京.jp/menu")).toEqual([{ type: "link", value: "https://sub.cafe東京.jp/menu", href: "https://sub.xn--cafe-8x5f052k.jp/menu" }]);
    expect(links("去 www.cafe東京.jp 吧")).toEqual(["www.cafe東京.jp"]);
    expect(hrefs("https://shop东京.example/x")).toEqual(["https://xn--shop-od5fx3a.example/x"]);
  });

  it.each([
    "https://example.com很好/path",
    "https://example.com很好?q=1",
    "https://example.com很好#x",
    "https://example.com很好:8080/",
    "www.example.com很好/path",
  ])("leaves an ambiguous CJK host boundary plain: %s", (text) => {
    expect(links(text)).toEqual([]);
    expect(joined(tokenizeLinks(text))).toBe(text);
  });

  it("supports IDN and punycode hosts, keeping the typed text", () => {
    expect(tokenizeLinks("https://bücher.de/ok")).toEqual([{ type: "link", value: "https://bücher.de/ok", href: "https://xn--bcher-kva.de/ok" }]);
    expect(hrefs("https://xn--bcher-kva.de")).toEqual(["https://xn--bcher-kva.de/"]);
    expect(links("访问 https://例子.中国/路径 吧")).toEqual(["https://例子.中国/路径"]);
    expect(links("www.пример.рф")).toEqual(["www.пример.рф"]);
    expect(hrefs("https://zh.wikipedia.org/wiki/中国")).toEqual(["https://zh.wikipedia.org/wiki/%E4%B8%AD%E5%9B%BD"]);
  });

  it.each([
    ["Go to https://example.com.", "https://example.com"],
    ["https://example.com/path.", "https://example.com/path"],
    ["Really? https://example.com/a!", "https://example.com/a"],
    ["https://example.com/a?", "https://example.com/a"],
    ["https://example.com, then", "https://example.com"],
    ["https://example.com/x;", "https://example.com/x"],
    ["at https://example.com: look", "https://example.com"],
    ["https://example.com/x...", "https://example.com/x"],
    ["(see https://example.com)", "https://example.com"],
    ["(see https://example.com/path)", "https://example.com/path"],
    ["[https://example.com/a]", "https://example.com/a"],
    ["{https://example.com/a}", "https://example.com/a"],
    ["'https://example.com/a'", "https://example.com/a"],
    ["\"https://example.com/a\"", "https://example.com/a"],
    ["“https://example.com/a”", "https://example.com/a"],
    ["«https://example.com/a»", "https://example.com/a"],
    ["`https://example.com/a`", "https://example.com/a"],
    ["<https://example.com/a>", "https://example.com/a"],
    ["https://example.com/a).", "https://example.com/a"],
    ["*https://example.com/a*", "https://example.com/a"],
    ["_https://example.com/a_", "https://example.com/a"],
    ["~https://example.com/a~", "https://example.com/a"],
    ["**https://example.com/a**.", "https://example.com/a"],
    ["_www.example.com_", "www.example.com"],
    ["https://example.com/a…", "https://example.com/a"],
  ])("trims trailing punctuation in %s", (text, link) => {
    expect(links(text)).toEqual([link]);
  });

  it("matches full-width brackets in paths like ASCII ones", () => {
    expect(links("https://example.com/archive（draft）/index.html")).toEqual(["https://example.com/archive（draft）/index.html"]);
    expect(links("（https://example.com/a）")).toEqual(["https://example.com/a"]);
    expect(links("（见https://example.com/a（b））")).toEqual(["https://example.com/a（b）"]);
    expect(links("https://example.com/a［1］")).toEqual(["https://example.com/a［1］"]);
  });

  it.each([
    "https://example.com/archive「draft」/index.html",
    "https://example.com/a<b",
    "https://example.com/a\"b",
    "https://example.com/a`b",
    "https://example.com/a…b",
    "https://example.com/a。b",
  ])("leaves a path that continues past a separator plain: %s", (text) => {
    expect(links(text)).toEqual([]);
    expect(joined(tokenizeLinks(text))).toBe(text);
  });

  it.each([
    ["http://192.168.001.1/", "plain"],
    ["http://010.0.0.1", "plain"],
    ["http://1.2.3.0x4", "plain"],
    ["http://example.0x10", "plain"],
    ["http://0x7f.0.0.1", "plain"],
    ["http://192.168.1.1/x", "http://192.168.1.1/x"],
    ["http://10.0.0.1.", "http://10.0.0.1"],
  ])("only links IPv4 hosts shown in canonical form: %s", (text, expected) => {
    expect(links(text)).toEqual(expected === "plain" ? [] : [expected]);
  });

  it("treats flag and skin-tone emoji as boundaries", () => {
    expect(links("https://example.com🇯🇵")).toEqual(["https://example.com"]);
    expect(links("https://example.com/a🇯🇵 b")).toEqual(["https://example.com/a"]);
    expect(links("🇯🇵https://example.com/a🇯🇵")).toEqual(["https://example.com/a"]);
    expect(links("https://example.com/a👍🏽")).toEqual(["https://example.com/a"]);
    expect(links("https://example.com🇯🇵evil")).toEqual(["https://example.com"]);
  });

  it("bounds host and label length before parsing", () => {
    const label = "a".repeat(63);
    expect(links(`https://${label}.example`)).toEqual([`https://${label}.example`]);
    expect(links(`https://${label}a.example`)).toEqual([]);
    const host = `${"a".repeat(49)}.`.repeat(5) + "example"; // 257 characters
    expect(links(`https://${host}`)).toEqual([]);
    expect(links(`https://${"例".repeat(64)}.中国`)).toEqual([]);
  });

  it("matches brackets in order", () => {
    expect(links("https://example.com/foo)(bar)")).toEqual(["https://example.com/foo)(bar)"]);
    expect(links("https://example.com/a)(b")).toEqual(["https://example.com/a)(b"]);
    expect(links("https://example.com/(a]")).toEqual(["https://example.com/(a"]);
    expect(links("https://example.com/[a(b])")).toEqual(["https://example.com/[a(b])"]);
    expect(links("https://example.com/[a(b]")).toEqual(["https://example.com/[a(b"]);
    expect(links("(https://example.com/x_(y))")).toEqual(["https://example.com/x_(y)"]);
  });

  it("keeps CJK iteration marks and other text from the U+3000 block in paths", () => {
    expect(links("https://ja.wikipedia.org/wiki/佐々木")).toEqual(["https://ja.wikipedia.org/wiki/佐々木"]);
    expect(links("https://example.jp/〆切/ゝゞヽヾ〇")).toEqual(["https://example.jp/〆切/ゝゞヽヾ〇"]);
    expect(links("https://example.jp/a、 b")).toEqual(["https://example.jp/a"]);
    expect(links("https://example.jp/a、b")).toEqual(["https://example.jp/a"]);
    expect(links("https://example.jp/a」")).toEqual(["https://example.jp/a"]);
  });

  it("keeps balanced parentheses, as in Wikipedia URLs", () => {
    expect(links("https://en.wikipedia.org/wiki/Mercury_(planet)")).toEqual(["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
    expect(links("(https://en.wikipedia.org/wiki/Mercury_(planet))")).toEqual(["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
    expect(links("see https://en.wikipedia.org/wiki/Mercury_(planet).")).toEqual(["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
    expect(links("https://example.com/a[1]")).toEqual(["https://example.com/a[1]"]);
    expect(links("https://example.com/(a")).toEqual(["https://example.com/(a"]);
  });

  it.each([
    ["https://example.com/files/report_", "https://example.com/files/report_"],
    ["https://example.com/a*", "https://example.com/a*"],
    ["https://example.com/~", "https://example.com/~"],
    ["https://example.com/it'", "https://example.com/it'"],
    ["see https://example.com/files/report_.", "https://example.com/files/report_"],
    ["*https://example.com/a_", "https://example.com/a_"],
  ])("keeps a trailing _ * ~ ' without a matching opener: %s", (text, link) => {
    expect(links(text)).toEqual([link]);
    expect(hrefs(text)).toEqual([link]);
  });

  it("only treats delimiters before a link as formatting at a word boundary", () => {
    expect(links("snake_https://example.com")).toEqual([]);
    expect(links("a*www.example.com*")).toEqual([]);
    expect(links("(_https://example.com/a_)")).toEqual(["https://example.com/a"]);
  });

  it("keeps a trailing slash and inner punctuation", () => {
    expect(links("https://example.com/a/")).toEqual(["https://example.com/a/"]);
    expect(links("https://example.com/a.b,c!d?e=f.g")).toEqual(["https://example.com/a.b,c!d?e=f.g"]);
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "intent://scan/#Intent;scheme=zxing;end",
    "tel:+15555550123",
    "mailto:someone@example.com",
    "ftp://example.com/file",
    "ws://example.com/socket",
    "vbscript:msgbox",
    "chrome://settings",
    "about:blank",
    "example.com",
    "someone@example.com",
    "http://",
    "https://",
    "https:// example.com",
    "www.",
    "www.example",
    "https://.com",
    "https://example..com",
    "https://-example.com",
    "https://example-.com",
    "https://example.123",
    "https://singlelabel",
    "http://[::1]:8080/",
    "https:/example.com",
    "https//example.com",
  ])("does not link %s", (text) => {
    expect(links(text)).toEqual([]);
    expect(joined(tokenizeLinks(text))).toBe(text);
  });

  it("only ever produces http and https hrefs", () => {
    const hostile = "javascript:https://evil.example data:https://x.example file://www.a.example intent:http://b.example";
    for (const href of hrefs(hostile)) expect(href).toMatch(/^https?:\/\//);
  });

  it("requires a word boundary before a link", () => {
    expect(links("xhttps://example.com")).toEqual([]);
    expect(links("foo.www.example.com")).toEqual([]);
    expect(links("awww.example.com")).toEqual([]);
    expect(links("éhttps://example.com")).toEqual([]);
    expect(links("1https://example.com")).toEqual([]);
    expect(links("file://www.example.com/x")).toEqual([]);
    expect(links("https://http://example.com")).toEqual([]);
  });

  it("does not link user-info URLs, whose real host is hidden", () => {
    expect(links("https://bank.example@evil.example/login")).toEqual([]);
    expect(links("www.bank.example@evil.example")).toEqual([]);
  });

  it.each([
    "http://example.com:99999/x",
    "http://example.com:80abc",
    "https://example.com:/guide",
    "https://example.com:000443/guide",
    "https://example.com:443x/guide",
    "https://example.com::443",
  ])("leaves port spellings the scan does not agree with plain: %s", (text) => {
    expect(links(text)).toEqual([]);
  });

  it("keeps valid ports, including ones the parser normalises", () => {
    expect(links("http://example.com:8080.")).toEqual(["http://example.com:8080"]);
    expect(hrefs("https://example.com:0443/x")).toEqual(["https://example.com/x"]);
    expect(links("(https://example.com:8443)")).toEqual(["https://example.com:8443"]);
    expect(links("http://example.com．:443")).toEqual([]);
  });

  it.each([
    "https://docs.example。test/guide",
    "https://docs.example．test/guide",
    "https://docs.example｡test/guide",
    "https://docs.example%2Etest/guide",
    "https://docs.example%2etest",
    "www.docs.example。test",
    "https://example.com,evil.example",
    "https://example.com\u200Bevil",
    "https://example.com)evil",
    "https://example.com)/path",
    "https://example.com\\evil.example",
    "https://example.com，evil.example",
    "https://example.com、x",
    "https://example.com。2",
    "访问https://example.com。test谢谢",
  ])("leaves hosts the browser would read differently plain: %s", (text) => {
    expect(links(text)).toEqual([]);
    expect(joined(tokenizeLinks(text))).toBe(text);
  });

  it.each([
    ["https://example.com。", "https://example.com"],
    ["https://example.com。。", "https://example.com"],
    ["see https://example.com.)", "https://example.com"],
    ["https://example.com」", "https://example.com"],
    ["https://example.com、", "https://example.com"],
    ["https://example.com， 很好", "https://example.com"],
    ["https://example.com．", "https://example.com"],
    ["https://example.com！", "https://example.com"],
  ])("keeps a host followed only by punctuation or a visible separator: %s", (text, link) => {
    expect(links(text)).toEqual([link]);
  });

  it("stops at bidi and zero-width format characters", () => {
    // The run continues past the hidden character, so the boundary is ambiguous.
    expect(links("https://example.com/a\u202Egnp.exe")).toEqual([]);
    expect(links("https://example.com/a\u200Bb")).toEqual([]);
    expect(links("https://example.com/a\u2066b")).toEqual([]);
    expect(links("https://example.com/a\u202E")).toEqual([]);
    expect(links("https://exa\u200Bmple.com")).toEqual([]);
  });

  describe("CJK prose glued to a link", () => {
    it.each([
      ["访问https://example.com。谢谢", "https://example.com", "https://example.com/"],
      ["https://example.com/a。下一句", "https://example.com/a", "https://example.com/a"],
      ["见https://example.jp/a、b", "https://example.jp/a", "https://example.jp/a"],
      ["见https://example.jp/a」b", "https://example.jp/a", "https://example.jp/a"],
      ["打开https://example.com，然后", "https://example.com", "https://example.com/"],
      ["是https://example.com！对", "https://example.com", "https://example.com/"],
      ["是https://example.com？", "https://example.com", "https://example.com/"],
      ["是https://example.com；下", "https://example.com", "https://example.com/"],
      ["网址：https://example.com：好", "https://example.com", "https://example.com/"],
      ["「https://example.com」です", "https://example.com", "https://example.com/"],
      ["『https://example.com/a』と", "https://example.com/a", "https://example.com/a"],
      ["【https://example.com】한국", "https://example.com", "https://example.com/"],
      ["《https://example.com/a》。", "https://example.com/a", "https://example.com/a"],
      ["（https://example.com/a）谢谢", "https://example.com/a", "https://example.com/a"],
      ["（https://example.com）谢谢", "https://example.com", "https://example.com/"],
      ["https://example.com/a）b", "https://example.com/a", "https://example.com/a"],
      ["https://example.com。🎉", "https://example.com", "https://example.com/"],
      ["https://example.com。「下」", "https://example.com", "https://example.com/"],
      ["https://example.com、 next", "https://example.com", "https://example.com/"],
      ["看这个https://example.com很好", "https://example.com", "https://example.com/"],
      ["看这个https://example.com很好。", "https://example.com", "https://example.com/"],
      ["看这个www.example.jp很好.", "www.example.jp", "https://www.example.jp/"],
      ["https://example.co.jpです", "https://example.co.jp", "https://example.co.jp/"],
      ["https://example.com한국어", "https://example.com", "https://example.com/"],
      ["https://example.com中文。谢谢", "https://example.com", "https://example.com/"],
      ["https://example.com中文 ok", "https://example.com", "https://example.com/"],
      ["https://example.com/a。下一句。再见", "https://example.com/a", "https://example.com/a"],
      ["访问https://a.example/x。谢谢", "https://a.example/x", "https://a.example/x"],
    ])("links %s up to the boundary", (text, link, href) => {
      expect(tokenizeLinks(text).filter((token) => token.type === "link")).toEqual([{ type: "link", value: link, href }]);
      expect(joined(tokenizeLinks(text))).toBe(text);
    });

    it.each([
      "https://example.com。公司.cn/guide",
      "https://example.com/你好，世界/index.html",
      "https://example.com/a，参数=1",
      "https://example.com/a、页面?x",
      "https://example.com/a」见b.com",
      "https://example.com。谢谢#top",
      "www.example.com中文@example.org",
      "https://example.com中文%2Ecn",
      "https://example.com中文&x",
      "https://docs.example。test",
      "https://docs.example。test/guide",
      "https://docs.example．test/guide",
      "https://docs.example｡test",
      "https://example.com/a。b",
      "https://example.com/a。1",
      "看这个https://example.com很好/path",
      "看这个https://example.com很好:8080",
      "看这个https://example.com很好abc",
      "看这个https://example.c1很好",
      "看这个https://example.c很好",
      "看这个https://ex.co1m很好",
      "https://example.com。\u200B谢谢",
      "https://example.com\u200B谢谢",
      "https://example.com\u202E谢谢",
      "https://example.com/a\u202E谢谢",
    ])("keeps ambiguous CJK boundaries plain: %s", (text) => {
      expect(links(text)).toEqual([]);
    });
  });

  it("separates emoji and CJK text around links", () => {
    expect(links("🎉https://example.com🎉")).toEqual(["https://example.com"]);
    expect(links("看这个https://example.com/a很好")).toEqual(["https://example.com/a很好"]);
    expect(links("看这个 https://example.com 很好")).toEqual(["https://example.com"]);
    expect(links("链接：https://example.com/a。下一句")).toEqual(["https://example.com/a"]);
    expect(links("链接：https://example.com/a。 下一句")).toEqual(["https://example.com/a"]);
    expect(links("链接：https://example.com/a。")).toEqual(["https://example.com/a"]);
    expect(links("（https://example.com/a）")).toEqual(["https://example.com/a"]);
    expect(links("「www.example.jp」")).toEqual(["www.example.jp"]);
    expect(links("https://example.com/👍 ok")).toEqual(["https://example.com/"]);
    const text = "👋🏽 hi https://example.com/x 你好 www.example.org 😀";
    expect(joined(tokenizeLinks(text))).toBe(text);
    expect(links(text)).toEqual(["https://example.com/x", "www.example.org"]);
  });

  it.each([
    "https://docs.example。会社。jp/guide",
    "https://docs.example。会社。jp",
    "https://docs.example。会社。中国。jp",
    "https://docs.example。公司.中国",
    "https://example.com/a。下一句。jp/x",
    "https://docs.example\uFEFF.org/guide",
    "https://docs.example\uFEFF",
    "https://example.com/a\uFEFFb",
    "https://example.com/files/📁/guide",
    "https://example.com/a🎉?x=1",
    "https://example.com/a👍🏽#top",
    "https://example.com/a👨‍👩‍👧/b",
    "https://docs.example🎉.org/guide",
    "https://example.com。🎉/guide",
  ])("leaves ideographic-dot hosts, U+FEFF and emoji followed by URL syntax plain: %s", (text) => {
    expect(links(text)).toEqual([]);
    expect(joined(tokenizeLinks(text))).toBe(text);
  });

  it.each([
    ["访问https://example.com。谢谢。再见", "https://example.com"],
    ["https://example.com/a。下一句。再见", "https://example.com/a"],
    ["https://example.com/a🎉 /guide", "https://example.com/a"],
    ["https://example.com/a🎉谢谢", "https://example.com/a"],
    ["https://example.com/a🎉", "https://example.com/a"],
    ["https://example.com/a👨‍👩‍👧 ok", "https://example.com/a"],
    ["https://example.com 🎉/guide", "https://example.com"],
    ["https://example.com\uFEFF https://b.example", "https://b.example"],
    // A keycap is a digit plus combining marks, so it stays inside the path: the full URL.
    ["https://example.com/a1️⃣/b", "https://example.com/a1️⃣/b"],
  ])("keeps prose and standalone emoji as boundaries: %s", (text, link) => {
    expect(links(text).at(0)).toBe(link);
  });

  it("links each URL when a later one follows CJK prose after a break", () => {
    expect(links("访问https://a.example/x。谢谢https://b.example/y。")).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(links("见https://a.example，再见www.b.example/z")).toEqual(["https://a.example", "www.b.example/z"]);
  });

  it("lists message links without spanning custom emoji tokens", () => {
    expect(messageLinks("a https://example.com/x[[emoji:abc123:smile]]y www.example.org")).toEqual([
      { value: "https://example.com/x", href: "https://example.com/x" },
      { value: "www.example.org", href: "https://www.example.org/" },
    ]);
  });

  it("finds several links across lines", () => {
    expect(links("one https://a.example\ntwo www.b.example\tthree http://c.example/x")).toEqual(["https://a.example", "www.b.example", "http://c.example/x"]);
  });

  describe("invariant: a link never points somewhere other than its text", () => {
    // Deterministic generator over host prefix/suffix variants, separators, ports and brackets.
    let seed = 0x5eed;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
    const schemes = ["https://", "http://", "HTTPS://", "www.", "https://www."];
    const hosts = ["example.c1", "ex.co1m", "example.c", "docs.example", "sub.cafe東京.jp", "bücher.de", "localhost", "192.168.0.1", "192.168.001.1", "0x7f.0.0.1", "1.2.3.0x4", "xn--bcher-kva.de", "a-b.example", "x_y.example"];
    const hostSuffixes = ["", "", "。test", "．test", "｡test", "%2Etest", "%2etest", ".test", "很好", "。", "．", ".", ")", "),", "」", "_", "@evil.example", "\u200Bevil", ":", ",x", "!", "-x", "\\x", "🇯🇵", "🇯🇵evil", "\uFEFF.org", "\uFEFF", "。会社。jp", "。会社。jp/guide", "🎉.org", "。公司.中国"];
    const ports = ["", "", ":8080", ":", ":/", ":000443", ":99999", ":80abc", ":0443", "::1"];
    const paths = ["", "", "/guide", "/a_(b)", "?q=1", "#x", "/佐々木", "/foo)(bar)", "/a)", "/[x](y", "/%2E", "/a。b", "/archive（draft）/index.html", "/a（b", "/a）", "/x🇯🇵y", "/a、b", "/files/📁/guide", "/a🎉?x=1", "/a👍🏽#x", "/a👨‍👩‍👧/b", "/a\uFEFF/b"];
    const tails = ["", ".", ")", "。", "!", " next", "」很好", "_", "\u202Eevil", "🎉", ",", "?", "🇯🇵", "🇯🇵x", "。下一句", "、", "）", "\u200B", "👍🏽", "谢谢", "。谢谢", "、b", "，evil.example", "。test", "）谢谢", "很好", "很好/path", "。\u200B谢", "です", "한국", "。公司.cn/guide", "，世界/index.html", "、a=b", "中文@example.org", "中文%2Ecn", "中文。谢谢", "，https://b.example", "」www.b.example", "。谢谢https://b.example/x", "，见www.b.example/y", "。下一句?x", "）x&y", "\uFEFF", "\uFEFFx", "🎉/x", "🎉 /x", "。谢谢。再见", "。会社。jp/guide", "。谢谢。再见/x", "1️⃣/x"];
    const prefixes = ["", "(", "「", "see ", "_", "**", "看", "（"];
    // Independent oracle: what may follow a link before the next visible boundary.
    // Not \s: U+FEFF is invisible and never a boundary.
    const whitespace = /[\p{Cc}\p{Z}]/u;
    const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0F\u20E3]/u;
    const boundary = /[\p{Cc}\p{Z}\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]/u;
    // Independent oracle for the character(s) after a link. Trailing punctuation
    // (a trailing "?" is an empty query: the same page) may be followed by a
    // boundary; CJK breaks end a link before CJK prose; CJK text after an
    // ASCII-letter TLD is a script-change boundary.
    const trailing = /[^\p{L}\p{N}\p{M}\p{Cf}/#\\@%=&+$\-([{（［｛<]/u;
    const cjkBreak = /[。、，！？；：」』】〉》）］｝]/u;
    const cjkText = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
    const cjkPunctuation = /[\u2018-\u201F\u2026\u3001-\u3003\u3008-\u3011\u3014-\u301F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/u;
    // Text after a CJK break that would continue the URL rather than the prose.
    function continuesUrl(rest: string[]): boolean {
      const segment: string[] = [];
      for (let index = 0; index < Math.min(rest.length, 256); index += 1) {
        const char = rest[index];
        if (emoji.test(char)) { segment.push(" "); continue; } // Transparent, but not a label character.
        if (whitespace.test(char)) break;
        // A later link starting after CJK text owns its own URL syntax.
        if (/^(https?:\/\/|www\.)/i.test(rest.slice(index).join("")) && (!segment.length || cjkText.test(segment.at(-1)!))) break;
        if (cjkBreak.test(char)) {
          // 。 between hostname-like labels reads as a dot; otherwise it ends the sentence.
          const label = segment.join("").split(/[.．｡。]/u).at(-1)!;
          if (char !== "。" || !/^[\p{L}\p{M}\p{N}-]+$/u.test(label) || !/[\p{L}\p{N}]/u.test(rest[index + 1] ?? "")) break;
        }
        segment.push(char);
      }
      return /[/?#=&]|\.[\p{L}\p{N}]|[．｡。][A-Za-z0-9]/u.test(segment.join(""));
    }
    function allowedBoundary(after: string[], hasPath: boolean, letterTld: boolean): boolean {
      if (!after.length || whitespace.test(after[0])) return true;
      // An emoji separates unless URL syntax follows it in the same run.
      if (boundary.test(after[0])) return !continuesUrl(after);
      if (!hasPath && letterTld && cjkText.test(after[0])) {
        // Script change: what follows the CJK run must itself be a clean boundary.
        let index = 0;
        while (index < after.length && cjkText.test(after[index])) index += 1;
        if (/[:/?#\\]/.test(after[index] ?? "")) return false;
        return allowedBoundary(after.slice(index), false, false);
      }
      for (let index = 0; index < after.length; index += 1) {
        const char = after[index], next = after[index + 1];
        if (whitespace.test(char)) return true;
        if (boundary.test(char)) return !continuesUrl(after.slice(index));
        if (cjkBreak.test(char)) {
          if (char === "。" && next !== undefined && /[A-Za-z0-9]/.test(next)) return false;
          const rest = after.slice(index + 1);
          if (/^(https?:\/\/|www\.)/i.test(rest.join(""))) return true;
          if (hasPath || next === undefined || boundary.test(next) || cjkText.test(next) || cjkPunctuation.test(next)) return !continuesUrl(rest);
        }
        if (!trailing.test(char)) return false;
      }
      return true;
    }
    const samples = Array.from({ length: 8000 }, () => pick(prefixes) + pick(schemes) + pick(hosts) + pick(hostSuffixes) + pick(ports) + pick(paths) + pick(tails));

    it("holds for generated strings", () => {
      let linked = 0;
      for (const text of samples) {
        const tokens = tokenizeLinks(text);
        expect(joined(tokens)).toBe(text);
        let offset = 0;
        for (const token of tokens) {
          if (token.type === "link") {
            linked += 1;
            const www = /^www\./i.test(token.value);
            const url = new URL(www ? `https://${token.value}` : token.value);
            // The href is exactly the parse of the visible text, over http(s) only.
            expect(["http:", "https:"]).toContain(url.protocol);
            expect(token.href).toBe(url.href);
            // The link must end at an allowed boundary.
            const after = Array.from(text.slice(offset + token.value.length));
            const hasPath = /[/?#]/.test(token.value.replace(/^(https?:\/\/)?[^/?#]*/i, ""));
            expect(allowedBoundary(after, hasPath, /[A-Za-z]$/.test(token.value)), `${text}: ${JSON.stringify(token.value)} is followed by ${JSON.stringify(after.join(""))}`).toBe(true);
            // An IPv4 host is shown in its canonical form.
            const visibleHost = token.value.replace(/^https?:\/\//i, "").split(/[:/?#]/)[0].toLowerCase().replace(/\.$/, "");
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) expect(visibleHost, text).toBe(url.hostname);
          }
          offset += token.value.length;
        }
      }
      expect(linked).toBeGreaterThan(500);
    });

    it("never links a strict prefix of a longer valid host or port", () => {
      for (const text of samples) {
        for (const token of tokenizeLinks(text)) {
          if (token.type !== "link") continue;
          const index = text.indexOf(token.value);
          const after = text.slice(index + token.value.length);
          if (/^[/?#]/.test(token.value.replace(/^(https?:\/\/)?[^/?#]*/i, ""))) continue;
          // CJK text after an ASCII-letter TLD is the script-change boundary, not more host.
          const cjkRun = after.match(/^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]+(.?)/u);
          const scriptBoundary = !!cjkRun && /[A-Za-z]$/.test(token.value) && !/[:/?#\\]/.test(cjkRun[1]);
          // 。．｡ only continue a host before ASCII; before CJK they end the sentence.
          expect(!scriptBoundary && /^(?:[\p{L}\p{N}%@-]|[.:\\][\p{L}\p{N}]|[。．｡][A-Za-z0-9])/u.test(after), `${text} -> ${token.value}`).toBe(false);
        }
      }
    });
  });

  describe("adversarial input stays linear", () => {
    const cases: Array<[string, string]> = [
      ["repeated schemes", "http://".repeat(40_000)],
      ["repeated www", "www.".repeat(60_000)],
      ["nested schemes after brackets", "(https://".repeat(30_000)],
      ["one long host", `https://${"a.".repeat(100_000)}com`],
      ["long invalid host", `https://${"a-.".repeat(80_000)}`],
      ["closing parens", `https://example.com/${")".repeat(200_000)}`],
      ["opening parens", `https://example.com/${"(".repeat(200_000)}`],
      ["trailing dots", `https://example.com/a${".".repeat(200_000)}`],
      ["invalid punycode with nested links", "(https://xn--a.example/".repeat(20_000)],
      ["many valid links", "https://a.example ".repeat(20_000)],
      ["dotless hosts after long text", `${"x".repeat(100_000)} ${"https://localhostx ".repeat(20_000)}`],
      ["CJK prose suffixes", "https://a.com很/".repeat(20_000)],
      ["delimiters", "_https://a.example/_".repeat(20_000)],
      ["delimiter runs", `${"*".repeat(200_000)}https://a.example`],
      ["ambiguous www continuations", "www.a.example:x)".repeat(30_000)],
      ["IDNA dot continuations", "https://a.example。b".repeat(30_000)],
      ["unmatched closers", `https://example.com/${")(".repeat(100_000)}`],
      ["full-width brackets", `https://example.com/${"（）".repeat(100_000)}`],
      ["long plain text", "hello world ".repeat(50_000)],
      ["long CJK and emoji", "你好🎉".repeat(80_000)],
    ];
    it.each(cases)("%s", (_name, text) => {
      const started = performance.now();
      const tokens = tokenizeLinks(text);
      const elapsed = performance.now() - started;
      expect(joined(tokens)).toBe(text);
      expect(elapsed).toBeLessThan(1500);
    });

    it.each(["https://a.example/x）", "https://a.example/x)", "https://a.example/x」", "https://a.example/x。谢谢", "https://a.example/x，"])("tokenizes 10k repetitions of %s in a few milliseconds, linearly", (unit) => {
      const run = (count: number) => {
        const text = unit.repeat(count);
        tokenizeLinks(text);
        const started = performance.now();
        const tokens = tokenizeLinks(text);
        return { elapsed: performance.now() - started, tokens, text };
      };
      const { elapsed, tokens, text } = run(10_000);
      expect(joined(tokens)).toBe(text);
      expect(elapsed).toBeLessThan(25);
      const linksFound = tokens.filter((token) => token.type === "link");
      // ASCII ")" is a URL character, so the run is one long link; the others end each link.
      expect(linksFound).toHaveLength(unit.endsWith(")") ? 1 : 10_000);
      const small = Math.max(run(5_000).elapsed, 0.5);
      expect(run(40_000).elapsed / small).toBeLessThan(30);
    });

    it.each([
      ["one long Unicode label", `https://${"例".repeat(16_000)}.中国`],
      ["many Unicode labels", `https://${"例子.".repeat(5_400)}中国`],
      ["long Unicode www host", `www.${"bücher".repeat(2_700)}.de`],
      ["many long Unicode hosts", `https://${"ü".repeat(300)}.de `.repeat(50)],
    ])("tokenizes a 16 KB %s in a few milliseconds", (_name, text) => {
      expect(text.length).toBeGreaterThanOrEqual(15_000);
      tokenizeLinks(text);
      const started = performance.now();
      const tokens = tokenizeLinks(text);
      expect(performance.now() - started).toBeLessThan(25);
      expect(joined(tokens)).toBe(text);
      expect(tokens.some((token) => token.type === "link")).toBe(false);
    });

    it("scales linearly", () => {
      const run = (size: number) => {
        const text = "(https://".repeat(size) + "x " + "www.".repeat(size);
        const started = performance.now();
        tokenizeLinks(text);
        return performance.now() - started;
      };
      run(5_000);
      const small = Math.max(run(20_000), 1);
      const large = run(160_000);
      // 8x the input; quadratic work would be ~64x slower.
      expect(large / small).toBeLessThan(30);
    });
  });
});
