import { createHash } from "node:crypto";

export const TOKENIGNORE_BEGIN_MARKER = "# BEGIN supipowers context optimizer managed block";
export const TOKENIGNORE_END_MARKER = "# END supipowers context optimizer managed block";

export const DEFAULT_TOKENIGNORE_ENTRIES = [
  ".omp/supipowers/reviews/",
  ".omp/supipowers/debug/",
  ".omp/supipowers/reports/",
  ".omp/supipowers/fix-pr-sessions/",
  ".omp/supipowers/qa-sessions/",
  ".omp/supipowers/ui-design/",
  ".omp/supipowers/visual/",
  ".omp/supipowers/sessions/*.db",
  ".omp/supipowers/sessions/*.db-*",
  "dist/",
  "coverage/",
];

export interface ManagedTokenignoreMergeResult {
  content: string;
  entries: string[];
  hash: string;
}

export type ParsedManagedTokenignore =
  | { status: "unmanaged"; managed: false }
  | {
      status: "managed";
      managed: true;
      entries: string[];
      hash: string;
      expectedHash: string;
      hashMatches: boolean;
    }
  | { status: "malformed"; managed: true; error: string };

export function hashTokenignoreEntries(entries: string[]): string {
  return createHash("sha256")
    .update(normalizeEntries(entries).sort().join("\n"))
    .digest("hex");
}

export function renderManagedTokenignoreBlock(entries: string[]): string {
  const normalized = normalizeEntries(entries);
  const hash = hashTokenignoreEntries(normalized);
  return [
    TOKENIGNORE_BEGIN_MARKER,
    "# Managed by supipowers. Edit entries outside this block.",
    `# hash: ${hash}`,
    ...normalized,
    TOKENIGNORE_END_MARKER,
  ].join("\n");
}

export function mergeManagedTokenignore(
  existing: string | null | undefined,
  entries: string[],
): ManagedTokenignoreMergeResult {
  const normalized = normalizeEntries(entries);
  const hash = hashTokenignoreEntries(normalized);
  const block = renderManagedTokenignoreBlock(normalized);
  const userContent = removeManagedTokenignoreBlocks(existing ?? "").trimEnd();
  const content = userContent.length > 0
    ? `${userContent}\n\n${block}\n`
    : `${block}\n`;

  return { content, entries: normalized, hash };
}

export function parseManagedTokenignore(text: string | null | undefined): ParsedManagedTokenignore {
  const content = text ?? "";
  const begin = content.indexOf(TOKENIGNORE_BEGIN_MARKER);
  if (begin === -1) return { status: "unmanaged", managed: false };

  const end = content.indexOf(TOKENIGNORE_END_MARKER, begin + TOKENIGNORE_BEGIN_MARKER.length);
  if (end === -1) {
    return { status: "malformed", managed: true, error: "managed tokenignore block is missing end marker" };
  }

  const block = content.slice(begin, end + TOKENIGNORE_END_MARKER.length);
  const lines = block.split(/\r?\n/);
  let hash: string | null = null;
  const entries: string[] = [];

  for (const rawLine of lines.slice(1, -1)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("# hash:")) {
      hash = line.slice("# hash:".length).trim();
      continue;
    }
    if (line.startsWith("#")) continue;
    entries.push(line);
  }

  if (!hash) {
    return { status: "malformed", managed: true, error: "managed tokenignore block is missing hash" };
  }

  const normalized = normalizeEntries(entries);
  const expectedHash = hashTokenignoreEntries(normalized);
  return {
    status: "managed",
    managed: true,
    entries: normalized,
    hash,
    expectedHash,
    hashMatches: hash === expectedHash,
  };
}

function normalizeEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function removeManagedTokenignoreBlocks(existing: string): string {
  let output = existing;

  while (true) {
    const begin = output.indexOf(TOKENIGNORE_BEGIN_MARKER);
    if (begin === -1) return output;
    const end = output.indexOf(TOKENIGNORE_END_MARKER, begin + TOKENIGNORE_BEGIN_MARKER.length);
    const removeEnd = end === -1
      ? output.length
      : end + TOKENIGNORE_END_MARKER.length + trailingNewlineLength(output, end + TOKENIGNORE_END_MARKER.length);
    output = output.slice(0, begin) + output.slice(removeEnd);
  }
}

function trailingNewlineLength(value: string, index: number): number {
  if (value.slice(index, index + 2) === "\r\n") return 2;
  if (value[index] === "\n") return 1;
  return 0;
}
