import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform } from "../platform/types.js";
import type { WorkspaceTarget } from "../types.js";
import { findWorkspaceTargetForPath } from "../workspace/path-mapping.js";
import type { PrComment } from "./types.js";

const INLINE_COMMENTS_JQ =
  '.[] | {id, path, line: .line, body, user: .user.login, userType: .user.type, createdAt: .created_at, updatedAt: .updated_at, inReplyToId: .in_reply_to_id, diffHunk: .diff_hunk, state: "COMMENTED"}';

const REVIEW_COMMENTS_JQ =
  '.[] | select(.body != null and .body != "") | {id, path: null, line: null, body, user: .user.login, userType: .user.type, createdAt: .submitted_at, updatedAt: .submitted_at, inReplyToId: null, diffHunk: null, state}';


const RESOLVED_REVIEW_THREAD_COMMENT_IDS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          isResolved
          comments(first: 100) {
            nodes {
              databaseId
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

export interface ClusteredPrComments<TTarget extends WorkspaceTarget = WorkspaceTarget> {
  allComments: PrComment[];
  commentsByTargetId: Map<string, PrComment[]>;
  unscopedComments: PrComment[];
}

function appendComment(commentsByTargetId: Map<string, PrComment[]>, targetId: string, comment: PrComment): void {
  const existing = commentsByTargetId.get(targetId);
  if (existing) {
    existing.push(comment);
    return;
  }

  commentsByTargetId.set(targetId, [comment]);
}


function parseRepoOwnerAndName(repo: string): { owner: string; name: string } | null {
  const separator = repo.indexOf("/");
  if (separator <= 0 || separator === repo.length - 1) {
    return null;
  }

  return {
    owner: repo.slice(0, separator),
    name: repo.slice(separator + 1),
  };
}

function parseResolvedCommentIds(output: string): Set<number> {
  const ids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const id = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(id)) {
      ids.add(id);
    }
  }
  return ids;
}

export function parsePrCommentsJsonl(content: string): PrComment[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as PrComment];
      } catch {
        return [];
      }
    });
}

export function stringifyPrCommentsJsonl(comments: readonly PrComment[]): string {
  if (comments.length === 0) {
    return "";
  }

  return `${comments.map((comment) => JSON.stringify(comment)).join("\n")}\n`;
}

async function fetchResolvedReviewThreadCommentIds(
  platform: Platform,
  repo: string,
  prNumber: number,
  cwd: string,
): Promise<Set<number> | string> {
  const repoParts = parseRepoOwnerAndName(repo);
  if (!repoParts) {
    return `Invalid repository name: ${repo}`;
  }

  const result = await platform.exec(
    "gh",
    [
      "api",
      "graphql",
      "--paginate",
      "-f",
      `query=${RESOLVED_REVIEW_THREAD_COMMENT_IDS_QUERY}`,
      "-F",
      `owner=${repoParts.owner}`,
      "-F",
      `name=${repoParts.name}`,
      "-F",
      `number=${prNumber}`,
      "--jq",
      ".data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == true) | .comments.nodes[].databaseId",
    ],
    { cwd },
  );

  if (result.code !== 0) {
    return result.stderr || "gh api graphql failed while fetching resolved review threads";
  }

  return parseResolvedCommentIds(result.stdout);
}

function filterResolvedComments(content: string, resolvedCommentIds: ReadonlySet<number>): string {
  if (!content.trim() || resolvedCommentIds.size === 0) {
    return content;
  }

  const unresolvedLines = content
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }
      try {
        const comment = JSON.parse(trimmed) as Pick<PrComment, "id">;
        return !resolvedCommentIds.has(comment.id);
      } catch {
        return true;
      }
    });

  return unresolvedLines.length > 0 ? `${unresolvedLines.join("\n")}\n` : "";
}


export function clusterPrCommentsByTarget<TTarget extends WorkspaceTarget>(
  targets: readonly TTarget[],
  comments: readonly PrComment[],
): ClusteredPrComments<TTarget> {
  const commentsByTargetId = new Map<string, PrComment[]>();
  const rootTarget = targets.find((target) => target.kind === "root") ?? null;
  const unscopedComments: PrComment[] = [];

  for (const target of targets) {
    commentsByTargetId.set(target.id, []);
  }

  for (const comment of comments) {
    const commentPath = comment.path?.trim();
    if (!commentPath) {
      if (targets.length === 1 && rootTarget) {
        appendComment(commentsByTargetId, rootTarget.id, comment);
      } else {
        unscopedComments.push(comment);
      }
      continue;
    }

    const owner = findWorkspaceTargetForPath([...targets], commentPath);
    if (!owner) {
      unscopedComments.push(comment);
      continue;
    }

    appendComment(commentsByTargetId, owner.id, comment);
  }

  return {
    allComments: [...comments],
    commentsByTargetId,
    unscopedComments,
  };
}

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

  const resolvedCommentIds = await fetchResolvedReviewThreadCommentIds(platform, repo, prNumber, cwd);
  if (typeof resolvedCommentIds === "string") {
    return resolvedCommentIds;
  }

  if (resolvedCommentIds.size > 0) {
    fs.writeFileSync(outputPath, filterResolvedComments(fs.readFileSync(outputPath, "utf-8"), resolvedCommentIds));
  }
}
