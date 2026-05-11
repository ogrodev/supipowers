/**
 * Status derivation + sticky-marker round-trip.
 *
 * The marker line is a stable HTML comment that:
 *   - lets the gh-poster find the existing sticky comment by prefix;
 *   - lets `on-status-change` mode parse the previously posted status without re-reading
 *     any local state (the comment body is the single source of truth).
 *
 * Format:
 *   <!-- supipowers:harness:v1 status=<status> strict=<n> lenient=<n> session=<id> generatedAt=<iso> -->
 *
 * Versioned (`:v1`) so a future change to the marker shape can coexist with old comments.
 */

import type { HarnessValidateReport } from "../../types.js";
import type { PrCommentStatus } from "./types.js";

/** Single shared prefix used by both the renderer and the poster's lookup query. */
export const STICKY_MARKER_PREFIX = "<!-- supipowers:harness:v1 ";

/**
 * Derive the status banner from a validate report.
 *
 * `report.passed` is the AND of (all checks passed) and (score floor satisfied), so we
 * branch on its two ingredients independently rather than the combined flag — that's how
 * we distinguish "checks passed but score below floor" (warned) from "a check actually
 * failed" (failed).
 */
export function deriveStatus(report: HarnessValidateReport): PrCommentStatus {
  const anyCheckFailed = report.checks.some((check) => !check.passed);
  if (anyCheckFailed) return "failed";
  if (!report.scoreFloorPassed) return "warned";
  // Defensive: when checks pass and floor passes but report.passed is false, treat as
  // failed so we don't paint over an upstream bug. In practice this branch is unreachable
  // when callers populate the report correctly.
  if (!report.passed) return "failed";
  return "passed";
}

/** Fields embedded in a sticky-comment marker. */
export interface MarkerFields {
  status: PrCommentStatus;
  strict: number;
  lenient: number;
  sessionId: string;
  generatedAt: string;
}

/** Serialize fields into the canonical marker line. */
export function renderMarker(fields: MarkerFields): string {
  // `sessionId` is harness-generated (ULID-like) and never contains spaces; we still
  // assert below so a bad input doesn't silently corrupt the marker.
  if (/\s/.test(fields.sessionId)) {
    throw new Error(`sessionId must not contain whitespace: ${JSON.stringify(fields.sessionId)}`);
  }
  return (
    `${STICKY_MARKER_PREFIX}` +
    `status=${fields.status} ` +
    `strict=${fields.strict} ` +
    `lenient=${fields.lenient} ` +
    `session=${fields.sessionId} ` +
    `generatedAt=${fields.generatedAt} ` +
    `-->`
  );
}

/**
 * Best-effort parse of a marker line. Returns null when the body does not start with
 * STICKY_MARKER_PREFIX or any required field is missing. We deliberately do not throw —
 * callers treat "unparseable" as "no previous comment".
 */
export function parseMarker(body: string): MarkerFields | null {
  const firstNewline = body.indexOf("\n");
  const head = firstNewline === -1 ? body : body.slice(0, firstNewline);
  if (!head.startsWith(STICKY_MARKER_PREFIX)) return null;
  // Strip the prefix + trailing "-->", then split on whitespace.
  const inner = head.slice(STICKY_MARKER_PREFIX.length).replace(/\s*-->\s*$/, "").trim();
  if (inner.length === 0) return null;
  const tokens = inner.split(/\s+/);
  const map: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    map[token.slice(0, eq)] = token.slice(eq + 1);
  }
  const status = map.status;
  const strict = Number(map.strict);
  const lenient = Number(map.lenient);
  const sessionId = map.session;
  const generatedAt = map.generatedAt;
  if (status !== "passed" && status !== "warned" && status !== "failed") return null;
  if (!Number.isFinite(strict) || !Number.isFinite(lenient)) return null;
  if (!sessionId || !generatedAt) return null;
  return { status, strict, lenient, sessionId, generatedAt };
}
