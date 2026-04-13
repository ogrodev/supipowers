/**
 * Regex-based HTML-to-Markdown converter.
 * No external dependencies — operates on raw HTML strings.
 *
 * Three phases:
 *   1. Strip unwanted elements (script, style, nav, footer, header, aside, hidden, comments)
 *   2. Convert remaining HTML to Markdown (pre/code protected via placeholders)
 *   3. Normalize (entities, whitespace, trim)
 */

// ── Phase 1: Stripping ──────────────────────────────────────────────

const STRIP_TAGS = ["script", "style", "nav", "footer", "header", "aside"];
const STRIP_PATTERNS: RegExp[] = [
  // Unwanted block elements
  ...STRIP_TAGS.map(
    (tag) => new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
  ),
  // Elements with display:none
  /<[^>]+style\s*=\s*"[^"]*display\s*:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi,
  // Elements with aria-hidden="true"
  /<[^>]+aria-hidden\s*=\s*"true"[^>]*>[\s\S]*?<\/[^>]+>/gi,
  // HTML comments
  /<!--[\s\S]*?-->/g,
];

function stripUnwanted(html: string): string {
  let result = html;
  for (const pattern of STRIP_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result;
}

// ── Phase 2: Conversion ─────────────────────────────────────────────

type Placeholder = { key: string; content: string };

let placeholderCounter = 0;

function protectPreBlocks(html: string): { html: string; placeholders: Placeholder[] } {
  const placeholders: Placeholder[] = [];

  // Match <pre><code class="language-X">...</code></pre>
  // and <pre><code>...</code></pre>
  // and <pre>...</pre> (no nested code)
  const result = html.replace(
    /<pre[^>]*>\s*(?:<code(?:\s+class\s*=\s*"([^"]*)")?[^>]*>([\s\S]*?)<\/code>|([\s\S]*?))\s*<\/pre>/gi,
    (_match, codeClass: string | undefined, codeContent: string | undefined, preContent: string | undefined) => {
      const raw = codeContent ?? preContent ?? "";
      // Decode entities inside code blocks so content is verbatim
      const text = decodeEntities(raw).replace(/^\n|\n$/g, "");

      let lang = "";
      if (codeClass) {
        const langMatch = codeClass.match(/language-(\S+)/);
        if (langMatch) lang = langMatch[1];
      }

      const md = lang ? `\`\`\`${lang}\n${text}\n\`\`\`` : `\`\`\`\n${text}\n\`\`\``;
      const key = `__PRE_PLACEHOLDER_${placeholderCounter++}__`;
      placeholders.push({ key, content: md });
      return key;
    },
  );

  return { html: result, placeholders };
}

function restorePlaceholders(md: string, placeholders: Placeholder[]): string {
  let result = md;
  for (const { key, content } of placeholders) {
    result = result.replace(key, content);
  }
  return result;
}

function convertInlineCode(html: string): string {
  return html.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, content: string) => {
    return `\`${content.trim()}\``;
  });
}

function convertHeadings(html: string): string {
  return html.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, level: string, content: string) => {
      const hashes = "#".repeat(Number(level));
      return `\n\n${hashes} ${content.trim()}\n\n`;
    },
  );
}

function convertParagraphs(html: string): string {
  return html.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, content: string) => {
    return `\n\n${content.trim()}\n\n`;
  });
}

function convertLinks(html: string): string {
  return html.replace(
    /<a\s+[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) => `[${text.trim()}](${href})`,
  );
}

function convertImages(html: string): string {
  return html.replace(
    /<img\s+[^>]*src\s*=\s*"([^"]*)"[^>]*alt\s*=\s*"([^"]*)"[^>]*\/?>/gi,
    (_m, src: string, alt: string) => `![${alt}](${src})`,
  );
}

function convertImagesAltFirst(html: string): string {
  // alt before src ordering
  return html.replace(
    /<img\s+[^>]*alt\s*=\s*"([^"]*)"[^>]*src\s*=\s*"([^"]*)"[^>]*\/?>/gi,
    (_m, alt: string, src: string) => `![${alt}](${src})`,
  );
}

function convertBoldItalic(html: string): string {
  let result = html;
  result = result.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");
  result = result.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");
  return result;
}

function convertLists(html: string): string {
  let result = html;

  // Unordered lists
  result = result.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, inner: string) => {
    const items: string[] = [];
    inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m2: string, content: string) => {
      items.push(`- ${content.trim()}`);
      return "";
    });
    return `\n${items.join("\n")}\n`;
  });

  // Ordered lists
  result = result.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner: string) => {
    const items: string[] = [];
    let idx = 1;
    inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m2: string, content: string) => {
      items.push(`${idx++}. ${content.trim()}`);
      return "";
    });
    return `\n${items.join("\n")}\n`;
  });

  return result;
}

function convertTables(html: string): string {
  return html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, tableInner: string) => {
    const rows: string[][] = [];

    // Extract rows from thead and tbody, or directly
    const allRows = tableInner.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
    for (const row of allRows) {
      const cells: string[] = [];
      const cellPattern = /<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellPattern.exec(row)) !== null) {
        cells.push(cellMatch[1].trim());
      }
      if (cells.length > 0) rows.push(cells);
    }

    if (rows.length === 0) return "";

    const colCount = Math.max(...rows.map((r) => r.length));
    const lines: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i];
      // Pad to colCount
      while (cells.length < colCount) cells.push("");
      lines.push(`| ${cells.join(" | ")} |`);

      // After the first row (header), insert separator
      if (i === 0) {
        lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
      }
    }

    return `\n${lines.join("\n")}\n`;
  });
}

function convertBlockquotes(html: string): string {
  return html.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, content: string) => {
    const lines = content.trim().split("\n");
    return `\n${lines.map((l) => `> ${l.trim()}`).join("\n")}\n`;
  });
}

function convertBrHr(html: string): string {
  let result = html;
  result = result.replace(/<br\s*\/?>/gi, "\n");
  result = result.replace(/<hr\s*\/?>/gi, "\n---\n");
  return result;
}

function unwrapTags(html: string): string {
  // Remove wrapper-only tags, keeping inner content
  return html.replace(
    /<\/?(div|section|article|main|span)[^>]*>/gi,
    "",
  );
}

function stripRemainingTags(html: string): string {
  return html.replace(/<\/?[^>]+(>|$)/g, "");
}

// ── Phase 3: Normalize ──────────────────────────────────────────────

function decodeEntities(html: string): string {
  let result = html;
  result = result.replace(/&amp;/g, "&");
  result = result.replace(/&lt;/g, "<");
  result = result.replace(/&gt;/g, ">");
  result = result.replace(/&quot;/g, '"');
  result = result.replace(/&#39;|&apos;/g, "'");
  result = result.replace(/&nbsp;/g, " ");
  // Numeric entities &#NNN;
  result = result.replace(/&#(\d+);/g, (_m, code: string) =>
    String.fromCharCode(Number(code)),
  );
  // Hex entities &#xHHH;
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return result;
}

function normalizeWhitespace(md: string): string {
  // Collapse 3+ consecutive newlines to 2
  return md.replace(/\n{3,}/g, "\n\n");
}

// ── Main ─────────────────────────────────────────────────────────────

export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return "";

  // Phase 1: Strip unwanted elements
  let result = stripUnwanted(html);

  // Phase 2: Convert

  // Protect <pre>/<code> blocks first
  const { html: withPlaceholders, placeholders } = protectPreBlocks(result);
  result = withPlaceholders;

  // Inline code (not inside pre — those are already placeholders)
  result = convertInlineCode(result);

  // Block-level conversions
  result = convertHeadings(result);
  result = convertBlockquotes(result);
  result = convertTables(result);
  result = convertLists(result);
  result = convertParagraphs(result);

  // Inline conversions
  result = convertLinks(result);
  result = convertImages(result);
  result = convertImagesAltFirst(result);
  result = convertBoldItalic(result);

  // Line breaks and rules
  result = convertBrHr(result);

  // Unwrap structural tags
  result = unwrapTags(result);

  // Strip any remaining HTML tags
  result = stripRemainingTags(result);

  // Restore protected code blocks
  result = restorePlaceholders(result, placeholders);

  // Phase 3: Normalize
  result = decodeEntities(result);
  result = normalizeWhitespace(result);
  result = result.trim();

  return result;
}
