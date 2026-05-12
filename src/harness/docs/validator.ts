/**
 * Synchronous validator for a per-layer doc rendered by a docs-stage subagent.
 *
 * Validation is mechanical: LOC caps, required headings in order, frontmatter shape,
 * agent-context section cap, sourceHash match, no TODO/XXX markers. The validator runs
 * inside the `harness_docs_record` tool handler, so failures must be safe to surface to
 * the subagent (structured error strings).
 */

import { parseProvenance } from "./provenance.js";

export interface ValidateLayerDocOptions {
  /** Expected layer id (from the assignment). */
  expectedLayerId: string;
  /** Expected sourceHash; the renderer must embed this verbatim. */
  expectedSourceHash: string;
  /** Hard cap on total LOC (default 150). */
  maxDocLoc?: number;
  /** Hard cap on the `## Agent context` section LOC (default 30). */
  maxAgentContextLoc?: number;
}

export const DEFAULT_MAX_DOC_LOC = 150;
export const DEFAULT_MAX_AGENT_CONTEXT_LOC = 30;

/** Required headings, in the order the doc must place them. */
export const REQUIRED_HEADINGS: readonly string[] = [
  "## Agent context",
  "## Purpose",
  "## Files",
  "## Imports",
  "## Conventions",
];

const PLACEHOLDER_PATTERN = /\b(TODO|XXX|FIXME|TBD|<placeholder>)\b/;

export interface ValidateLayerDocResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a layer-doc markdown body. Returns `{ ok, errors }`. `errors` is empty when
 * `ok === true`.
 */
export function validateLayerDocMarkdown(
  markdown: string,
  options: ValidateLayerDocOptions,
): ValidateLayerDocResult {
  const errors: string[] = [];
  const maxDocLoc = options.maxDocLoc ?? DEFAULT_MAX_DOC_LOC;
  const maxAgentContextLoc = options.maxAgentContextLoc ?? DEFAULT_MAX_AGENT_CONTEXT_LOC;

  // 1. Provenance marker on first line.
  const parsed = parseProvenance(markdown);
  if (!parsed) {
    errors.push("missing or malformed provenance marker on the first line");
  }

  // 2. LOC budget.
  const lineCount = countDocLines(markdown);
  if (lineCount > maxDocLoc) {
    errors.push(`doc has ${lineCount} LOC; max is ${maxDocLoc}`);
  }

  // 3. Frontmatter — between the first --- after the marker and the next ---.
  const frontmatter = extractFrontmatter(parsed?.body ?? markdown);
  if (!frontmatter) {
    errors.push("missing YAML frontmatter (---\\n…\\n---) immediately after the marker");
  } else {
    if (frontmatter.layer !== options.expectedLayerId) {
      errors.push(
        `frontmatter layer mismatch (got "${frontmatter.layer ?? ""}", expected "${options.expectedLayerId}")`,
      );
    }
    if (!frontmatter.generatedAt) {
      errors.push("frontmatter is missing `generatedAt`");
    }
    if (!frontmatter.sourceHash) {
      errors.push("frontmatter is missing `sourceHash`");
    } else if (frontmatter.sourceHash !== options.expectedSourceHash) {
      errors.push(
        `frontmatter sourceHash mismatch (got "${frontmatter.sourceHash}", expected "${options.expectedSourceHash}")`,
      );
    }
  }

  // 4. Required headings in order.
  const headingResult = checkHeadings(markdown);
  if (headingResult.missing.length > 0) {
    errors.push(`missing required heading(s): ${headingResult.missing.join(", ")}`);
  }
  if (headingResult.outOfOrder) {
    errors.push(`required headings appear out of order — expected: ${REQUIRED_HEADINGS.join(" → ")}`);
  }

  // 5. Agent-context cap.
  const agentSectionLoc = sectionLoc(markdown, "## Agent context");
  if (agentSectionLoc > maxAgentContextLoc) {
    errors.push(`## Agent context section is ${agentSectionLoc} LOC; max is ${maxAgentContextLoc}`);
  }

  // 6. Placeholder markers.
  if (PLACEHOLDER_PATTERN.test(markdown)) {
    errors.push("doc contains a TODO/XXX/FIXME/TBD placeholder marker; remove before recording");
  }

  return { ok: errors.length === 0, errors };
}

/** Count LOC ignoring a trailing empty line (matches representativeFiles `countLines`). */
function countDocLines(markdown: string): number {
  if (markdown.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < markdown.length; i += 1) {
    if (markdown.charCodeAt(i) === 10 /* \n */) count += 1;
  }
  if (markdown.charCodeAt(markdown.length - 1) === 10) count -= 1;
  return count;
}

interface ParsedFrontmatter {
  layer?: string;
  generatedAt?: string;
  sourceHash?: string;
  /** Raw map for tests / future fields. */
  raw: Map<string, string>;
}

function extractFrontmatter(body: string): ParsedFrontmatter | null {
  if (!body.startsWith("---")) return null;
  const newlineAfterOpen = body.indexOf("\n");
  if (newlineAfterOpen < 0) return null;
  // Find the next "\n---" closer.
  const closeIdx = body.indexOf("\n---", newlineAfterOpen);
  if (closeIdx < 0) return null;

  const inner = body.slice(newlineAfterOpen + 1, closeIdx);
  const map = new Map<string, string>();
  for (const line of inner.split("\n")) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    map.set(m[1], m[2].trim());
  }
  return {
    layer: map.get("layer"),
    generatedAt: map.get("generatedAt"),
    sourceHash: map.get("sourceHash"),
    raw: map,
  };
}

function checkHeadings(markdown: string): { missing: string[]; outOfOrder: boolean } {
  const seen: { heading: string; index: number }[] = [];
  for (const heading of REQUIRED_HEADINGS) {
    const pattern = new RegExp(`^${escapeRegex(heading)}\\s*$`, "m");
    const match = markdown.match(pattern);
    if (match && typeof match.index === "number") {
      seen.push({ heading, index: match.index });
    }
  }

  const missing = REQUIRED_HEADINGS.filter(
    (h) => !seen.some((entry) => entry.heading === h),
  );

  // Check ordering only for headings we did see.
  let outOfOrder = false;
  let lastIndex = -1;
  for (const heading of REQUIRED_HEADINGS) {
    const entry = seen.find((s) => s.heading === heading);
    if (!entry) continue;
    if (entry.index < lastIndex) {
      outOfOrder = true;
      break;
    }
    lastIndex = entry.index;
  }
  return { missing: missing.slice(), outOfOrder };
}

/** Count LOC of the section starting at `heading` (exclusive) up to the next `## ` heading. */
export function sectionLoc(markdown: string, heading: string): number {
  const lines = markdown.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === heading || lines[i].startsWith(`${heading} `)) {
      start = i;
      break;
    }
  }
  if (start < 0) return 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ") || lines[i] === "##") {
      end = i;
      break;
    }
  }
  // Trim trailing blank lines.
  while (end > start + 1 && lines[end - 1].trim() === "") end -= 1;
  return Math.max(0, end - start - 1);
}

/** Extract the body of the `## Agent context` section. Returns "" when missing. */
export function extractAgentContextSection(markdown: string, maxLoc?: number): string {
  const lines = markdown.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === "## Agent context" || lines[i].startsWith("## Agent context ")) {
      start = i;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ") || lines[i] === "##") {
      end = i;
      break;
    }
  }
  while (end > start + 1 && lines[end - 1].trim() === "") end -= 1;
  let bodyLines = lines.slice(start + 1, end);
  if (maxLoc !== undefined && bodyLines.length > maxLoc) {
    bodyLines = bodyLines.slice(0, maxLoc);
  }
  return bodyLines.join("\n");
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
