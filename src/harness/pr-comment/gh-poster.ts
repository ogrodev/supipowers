/**
 * `gh` CLI wrapper for the harness PR sticky comment.
 *
 * Fail-open by design: every failure path returns a typed `PostOutcome` instead of
 * throwing, so the caller can decide whether to surface a workflow-summary fallback. The
 * pipeline never blocks on PR-comment posting.
 *
 * Pattern mirrors `src/fix-pr/fetch-comments.ts` and `src/release/channels/github.ts`:
 * we never construct an Octokit client; `platform.exec("gh", [...])` is the only
 * dependency.
 */

import type { Platform } from "../../platform/types.js";
import { parseMarker, STICKY_MARKER_PREFIX } from "./status.js";
import type { PrCommentStatus } from "./types.js";

/** Outcome of an upsert attempt. */
export type PostOutcome =
  | { kind: "created"; commentId: number }
  | { kind: "updated"; commentId: number }
  | { kind: "unchanged"; commentId: number; reason: "status-unchanged" }
  | { kind: "skipped"; reason: "no-auth" | "no-cli" | "no-pr-env" }
  | { kind: "failed"; reason: string };

export interface PostStickyOptions {
  repo: string;
  prNumber: number;
  cwd: string;
  body: string;
  mode: "every-push" | "on-status-change";
  currentStatus: PrCommentStatus;
}

/**
 * Idempotent upsert of the sticky comment.
 *
 *  1. Verify `gh` is installed and authenticated.
 *  2. List PR comments; find the first whose body starts with the harness marker prefix.
 *  3. When `mode === "on-status-change"`, parse the previous status; bail with `unchanged`
 *     when it matches `currentStatus`.
 *  4. PATCH the existing comment, or POST a new one when nothing matched.
 */
export async function postStickyComment(
  platform: Platform,
  options: PostStickyOptions,
): Promise<PostOutcome> {
  const { repo, prNumber, cwd, body, mode, currentStatus } = options;

  const auth = await checkAuth(platform, cwd);
  if (auth.kind !== "ok") return auth;

  const existing = await findStickyComment(platform, repo, prNumber, cwd);
  if (existing.kind === "failed") return existing;

  if (existing.kind === "found") {
    if (mode === "on-status-change") {
      const parsed = parseMarker(existing.body);
      if (parsed && parsed.status === currentStatus) {
        return { kind: "unchanged", commentId: existing.id, reason: "status-unchanged" };
      }
    }
    const patched = await patchComment(platform, repo, existing.id, body, cwd);
    return patched;
  }

  // No sticky yet — create one.
  return createComment(platform, repo, prNumber, body, cwd);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function checkAuth(
  platform: Platform,
  cwd: string,
): Promise<{ kind: "ok" } | { kind: "skipped"; reason: "no-auth" | "no-cli" }> {
  let result: Awaited<ReturnType<Platform["exec"]>>;
  try {
    result = await platform.exec("gh", ["auth", "status"], { cwd });
  } catch {
    // ENOENT (gh missing) or other spawn-time failure — treat as no-cli.
    return { kind: "skipped", reason: "no-cli" };
  }
  if (result.code === 0) return { kind: "ok" };
  return { kind: "skipped", reason: "no-auth" };
}

type FindResult =
  | { kind: "found"; id: number; body: string }
  | { kind: "not-found" }
  | { kind: "failed"; reason: string };

async function findStickyComment(
  platform: Platform,
  repo: string,
  prNumber: number,
  cwd: string,
): Promise<FindResult> {
  let result: Awaited<ReturnType<Platform["exec"]>>;
  try {
    result = await platform.exec(
      "gh",
      [
        "api",
        "--paginate",
        `repos/${repo}/issues/${prNumber}/comments`,
        "--jq",
        ".[] | {id, body}",
      ],
      { cwd },
    );
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) {
    return {
      kind: "failed",
      reason: result.stderr.trim() || `gh api exited with code ${result.code}`,
    };
  }
  // `--jq '.[] | {id, body}'` emits one JSON object per line (NOT a JSON array). Crucially,
  // bodies may contain newlines — the `--jq` filter on a *list* shouldn't, because jq's
  // default emits compact JSON for objects, but we still parse defensively.
  for (const line of splitJsonObjects(result.stdout)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const obj = parsed as { id?: unknown; body?: unknown };
    if (typeof obj.id !== "number" || typeof obj.body !== "string") continue;
    if (obj.body.startsWith(STICKY_MARKER_PREFIX)) {
      return { kind: "found", id: obj.id, body: obj.body };
    }
  }
  return { kind: "not-found" };
}

async function createComment(
  platform: Platform,
  repo: string,
  prNumber: number,
  body: string,
  cwd: string,
): Promise<PostOutcome> {
  let result: Awaited<ReturnType<Platform["exec"]>>;
  try {
    result = await platform.exec(
      "gh",
      [
        "api",
        "-X", "POST",
        `repos/${repo}/issues/${prNumber}/comments`,
        "-f", `body=${body}`,
      ],
      { cwd },
    );
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) {
    return { kind: "failed", reason: result.stderr.trim() || `gh api POST exited with code ${result.code}` };
  }
  const id = extractCommentId(result.stdout);
  if (id === null) {
    return { kind: "failed", reason: "gh api POST succeeded but response is missing comment id" };
  }
  return { kind: "created", commentId: id };
}

async function patchComment(
  platform: Platform,
  repo: string,
  commentId: number,
  body: string,
  cwd: string,
): Promise<PostOutcome> {
  let result: Awaited<ReturnType<Platform["exec"]>>;
  try {
    result = await platform.exec(
      "gh",
      [
        "api",
        "-X", "PATCH",
        `repos/${repo}/issues/comments/${commentId}`,
        "-f", `body=${body}`,
      ],
      { cwd },
    );
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) {
    return { kind: "failed", reason: result.stderr.trim() || `gh api PATCH exited with code ${result.code}` };
  }
  return { kind: "updated", commentId };
}

function extractCommentId(stdout: string): number | null {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "number") {
      return (parsed as { id: number }).id;
    }
  } catch {
    // Fall through to regex scan; gh api can be configured with --jq for partial outputs.
  }
  const match = /"id"\s*:\s*(\d+)/.exec(stdout);
  return match ? Number(match[1]) : null;
}

/**
 * Split jq stream output into individual JSON object strings. jq's stream mode separates
 * objects with a single newline, but body fields may contain unescaped newlines when the
 * comment uses raw markdown. We rely on `JSON.parse` to validate each candidate and fall
 * back to a line-based split.
 */
function splitJsonObjects(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  // Fast path: each line is its own object (the common case for `--jq '.[] | {id, body}'`).
  const lines = trimmed.split(/\n(?=\{)/).map((s) => s.trim()).filter((s) => s.length > 0);
  return lines;
}
