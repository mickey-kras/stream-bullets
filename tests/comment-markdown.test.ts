import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommentMarkdown, USER_LINK_REL } from "../app/components/comment-markdown";
import { MAX_NESTING, parseCommentMarkdown } from "../app/lib/comment-markdown";
import type { CommentMention } from "../app/types";

function html(text: string, mentions?: readonly CommentMention[]): string {
  return renderToStaticMarkup(createElement(CommentMarkdown, { text, mentions }));
}

function mentionAt(text: string, label: string, userId: string): CommentMention {
  const start: number = text.indexOf(label);
  return { userId, start, end: start + label.length };
}

const LINK = `target="_blank" rel="${USER_LINK_REL}"`;

describe("supported Markdown", () => {
  it.each<[string, string, string]>([
    ["bold", "**bold** and __bold__", "<p><strong>bold</strong> and <strong>bold</strong></p>"],
    ["italic", "*it* and _it_", "<p><em>it</em> and <em>it</em></p>"],
    ["strikethrough", "~~gone~~", "<p><del>gone</del></p>"],
    ["nested emphasis", "**bold *both* ~~cut~~**", "<p><strong>bold <em>both</em> <del>cut</del></strong></p>"],
    ["inline code", "use `a < b && c`", "<p>use <code>a &lt; b &amp;&amp; c</code></p>"],
    ["unordered list", "- one\n- two", "<ul><li>one</li><li>two</li></ul>"],
    ["ordered list", "3. one\n4. two", '<ol start="3"><li>one</li><li>two</li></ol>'],
    ["nested list", "- one\n  - two", "<ul><li>one<ul><li>two</li></ul></li></ul>"],
    ["loose list", "- one\n\n- two", "<ul><li><p>one</p></li><li><p>two</p></li></ul>"],
    ["block quote", "> quoted\n> text", "<blockquote><p>quoted<br/>text</p></blockquote>"],
    ["fenced code", "```js\nlet a = 1 < 2;\n  **x**\n```", "<pre><code>let a = 1 &lt; 2;\n  **x**</code></pre>"],
    ["escaped syntax", String.raw`\*not italic\*`, "<p>*not italic*</p>"],
  ])("renders %s", (_name: string, text: string, expected: string) => {
    expect(html(text)).toBe(expected);
  });

  it.each<[string, string, string]>([
    ["inline link", "[site](https://example.com/a?b=1&c=2)", "https://example.com/a?b=1&amp;c=2"],
    ["angle autolink", "<https://example.com/>", "https://example.com/"],
    ["bare address", "see https://example.com/x now", "https://example.com/x"],
    ["bare www address", "www.example.com", "http://www.example.com/"],
    ["mail link", "[mail](mailto:a@example.com)", "mailto:a@example.com"],
    ["bare mail address", "a@example.com", "mailto:a@example.com"],
  ])("links a %s with the user-content attributes", (_name: string, text: string, href: string) => {
    expect(html(text)).toContain(`<a href="${href}" ${LINK}>`);
  });

  it("keeps formatting inside link text", () => {
    expect(html("[**bold** link](https://example.com)")).toBe(
      `<p><a href="https://example.com/" ${LINK}><strong>bold</strong> link</a></p>`,
    );
  });
});

describe("unsupported Markdown stays literal", () => {
  it.each<[string, string, string]>([
    ["heading", "# Title", "<p># Title</p>"],
    ["underlined heading", "Title\n===", "<p>Title<br/>===</p>"],
    ["rule", "above\n\n---\n\nbelow", "<p>above</p><p>---</p><p>below</p>"],
    ["image", "![alt](https://example.com/a.png)", "<p>![alt](https://example.com/a.png)</p>"],
    ["table", "| a | b |\n|---|---|\n| 1 | 2 |", "<p>| a | b |<br/>|---|---|<br/>| 1 | 2 |</p>"],
    ["footnote", "text[^1]\n\n[^1]: note", "<p>text[^1]</p><p>[^1]: note</p>"],
    ["task list", "- [ ] todo\n- [x] done", "<ul><li>[ ] todo</li><li>[x] done</li></ul>"],
    ["reference link", "[ref]: /local\n[ref]", "<p>[ref]: /local<br/>[ref]</p>"],
    ["indented code", "    four spaces", "<p>    four spaces</p>"],
    ["relative link", "[x](/admin)", "<p>[x](/admin)</p>"],
  ])("keeps a %s as text", (_name: string, text: string, expected: string) => {
    expect(html(text)).toBe(expected);
  });
});

describe("unsafe input", () => {
  it.each<[string, string]>([
    ["script element", "<script>alert(1)</script>"],
    ["image handler", '<img src=x onerror="alert(1)">'],
    ["block element", '<div onclick="alert(1)">\nhi\n</div>'],
    ["frame", '<iframe src="javascript:alert(1)"></iframe>'],
    ["comment", "<!-- x --><svg/onload=alert(1)>"],
    ["script link", "[x](javascript:alert(1))"],
    ["mixed-case script link", "[x](JaVaScRiPt:alert(1))"],
    ["entity script link", "[x](javascript&colon;alert(1))"],
    ["numeric entity script link", "[x](&#106;avascript:alert(1))"],
    ["spaced script link", "[x](<java\tscript:alert(1)>)"],
    ["data link", "[x](data:text/html,<script>alert(1)</script>)"],
    ["script autolink", "<javascript:alert(1)>"],
    ["data autolink", "<data:text/html;base64,PHNjcmlwdD4=>"],
    ["script image", "![x](javascript:alert(1))"],
    ["titled link", '[x](https://example.com "onmouseover=alert(1)")'],
    ["broken nesting", "**[*x](javascript:alert(1))** <b **> `<script>"],
    ["html in code", "`<script>alert(1)</script>`\n```\n<img onerror=alert(1)>\n```"],
  ])("renders a %s inertly", (_name: string, text: string) => {
    const markup: string = html(text);
    expect(markup).not.toMatch(/<(?:script|img|iframe|svg|div|b)\b/iu);
    expect(markup).not.toMatch(/<[a-z][^>]*\son\w+=/iu);
    expect(markup).not.toMatch(/href="(?!https:\/\/example\.com\/")/iu);
  });

  it("shows markup as the text the author typed", () => {
    expect(html("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(html("[x](javascript:alert(1))")).toBe("<p>[x](javascript:alert(1))</p>");
  });

  it("shows character references as text, never as markup", () => {
    expect(html("&lt;b&gt; &amp; &#60;script&#62; &copy;")).toBe(
      "<p>&amp;lt;b&amp;gt; &amp;amp; &lt;script&gt; &amp;copy;</p>",
    );
  });

  it("drops the link title", () => {
    expect(html('[x](https://example.com "title")')).toBe(`<p><a href="https://example.com/" ${LINK}>x</a></p>`);
  });
});

describe("plain text", () => {
  it("keeps every single line break", () => {
    expect(html("one\ntwo\nthree")).toBe("<p>one<br/>two<br/>three</p>");
  });

  it("separates paragraphs at blank lines", () => {
    expect(html("one\n\n\ntwo")).toBe("<p>one</p><p>two</p>");
  });

  it("keeps repeated spaces for the pre-wrap style", () => {
    expect(html("a   b")).toBe("<p>a   b</p>");
  });

  it("renders nothing for blank text", () => {
    expect(parseCommentMarkdown("  \n ")).toEqual([]);
  });
});

describe("mentions", () => {
  it("renders a mention as before", () => {
    const text = "Hello @owner, see **this**";
    expect(html(text, [mentionAt(text, "@owner", "user-1")])).toBe(
      '<p>Hello <strong class="comment-mention" title="user-1">@owner</strong>, see <strong>this</strong></p>',
    );
  });

  it("keeps Markdown characters in a mention label", () => {
    const text = "@_snake_name_ and @*star*";
    const mentions: CommentMention[] = [mentionAt(text, "@*star*", "b"), mentionAt(text, "@_snake_name_", "a")];
    expect(html(text, mentions)).toBe(
      '<p><strong class="comment-mention" title="a">@_snake_name_</strong> and <strong class="comment-mention" title="b">@*star*</strong></p>',
    );
  });

  it("renders a mention inside formatting, a list and a quote", () => {
    const text = "> - *hi @owner*";
    expect(html(text, [mentionAt(text, "@owner", "u")])).toBe(
      '<blockquote><ul><li><em>hi <strong class="comment-mention" title="u">@owner</strong></em></li></ul></blockquote>',
    );
  });

  it("leaves a mention inside code as code text", () => {
    const text = "`@owner` and\n```\nping @owner\n```";
    const first: CommentMention = mentionAt(text, "@owner", "u");
    const second: CommentMention = {
      userId: "u",
      start: text.lastIndexOf("@owner"),
      end: text.lastIndexOf("@owner") + 6,
    };
    const markup: string = html(text, [first, second]);
    expect(markup).toBe("<p><code>@owner</code> and</p><pre><code>ping @owner</code></pre>");
    expect(markup).not.toContain("comment-mention");
  });

  it("restores a mention inside a link target and inside literal text", () => {
    const text = "https://example.com/@owner ![@owner](x)";
    const second: number = text.lastIndexOf("@owner");
    const markup: string = html(text, [
      mentionAt(text, "@owner", "u"),
      { userId: "u", start: second, end: second + 6 },
    ]);
    expect(markup).toContain(`<a href="https://example.com/@owner" ${LINK}>`);
    expect(markup).toContain('![<strong class="comment-mention" title="u">@owner</strong>](x)');
  });

  it("ignores mention ranges that overlap or leave the text", () => {
    const text = "@one two";
    const mentions: CommentMention[] = [
      { userId: "a", start: 0, end: 4 },
      { userId: "b", start: 2, end: 6 },
      { userId: "c", start: 5, end: 5 },
      { userId: "d", start: 5, end: 99 },
    ];
    expect(html(text, mentions)).toBe('<p><strong class="comment-mention" title="a">@one</strong> two</p>');
  });

  it("does not let typed marker characters forge a mention", () => {
    const text = "0 5 @owner";
    const markup: string = html(text, [mentionAt(text, "@owner", "u")]);
    expect(markup).toBe('<p>0 5 <strong class="comment-mention" title="u">@owner</strong></p>');
  });
});

describe("limits", () => {
  it.each<[string, string]>([
    ["quotes", ">".repeat(2000)],
    ["spaced quotes", "> ".repeat(1000)],
    ["list markers", "- ".repeat(1000)],
    ["mixed containers", "> - ".repeat(500)],
    ["link brackets", `${"[".repeat(990)}x${"](https://example.com)".repeat(40)}`],
    ["emphasis runs", "*_".repeat(1000)],
    ["unclosed emphasis", "**a ".repeat(500)],
    ["backticks", "`".repeat(2000)],
  ])("renders 2000 characters of %s", (_name: string, text: string) => {
    const started: number = performance.now();
    const markup: string = html(text);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(markup.length).toBeGreaterThan(0);
    const quotes: number = markup.split("<blockquote>").length - 1;
    const lists: number = markup.split("<ul>").length - 1;
    expect(quotes + lists).toBeLessThanOrEqual(MAX_NESTING);
  });

  it("keeps the text beyond the nesting limit", () => {
    const markup: string = html(`${"> ".repeat(MAX_NESTING + 2)}deep`);
    expect(markup).toContain("&gt; &gt; deep");
  });

  it("renders a very long plain comment unchanged", () => {
    const line = "word ".repeat(399).trim();
    expect(html(`${line}\n${line}`)).toBe(`<p>${line}<br/>${line}</p>`);
  });
});
