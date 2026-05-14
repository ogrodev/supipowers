import type { RuleMode, WriteCommandAction, WriteExtensionAction, WriteRuleAction } from "./startup-optimizer.js";

export const MANAGED_RULE_HEADER = "<!-- supipowers:managed-rule";
export const MANAGED_RULE_END = "-->";
export const MANAGED_COMMAND_HEADER = "<!-- supipowers:managed-command";
const MANAGED_COMMAND_FRONTMATTER_KEY = "supipowers-managed-command";
const MANAGED_COMMAND_FRONTMATTER_VERSION = "1";
export const MANAGED_EXTENSION_HEADER = "/* supipowers:managed-extension";
export const MANAGED_EXTENSION_END = "*/";

export interface ManagedRuleMetadata {
  version: number;
  mode: RuleMode;
  sourceId: string;
  sourceName: string;
  sourceHash: string;
  slug: string;
  sourceBytes: number;
}

export interface ManagedCommandMetadata {
  version: number;
  sourceId: string;
  sourceName: string;
  sourceHash: string;
  slug: string;
  commandName: string;
  sourceBytes: number;
}

export interface ManagedExtensionMetadata {
  version: number;
  sourceId: string;
  sourceName: string;
  sourceHash: string;
  slug: string;
  extensionName: string;
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

export type ParsedManagedCommand =
  | { status: "unmanaged"; managed: false }
  | {
      status: "managed";
      managed: true;
      metadata: ManagedCommandMetadata;
      frontmatter: Record<string, string>;
      body: string;
    }
  | { status: "malformed"; managed: true; error: string };

export type ParsedManagedExtension =
  | { status: "unmanaged"; managed: false }
  | {
      status: "managed";
      managed: true;
      metadata: ManagedExtensionMetadata;
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

export function renderManagedCommand(action: WriteCommandAction): string {
  const description = action.description ?? `Run ${action.sourceName} on demand.`;
  const body = action.sourceContent.endsWith("\n")
    ? action.sourceContent
    : `${action.sourceContent}\n`;

  return [
    "---",
    `description: ${frontmatterScalarLiteral(description)}`,
    `${MANAGED_COMMAND_FRONTMATTER_KEY}: ${frontmatterScalarLiteral(MANAGED_COMMAND_FRONTMATTER_VERSION)}`,
    `sourceId: ${frontmatterScalarLiteral(action.sourceId)}`,
    `sourceName: ${frontmatterScalarLiteral(action.sourceName)}`,
    `sourceHash: ${frontmatterScalarLiteral(action.sourceHash)}`,
    `slug: ${frontmatterScalarLiteral(action.slug)}`,
    `commandName: ${frontmatterScalarLiteral(action.commandName)}`,
    `sourceBytes: ${action.sourceBytes}`,
    "---",
    body,
  ].join("\n");
}

export function renderManagedExtension(action: WriteExtensionAction): string {
  const metadata = [
    MANAGED_EXTENSION_HEADER,
    "version: 1",
    `sourceId: ${action.sourceId}`,
    `sourceName: ${action.sourceName}`,
    `sourceHash: ${action.sourceHash}`,
    `slug: ${action.slug}`,
    `extensionName: ${action.extensionName}`,
    `sourceBytes: ${action.sourceBytes}`,
    MANAGED_EXTENSION_END,
  ].join("\n");
  const body = action.sourceContent.endsWith("\n")
    ? action.sourceContent
    : `${action.sourceContent}\n`;

  return `${metadata}\n${body}`;
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

export function parseManagedCommand(text: string): ParsedManagedCommand {
  if (text.startsWith(MANAGED_COMMAND_HEADER)) {
    const headerEnd = text.indexOf(MANAGED_RULE_END, MANAGED_COMMAND_HEADER.length);
    if (headerEnd === -1) {
      return { status: "malformed", managed: true, error: "managed header is not closed" };
    }

    const headerText = text.slice(0, headerEnd).trimEnd();
    const metadataResult = parseCommandMetadata(headerText);
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

  const frontmatterResult = parseFrontmatter(text);
  if (typeof frontmatterResult === "string") {
    if (
      (text.startsWith("---\n") || text.startsWith("---\r\n")) &&
      text.includes(`${MANAGED_COMMAND_FRONTMATTER_KEY}:`)
    ) {
      return { status: "malformed", managed: true, error: frontmatterResult };
    }
    return { status: "unmanaged", managed: false };
  }

  if (!frontmatterResult.frontmatter[MANAGED_COMMAND_FRONTMATTER_KEY]) {
    return { status: "unmanaged", managed: false };
  }

  const metadataResult = parseCommandFrontmatterMetadata(frontmatterResult.frontmatter);
  if (typeof metadataResult === "string") {
    return { status: "malformed", managed: true, error: metadataResult };
  }

  return {
    status: "managed",
    managed: true,
    metadata: metadataResult,
    frontmatter: frontmatterResult.frontmatter,
    body: stripTrailingNewline(frontmatterResult.body),
  };
}

export function parseManagedExtension(text: string): ParsedManagedExtension {
  if (!text.startsWith(MANAGED_EXTENSION_HEADER)) {
    return { status: "unmanaged", managed: false };
  }

  const headerEnd = text.indexOf(MANAGED_EXTENSION_END, MANAGED_EXTENSION_HEADER.length);
  if (headerEnd === -1) {
    return { status: "malformed", managed: true, error: "managed extension header is not closed" };
  }

  const headerText = text.slice(0, headerEnd).trimEnd();
  const metadataResult = parseExtensionMetadata(headerText);
  if (typeof metadataResult === "string") {
    return { status: "malformed", managed: true, error: metadataResult };
  }

  const body = text.slice(headerEnd + MANAGED_EXTENSION_END.length).replace(/^\r?\n/, "");
  return {
    status: "managed",
    managed: true,
    metadata: metadataResult,
    body: stripTrailingNewline(body),
  };
}

function renderFrontmatter(action: WriteRuleAction): string {
  if (action.mode === "ttsr") {
    if (!action.condition) {
      throw new Error(`TTSR rule ${action.slug} is missing a condition`);
    }
    return [
      `condition: ${frontmatterScalarLiteral(action.condition)}`,
      ...(action.triggers ? [`triggers: ${frontmatterScalarLiteral(action.triggers)}`] : []),
      `scope: ${frontmatterScalarLiteral(action.scope ?? "text")}`,
    ].join("\n");
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

function parseCommandMetadata(headerText: string): ManagedCommandMetadata | string {
  const lines = headerText.split(/\r?\n/);
  if (lines[0] !== MANAGED_COMMAND_HEADER) {
    return "managed command header marker is invalid";
  }

  const raw: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  return parseCommandMetadataFields(raw);
}

function parseCommandFrontmatterMetadata(frontmatter: Record<string, string>): ManagedCommandMetadata | string {
  if (frontmatter[MANAGED_COMMAND_FRONTMATTER_KEY] !== MANAGED_COMMAND_FRONTMATTER_VERSION) {
    return "managed command metadata has invalid version";
  }

  return parseCommandMetadataFields({
    version: frontmatter[MANAGED_COMMAND_FRONTMATTER_KEY],
    sourceId: frontmatter.sourceId,
    sourceName: frontmatter.sourceName,
    sourceHash: frontmatter.sourceHash,
    slug: frontmatter.slug,
    commandName: frontmatter.commandName,
    sourceBytes: frontmatter.sourceBytes,
  });
}

function parseCommandMetadataFields(raw: Record<string, string | undefined>): ManagedCommandMetadata | string {
  const versionRaw = raw.version;
  const sourceId = raw.sourceId;
  const sourceName = raw.sourceName;
  const sourceHash = raw.sourceHash;
  const slug = raw.slug;
  const commandName = raw.commandName;
  const sourceBytesRaw = raw.sourceBytes;
  if (!versionRaw) return "managed command metadata missing version";
  if (!sourceId) return "managed command metadata missing sourceId";
  if (!sourceName) return "managed command metadata missing sourceName";
  if (!sourceHash) return "managed command metadata missing sourceHash";
  if (!slug) return "managed command metadata missing slug";
  if (!commandName) return "managed command metadata missing commandName";
  if (!sourceBytesRaw) return "managed command metadata missing sourceBytes";

  const version = Number(versionRaw);
  const sourceBytes = Number(sourceBytesRaw);
  if (!Number.isInteger(version) || version <= 0) return "managed command metadata has invalid version";
  if (!Number.isInteger(sourceBytes) || sourceBytes < 0) return "managed command metadata has invalid sourceBytes";

  return {
    version,
    sourceId,
    sourceName,
    sourceHash,
    slug,
    commandName,
    sourceBytes,
  };
}

function parseExtensionMetadata(headerText: string): ManagedExtensionMetadata | string {
  const lines = headerText.split(/\r?\n/);
  if (lines[0] !== MANAGED_EXTENSION_HEADER) {
    return "managed extension header marker is invalid";
  }

  const raw: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const required = ["version", "sourceId", "sourceName", "sourceHash", "slug", "extensionName", "sourceBytes"];
  for (const key of required) {
    if (!raw[key]) return `managed extension metadata missing ${key}`;
  }

  const version = Number(raw.version);
  const sourceBytes = Number(raw.sourceBytes);
  if (!Number.isInteger(version) || version <= 0) return "managed extension metadata has invalid version";
  if (!Number.isInteger(sourceBytes) || sourceBytes < 0) return "managed extension metadata has invalid sourceBytes";

  return {
    version,
    sourceId: raw.sourceId,
    sourceName: raw.sourceName,
    sourceHash: raw.sourceHash,
    slug: raw.slug,
    extensionName: raw.extensionName,
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
