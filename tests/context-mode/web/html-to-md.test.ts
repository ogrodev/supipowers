import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "../../../src/context-mode/web/html-to-md.js";

describe("htmlToMarkdown", () => {
  // 1. Headings
  test("converts h1–h6 to markdown headings", () => {
    expect(htmlToMarkdown("<h1>Title</h1>")).toBe("# Title");
    expect(htmlToMarkdown("<h2>Sub</h2>")).toBe("## Sub");
    expect(htmlToMarkdown("<h3>Three</h3>")).toBe("### Three");
    expect(htmlToMarkdown("<h6>Six</h6>")).toBe("###### Six");
  });

  // 2. Paragraphs
  test("converts paragraphs", () => {
    expect(htmlToMarkdown("<p>Hello world</p>")).toBe("Hello world");
  });

  // 3. Links
  test("converts links", () => {
    expect(htmlToMarkdown('<a href="https://example.com">Click</a>')).toBe(
      "[Click](https://example.com)",
    );
  });

  // 4. Images
  test("converts images", () => {
    expect(htmlToMarkdown('<img src="pic.jpg" alt="Photo">')).toBe(
      "![Photo](pic.jpg)",
    );
    expect(htmlToMarkdown('<img src="pic.jpg" alt="Photo" />')).toBe(
      "![Photo](pic.jpg)",
    );
    // alt before src
    expect(htmlToMarkdown('<img alt="Photo" src="pic.jpg">')).toBe(
      "![Photo](pic.jpg)",
    );
  });

  // 5. Bold + italic
  test("converts bold and italic", () => {
    expect(htmlToMarkdown("<strong>bold</strong>")).toBe("**bold**");
    expect(htmlToMarkdown("<b>bold</b>")).toBe("**bold**");
    expect(htmlToMarkdown("<em>italic</em>")).toBe("*italic*");
    expect(htmlToMarkdown("<i>italic</i>")).toBe("*italic*");
  });

  // 6. Inline code
  test("converts inline code", () => {
    expect(htmlToMarkdown("<code>const x = 1</code>")).toBe("`const x = 1`");
  });

  // 7. Code blocks
  test("converts code blocks with language", () => {
    const html = '<pre><code class="language-js">let x = 1;</code></pre>';
    expect(htmlToMarkdown(html)).toBe("```js\nlet x = 1;\n```");
  });

  test("converts code blocks without language", () => {
    const html = "<pre><code>let x = 1;</code></pre>";
    expect(htmlToMarkdown(html)).toBe("```\nlet x = 1;\n```");
  });

  // 8. Unordered lists
  test("converts unordered lists", () => {
    const html = "<ul><li>A</li><li>B</li></ul>";
    expect(htmlToMarkdown(html)).toBe("- A\n- B");
  });

  // 9. Ordered lists
  test("converts ordered lists", () => {
    const html = "<ol><li>First</li><li>Second</li></ol>";
    expect(htmlToMarkdown(html)).toBe("1. First\n2. Second");
  });

  // 10. Tables
  test("converts tables", () => {
    const html = `
      <table>
        <thead><tr><th>Name</th><th>Age</th></tr></thead>
        <tbody><tr><td>Alice</td><td>30</td></tr></tbody>
      </table>`;
    const result = htmlToMarkdown(html);
    expect(result).toContain("| Name | Age |");
    expect(result).toContain("| --- | --- |");
    expect(result).toContain("| Alice | 30 |");
  });

  // 11. Strips unwanted elements
  test("strips script tags", () => {
    expect(htmlToMarkdown("<script>alert(1)</script>")).toBe("");
  });

  test("strips style tags", () => {
    expect(htmlToMarkdown("<style>.x{}</style>")).toBe("");
  });

  test("strips nav tags", () => {
    expect(htmlToMarkdown("<nav>menu</nav>")).toBe("");
  });

  test("strips footer, header, aside", () => {
    expect(htmlToMarkdown("<footer>foot</footer>")).toBe("");
    expect(htmlToMarkdown("<header>head</header>")).toBe("");
    expect(htmlToMarkdown("<aside>side</aside>")).toBe("");
  });

  test("strips elements with display:none", () => {
    expect(
      htmlToMarkdown('<div style="display:none">hidden</div>'),
    ).toBe("");
  });

  test("strips elements with aria-hidden=true", () => {
    expect(
      htmlToMarkdown('<span aria-hidden="true">hidden</span>'),
    ).toBe("");
  });

  test("strips HTML comments", () => {
    expect(htmlToMarkdown("<!-- comment -->visible")).toBe("visible");
  });

  // 12. BR
  test("converts br tags", () => {
    expect(htmlToMarkdown("line1<br>line2")).toBe("line1\nline2");
    expect(htmlToMarkdown("line1<br/>line2")).toBe("line1\nline2");
    expect(htmlToMarkdown("line1<br />line2")).toBe("line1\nline2");
  });

  // 13. HTML entities
  test("decodes HTML entities", () => {
    expect(htmlToMarkdown("&amp; &lt; &gt; &quot;")).toBe('& < > "');
    expect(htmlToMarkdown("&#39; &apos;")).toBe("' '");
    expect(htmlToMarkdown("a&nbsp;b")).toBe("a b");
    expect(htmlToMarkdown("&#169;")).toBe("©");
  });

  // 14. Nested structures
  test("handles nested structures", () => {
    const html = "<div><p><strong>Bold</strong> text</p></div>";
    expect(htmlToMarkdown(html)).toBe("**Bold** text");
  });

  // 15. Empty / malformed HTML
  test("handles empty string", () => {
    expect(htmlToMarkdown("")).toBe("");
  });

  test("handles whitespace-only", () => {
    expect(htmlToMarkdown("   ")).toBe("");
  });

  test("handles plain text (no HTML)", () => {
    expect(htmlToMarkdown("just text")).toBe("just text");
  });

  // 16. Pre without code
  test("converts pre without code tag", () => {
    const html = "<pre>raw text</pre>";
    expect(htmlToMarkdown(html)).toBe("```\nraw text\n```");
  });

  // 17. Blockquote
  test("converts blockquotes", () => {
    expect(htmlToMarkdown("<blockquote>quote</blockquote>")).toBe("> quote");
  });

  // Additional: HR
  test("converts hr", () => {
    expect(htmlToMarkdown("above<hr>below")).toBe("above\n---\nbelow");
    expect(htmlToMarkdown("above<hr/>below")).toBe("above\n---\nbelow");
  });

  // Additional: pre/code content not double-converted
  test("preserves pre/code content verbatim — no markdown conversion inside", () => {
    const html =
      '<pre><code class="language-html">&lt;div&gt;&lt;strong&gt;bold&lt;/strong&gt;&lt;/div&gt;</code></pre>';
    const result = htmlToMarkdown(html);
    expect(result).toBe(
      "```html\n<div><strong>bold</strong></div>\n```",
    );
  });

  // Additional: empty anchor
  test("handles empty anchor gracefully", () => {
    const html = '<a href="https://example.com"></a>';
    const result = htmlToMarkdown(html);
    expect(result).toBe("[](https://example.com)");
  });

  // Additional: strip then convert
  test("strips unwanted and converts rest", () => {
    const html =
      "<div><script>bad()</script><p>Good content</p><nav>skip</nav></div>";
    expect(htmlToMarkdown(html)).toBe("Good content");
  });

  // Additional: multiple newline collapsing
  test("collapses excessive newlines", () => {
    const html = "<p>A</p><p>B</p><p>C</p>";
    const result = htmlToMarkdown(html);
    expect(result).toBe("A\n\nB\n\nC");
  });
});
