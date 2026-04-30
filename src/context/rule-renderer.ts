import type { RuleMode, WriteRuleAction } from "./startup-optimizer.js";

export const MANAGED_RULE_HEADER = "<!-- supipowers:managed-rule";
export const MANAGED_RULE_END = "-->";

export interface ManagedRuleMetadata {
  version: number;
  mode: RuleMode;
  sourceId: string;
  sourceName: string;
  sourceHash: string;
  slug: string;
  sourceBytes: number;
}

export type ParsedManagedRule =
  | { status: "unmanaged"; managed: false }
  | {
      status: "managed";
      managed: true;
      metadata: ManagedRuleMetadata;
      frontmatter: Record<string, string>;
      /**
       * Canonical source body — exactly what the optimizer hashed/sized to produce
       * `metadata.sourceHash` / `metadata.sourceBytes`. Trailing newline added by the
       * renderer (for POSIX-friendly EOF) is stripped during parsing.
       */
      body: string;
    }
  | { status: "malformed"; managed: true; error: string };

/**
 * Render a managed rule file.
 *
 * The body is written exactly as `action.sourceContent`, plus a single trailing newline
 * if missing (POSIX-friendly EOF). The parser strips that trailing newline so
 * `parsed.body` equals the canonical source content used to compute the manifest hash.
 */
export function renderManagedRule(action: WriteRuleAction): string {
  const frontmatter = renderFrontmatter(action);
  const metadata = [
    MANAGED_RULE_HEADER,
    "version: 1",
    `mode: ${action.mode}`,
    `sourceId: ${action.sourceId}`,
    `sourceName: ${action.sourceName}`,
    `sourceHash: ${action.sourceHash}`,
    `slug: ${action.slug}`,
    `sourceBytes: ${action.sourceBytes}`,
    MANAGED_RULE_END,
  ].join("\n");
  const body = action.sourceContent.endsWith("\n")
    ? action.sourceContent
    : `${action.sourceContent}\n`;

  return `${metadata}\n---\n${frontmatter}\n---\n${body}`;
}

export function parseManagedRule(text: string): ParsedManagedRule {
  if (!text.startsWith(MANAGED_RULE_HEADER)) {
    return { status: "unmanaged", managed: false };
  }

  const headerEnd = text.indexOf(MANAGED_RULE_END, MANAGED_RULE_HEADER.length);
  if (headerEnd === -1) {
    return { status: "malformed", managed: true, error: "managed header is not closed" };
  }

  const headerText = text.slice(0, headerEnd).trimEnd();
  const metadataResult = parseMetadata(headerText);
  if (typeof metadataResult === "string") {
    return { status: "malformed", managed: true, error: metadataResult };
  }

  const afterHeader = text.slice(headerEnd + MANAGED_RULE_END.length).replace(/^\r?\n/, "");
  const frontmatterResult = parseFrontmatter(afterHeader);
  if (typeof frontmatterResult === "string") {
    return { status: "malformed", managed: true, error: frontmatterResult };
  }

  return {
    status: "managed",
    managed: true,
    metadata: metadataResult,
    frontmatter: frontmatterResult.frontmatter,
    body: stripTrailingNewline(frontmatterResult.body),
  };
}

function renderFrontmatter(action: WriteRuleAction): string {
  if (action.mode === "ttsr") {
    if (!action.condition) {
      throw new Error(`TTSR rule ${action.slug} is missing a condition`);
    }
    return `condition: ${frontmatterScalarLiteral(action.condition)}`;
  }

  const description = action.description ?? deriveRuleDescription(action.sourceContent) ?? `Use ${action.sourceName} when relevant.`;
  return `description: ${frontmatterScalarLiteral(description)}`;
}

export function deriveRuleDescription(sourceContent: string): string | null {
  for (const rawLine of sourceContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("<!--")) continue;
    return line;
  }
  return null;
}

/**
 * Encode a frontmatter scalar value.
 *
 * The managed rule file uses YAML-shaped frontmatter (`---`-delimited blocks) but the
 * scalar values are intentionally restricted to JSON string literals: `JSON.stringify`
 * produces a deterministic, dependency-free encoding that handles quotes, backslashes,
 * and newlines unambiguously. Parsing uses `JSON.parse` to round-trip the same subset.
 *
 * This is a deliberate, narrow subset of YAML — single-quoted strings, multi-line
 * scalars, anchors, and other YAML constructs are NOT supported. If broader YAML
 * support becomes necessary, replace both this helper and `parseFrontmatterScalar`
 * with a real YAML library and update callers accordingly.
 */
function frontmatterScalarLiteral(value: string): string {
  return JSON.stringify(value);
}

function parseMetadata(headerText: string): ManagedRuleMetadata | string {
  const lines = headerText.split(/\r?\n/);
  if (lines[0] !== MANAGED_RULE_HEADER) {
    return "managed header marker is invalid";
  }

  const raw: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const required = ["version", "mode", "sourceId", "sourceName", "sourceHash", "slug", "sourceBytes"];
  for (const key of required) {
    if (!raw[key]) return `managed metadata missing ${key}`;
  }

  if (raw.mode !== "ttsr" && raw.mode !== "rulebook") {
    return `managed metadata has invalid mode ${raw.mode}`;
  }

  const version = Number(raw.version);
  const sourceBytes = Number(raw.sourceBytes);
  if (!Number.isInteger(version) || version <= 0) return "managed metadata has invalid version";
  if (!Number.isInteger(sourceBytes) || sourceBytes < 0) return "managed metadata has invalid sourceBytes";

  return {
    version,
    mode: raw.mode,
    sourceId: raw.sourceId,
    sourceName: raw.sourceName,
    sourceHash: raw.sourceHash,
    slug: raw.slug,
    sourceBytes,
  };
}

function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } | string {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return "managed frontmatter is missing opening delimiter";
  }

  const normalizedStartLength = text.startsWith("---\r\n") ? 5 : 4;
  const rest = text.slice(normalizedStartLength);
  const closeMatch = rest.match(/\r?\n---\r?\n/);
  if (!closeMatch || closeMatch.index === undefined) {
    return "managed frontmatter is missing closing delimiter";
  }

  const frontmatterText = rest.slice(0, closeMatch.index);
  const body = rest.slice(closeMatch.index + closeMatch[0].length);
  const frontmatter: Record<string, string> = {};

  for (const rawLine of frontmatterText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) return `managed frontmatter has invalid line: ${line}`;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();
    const parsedValue = parseFrontmatterScalar(rawValue);
    if (typeof parsedValue !== "string") {
      return `managed frontmatter has invalid ${key}`;
    }
    frontmatter[key] = parsedValue;
  }

  return { frontmatter, body };
}

/**
 * Decode a frontmatter scalar value.
 *
 * See `frontmatterScalarLiteral`: managed rule frontmatter encodes scalars as JSON
 * string literals. Double-quoted values must round-trip through `JSON.parse`; bare
 * values (no leading quote) are returned verbatim for forward compatibility with
 * unquoted single-token scalars.
 */
function parseFrontmatterScalar(rawValue: string): string | null {
  if (!rawValue.startsWith('"')) return rawValue;
  try {
    const parsed = JSON.parse(rawValue);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function stripTrailingNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}
