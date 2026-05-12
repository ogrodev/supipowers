/**
 * Provenance marker for harness-generated docs.
 *
 * Every doc rendered by the docs stage carries a single HTML-style comment on the first
 * line:
 *
 *   <!-- harness-docs:session=<sid> generated=<iso> contentHash=<sha256> -->
 *
 * The marker is the only thing the user must not edit. It lets the regen-decision logic
 * distinguish between (1) a doc that is still in sync with what the harness produced,
 * (2) a doc the user hand-edited and should not be overwritten, and (3) a doc that just
 * needs to be regenerated because its inputs changed.
 *
 * Format is intentionally compact and easy to parse with a regex — the marker is on a
 * single line, fields are `key=value` pairs separated by spaces.
 */

import { sha256 } from "./source-hash.js";

const MARKER_PREFIX = "<!-- harness-docs:";
const MARKER_SUFFIX = " -->";

export interface DocProvenance {
  /** Session id that produced the doc. */
  sessionId: string;
  /** ISO timestamp the doc was generated. */
  generatedAt: string;
  /** sha256 of the doc body after the marker line (excludes the marker itself). */
  contentHash: string;
}

/** Render a provenance marker line. Always single-line; no trailing newline. */
export function renderProvenanceMarker(provenance: DocProvenance): string {
  // Each value passes through `encode` so an accidental quote/space cannot break parsing.
  const session = encodeValue(provenance.sessionId);
  const generated = encodeValue(provenance.generatedAt);
  const hash = encodeValue(provenance.contentHash);
  return `${MARKER_PREFIX}session=${session} generated=${generated} contentHash=${hash}${MARKER_SUFFIX}`;
}

/**
 * Parse a markdown doc and return its provenance + the body after the marker. Returns
 * `null` when the first line is not a recognizable marker.
 *
 * Tolerant: the marker MUST be on the first line. A doc without a first-line marker is
 * always treated as user-authored.
 */
export function parseProvenance(markdown: string): { provenance: DocProvenance; body: string } | null {
  const newlineIndex = markdown.indexOf("\n");
  const firstLine = newlineIndex >= 0 ? markdown.slice(0, newlineIndex) : markdown;
  if (!firstLine.startsWith(MARKER_PREFIX) || !firstLine.endsWith(MARKER_SUFFIX)) {
    return null;
  }

  const inner = firstLine.slice(MARKER_PREFIX.length, firstLine.length - MARKER_SUFFIX.length).trim();
  const fields = parseFields(inner);

  const sessionId = fields.get("session");
  const generatedAt = fields.get("generated");
  const contentHash = fields.get("contentHash");
  if (!sessionId || !generatedAt || !contentHash) return null;

  const body = newlineIndex >= 0 ? markdown.slice(newlineIndex + 1) : "";
  return {
    provenance: { sessionId, generatedAt, contentHash },
    body,
  };
}

/** Compute the content hash for a body (i.e., everything after the marker line). */
export function computeBodyContentHash(body: string): string {
  return sha256(body);
}

/**
 * Wrap a body with a fresh provenance marker. Convenience for renderers. Returns the full
 * doc string starting with the marker line.
 */
export function attachProvenance(body: string, provenance: DocProvenance): string {
  return `${renderProvenanceMarker(provenance)}\n${body}`;
}

/**
 * Detect whether a stored doc was hand-edited after the harness produced it. Returns:
 * - `"unmarked"` when there is no marker (treat as user-authored — never overwrite blindly).
 * - `"edited"` when the marker exists but the body hash does not match.
 * - `"intact"` when marker + body hash agree (safe to regen using the marker's sourceHash).
 */
export function detectUserEdit(markdown: string): "unmarked" | "edited" | "intact" {
  const parsed = parseProvenance(markdown);
  if (!parsed) return "unmarked";
  const actual = computeBodyContentHash(parsed.body);
  return actual === parsed.provenance.contentHash ? "intact" : "edited";
}

// ── Internals ───────────────────────────────────────────────────────────────

/** Parse the inner part of a marker into a Map of key/value pairs. */
function parseFields(inner: string): Map<string, string> {
  const out = new Map<string, string>();
  // Tokenize on whitespace. Values must not contain spaces (encodeValue enforces this).
  for (const token of inner.split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const value = decodeValue(token.slice(eq + 1));
    out.set(key, value);
  }
  return out;
}

/**
 * Encode a value so the marker remains parseable. Spaces and the literal `-->` sequence
 * are forbidden in the canonical values we accept (session id pattern, ISO timestamps,
 * hex hashes). The encode step is defensive: spaces become `%20`, the marker terminator
 * is escaped to `--&gt;`. Decoding inverts those.
 */
function encodeValue(value: string): string {
  return value.replace(/-->/g, "--&gt;").replace(/ /g, "%20");
}

function decodeValue(value: string): string {
  return value.replace(/%20/g, " ").replace(/--&gt;/g, "-->");
}
