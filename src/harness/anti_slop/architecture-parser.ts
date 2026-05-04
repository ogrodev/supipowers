/**
 * Parse `docs/architecture.md` into a layer table.
 *
 * Convention: the architecture doc contains a single GFM-style table with the columns
 * `Layer`, `Files`, `Allowed`, `Forbidden`, optionally followed by a `Description` column.
 * `Files` and `Allowed`/`Forbidden` cells use comma-separated values; backticks around
 * globs are stripped.
 *
 * Example:
 * ```
 * | Layer    | Files                | Allowed                  | Forbidden          |
 * |----------|----------------------|--------------------------|--------------------|
 * | domain   | `src/domain/**`      | domain                   | infra, ui          |
 * | infra    | `src/infrastructure/**` | domain, infra         | ui                 |
 * | ui       | `src/ui/**`          | domain, infra, ui        | —                  |
 * ```
 *
 * Empty cells (`—`, `-`, blank) are treated as the empty list.
 *
 * The parser is deliberately permissive: malformed tables produce `[]`, not an error. The
 * layer-context-inject hook degrades gracefully when no rules are parsed.
 */

import type { HarnessLayerRule } from "../../types.js";

interface Row {
  layer: string;
  files: string[];
  allowed: string[];
  forbidden: string[];
  description?: string;
}

const LAYER_HEADERS = ["layer"];
const FILE_HEADERS = ["files", "globs", "paths"];
const ALLOWED_HEADERS = ["allowed", "allowedimports", "imports"];
const FORBIDDEN_HEADERS = ["forbidden", "forbiddenimports", "denied"];
const DESCRIPTION_HEADERS = ["description", "notes"];

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function parseListCell(cell: string): string[] {
  const stripped = cell.trim();
  if (!stripped || stripped === "—" || stripped === "-") return [];
  return stripped
    .split(",")
    .map((part) => part.replace(/`/g, "").trim())
    .filter((part) => part.length > 0);
}

function isSeparatorRow(cells: string[]): boolean {
  // GFM table separators look like `|---|---|---|` — every cell is dashes (with optional
  // colons for alignment).
  return cells.every((cell) => /^[-:\s]+$/.test(cell));
}

function splitRow(line: string): string[] {
  // Strip leading/trailing pipe, split on `|`, trim each cell.
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\||\|$/g, "");
  return inner.split("|").map((c) => c.trim());
}

/**
 * Walk markdown line-by-line and extract every well-formed table. Returns rows from the
 * FIRST table whose header includes a `Layer` column. Subsequent tables are ignored —
 * the architecture doc convention is one canonical layer table.
 */
function findLayerTable(markdown: string): Row[] {
  const lines = markdown.split(/\r?\n/);
  let inTable = false;
  let columnMap: { layer?: number; files?: number; allowed?: number; forbidden?: number; description?: number } | null = null;
  const rows: Row[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isPipeLine = line.includes("|");

    if (!inTable) {
      if (!isPipeLine) continue;
      const cells = splitRow(line);
      const next = i + 1 < lines.length ? lines[i + 1] : "";
      if (!next.includes("|")) continue;
      if (!isSeparatorRow(splitRow(next))) continue;

      // Header row.
      const map: { layer?: number; files?: number; allowed?: number; forbidden?: number; description?: number } = {};
      for (let c = 0; c < cells.length; c += 1) {
        const header = normalizeHeader(cells[c]);
        if (LAYER_HEADERS.includes(header)) map.layer = c;
        else if (FILE_HEADERS.includes(header)) map.files = c;
        else if (ALLOWED_HEADERS.includes(header)) map.allowed = c;
        else if (FORBIDDEN_HEADERS.includes(header)) map.forbidden = c;
        else if (DESCRIPTION_HEADERS.includes(header)) map.description = c;
      }

      // Reject tables that are missing the essential columns.
      if (map.layer === undefined || map.files === undefined) continue;
      if (map.allowed === undefined && map.forbidden === undefined) continue;

      columnMap = map;
      inTable = true;
      i += 1; // skip the separator on next iteration
      continue;
    }

    if (!isPipeLine) {
      // Blank line or non-table content terminates the table.
      break;
    }

    const cells = splitRow(line);
    if (isSeparatorRow(cells)) continue;
    if (!columnMap) continue;

    const layer = cells[columnMap.layer ?? 0]?.trim();
    if (!layer) continue;

    rows.push({
      layer,
      files: parseListCell(cells[columnMap.files ?? 0] ?? ""),
      allowed: columnMap.allowed !== undefined ? parseListCell(cells[columnMap.allowed] ?? "") : [],
      forbidden: columnMap.forbidden !== undefined ? parseListCell(cells[columnMap.forbidden] ?? "") : [],
      description:
        columnMap.description !== undefined && cells[columnMap.description]?.trim()
          ? cells[columnMap.description].trim()
          : undefined,
    });
  }

  return rows;
}

/**
 * Parse architecture markdown into HarnessLayerRule entries. Returns `[]` when no
 * recognizable layer table is present.
 */
export function parseArchitectureMarkdown(markdown: string): HarnessLayerRule[] {
  const rows = findLayerTable(markdown);
  return rows.map((row) => ({
    layer: row.layer,
    globs: row.files,
    allowedImports: row.allowed,
    forbiddenImports: row.forbidden,
    ...(row.description ? { description: row.description } : {}),
  }));
}

/**
 * Resolve the layer for a given file path against parsed rules. Glob matching is naive:
 * we strip ``**`` and trailing slashes and check `startsWith` after normalization. This
 * handles the convention `src/<layer>/**` without dragging in a glob library.
 */
export function resolveLayerForFile(
  filePath: string,
  rules: readonly HarnessLayerRule[],
): HarnessLayerRule | null {
  const normalized = filePath.replace(/\\/g, "/");
  for (const rule of rules) {
    for (const glob of rule.globs) {
      if (matchesGlob(normalized, glob)) return rule;
    }
  }
  return null;
}

/**
 * Naive glob matcher tuned for the conventions parsed from architecture tables. Supports
 * `**` (any path segments) and `*` (any single segment characters). Sufficient for the
 * `src/<layer>/**` and `packages/<scope>/**\/*.ts` shapes the doc relies on.
 */
function matchesGlob(filePath: string, glob: string): boolean {
  const normalizedGlob = glob.replace(/\\/g, "/");
  const regexSrc = normalizedGlob
    .split(/(\*\*|\*)/g)
    .map((segment) => {
      if (segment === "**") return ".*";
      if (segment === "*") return "[^/]*";
      return segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const regex = new RegExp(`^${regexSrc}$`);
  return regex.test(filePath);
}

/**
 * Build the addendum string injected by the layer-context-inject hook. Caps at the
 * configured `addendum_max_chars` to bound prompt growth; truncation appends `…` so the
 * agent sees the cut.
 */
export function buildLayerAddendum(
  filePath: string,
  rule: HarnessLayerRule,
  maxChars: number,
): string {
  const allowed = rule.allowedImports.length > 0 ? rule.allowedImports.join(", ") : "(none)";
  const forbidden = rule.forbiddenImports.length > 0 ? rule.forbiddenImports.join(", ") : "(none)";
  const lines = [
    `# Architecture context (from docs/architecture.md)`,
    `You are editing \`${filePath}\` in the \`${rule.layer}\` layer.`,
    `- Permitted imports: ${allowed}`,
    `- Forbidden imports: ${forbidden}`,
  ];
  if (rule.description) lines.push(`- Notes: ${rule.description}`);
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
