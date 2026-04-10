import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform } from "../platform/types.js";

const INLINE_COMMENTS_JQ =
  '.[] | {id, path, line: .line, body, user: .user.login, userType: .user.type, createdAt: .created_at, updatedAt: .updated_at, inReplyToId: .in_reply_to_id, diffHunk: .diff_hunk, state: "COMMENTED"}';

const REVIEW_COMMENTS_JQ =
  '.[] | select(.body != null and .body != "") | {id, path: null, line: null, body, user: .user.login, userType: .user.type, createdAt: .submitted_at, updatedAt: .submitted_at, inReplyToId: null, diffHunk: null, state}';

/**
 * Fetch all review comments for a PR and write them as JSONL to outputPath.
 *
 * Calls `gh api` directly instead of shelling out to a bash script, avoiding
 * Windows path resolution failures when Bun.spawn invokes bash.exe without
 * a proper MSYS2 shell context.
 *
 * @returns Error message if both API calls failed, undefined on success.
 */
export async function fetchPrComments(
  platform: Platform,
  repo: string,
  prNumber: number,
  outputPath: string,
  cwd: string,
): Promise<string | undefined> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Fetch inline review comments (code-level)
  const inlineResult = await platform.exec(
    "gh",
    [
      "api",
      "--paginate",
      `repos/${repo}/pulls/${prNumber}/comments`,
      "--jq",
      INLINE_COMMENTS_JQ,
    ],
    { cwd },
  );

  // Write what we got — empty string on failure (mirrors || true in the original script)
  fs.writeFileSync(outputPath, inlineResult.code === 0 ? inlineResult.stdout : "");

  // Fetch review-level comments (top-level reviews with body text)
  const reviewResult = await platform.exec(
    "gh",
    [
      "api",
      "--paginate",
      `repos/${repo}/pulls/${prNumber}/reviews`,
      "--jq",
      REVIEW_COMMENTS_JQ,
    ],
    { cwd },
  );

  if (reviewResult.code === 0 && reviewResult.stdout) {
    fs.appendFileSync(outputPath, reviewResult.stdout);
  }

  // Both calls failed — gh is broken, not just empty results
  if (inlineResult.code !== 0 && reviewResult.code !== 0) {
    return inlineResult.stderr || reviewResult.stderr || "gh api calls failed";
  }
}
