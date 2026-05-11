/**
 * GitHub Actions environment detection for the PR comment subcommand.
 *
 * The harness PR comment workflow runs in two contexts:
 *   - inside GitHub Actions on a `pull_request` event (real CI run), and
 *   - locally for `--dry-run` previews and ad-hoc testing.
 *
 * This module owns the detection of the former. It deliberately does no IO except reading
 * a single event JSON file when `GITHUB_EVENT_PATH` is provided.
 */

import * as fs from "node:fs";

export interface CiContext {
  /** "owner/repo" — extracted from GITHUB_REPOSITORY or supplied via flag. */
  repo: string;
  /** PR number — from the event payload or the --pr flag. */
  prNumber: number;
  /** Optional run URL, used in the comment footer. */
  runUrl?: string;
  /** Optional base ref, e.g. "main@a1b2c3d", used in the summary line. */
  baseRef?: string;
}

/** Manual overrides parsed from CLI flags; flag values win over env. */
export interface CiContextOverrides {
  repo?: string;
  prNumber?: number;
}

/**
 * Detect the CI context from environment variables, applying optional overrides on top.
 *
 * Returns null when neither the env nor the overrides produce a complete `{repo, prNumber}`
 * pair — that's how the handler decides to fall back to the workflow summary.
 */
export function detectCiContext(
  env: NodeJS.ProcessEnv = process.env,
  overrides: CiContextOverrides = {},
): CiContext | null {
  const repo = overrides.repo ?? env.GITHUB_REPOSITORY;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    if (!repo) return null;
    // Malformed repo string (e.g. missing slash). Return null rather than corrupting URLs.
    return null;
  }

  let prNumber = overrides.prNumber;
  let baseRef: string | undefined;
  if (prNumber === undefined) {
    const fromEvent = readPullRequestFromEvent(env);
    if (fromEvent) {
      prNumber = fromEvent.prNumber;
      baseRef = fromEvent.baseRef;
    }
  }
  if (prNumber === undefined || !Number.isFinite(prNumber) || prNumber <= 0) {
    return null;
  }

  const runUrl = buildRunUrl(env, repo);
  const ctx: CiContext = { repo, prNumber };
  if (runUrl) ctx.runUrl = runUrl;
  if (baseRef) ctx.baseRef = baseRef;
  return ctx;
}

interface PullRequestEventFields {
  prNumber: number;
  baseRef?: string;
}

function readPullRequestFromEvent(env: NodeJS.ProcessEnv): PullRequestEventFields | null {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(eventPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const pr = obj.pull_request;
  if (pr === null || typeof pr !== "object") {
    // Some events (issue_comment on a PR) carry `issue.pull_request` instead. We only
    // support the `pull_request` event in v1; everything else returns null.
    return null;
  }
  const prRecord = pr as Record<string, unknown>;
  const number = prRecord.number;
  if (typeof number !== "number" || !Number.isFinite(number)) return null;

  let baseRef: string | undefined;
  const base = prRecord.base;
  if (base && typeof base === "object") {
    const baseRecord = base as Record<string, unknown>;
    const ref = baseRecord.ref;
    const sha = baseRecord.sha;
    if (typeof ref === "string" && typeof sha === "string") {
      baseRef = `${ref}@${sha.slice(0, 7)}`;
    } else if (typeof ref === "string") {
      baseRef = ref;
    }
  }
  return { prNumber: number, baseRef };
}

function buildRunUrl(env: NodeJS.ProcessEnv, repo: string): string | undefined {
  const server = env.GITHUB_SERVER_URL;
  const runId = env.GITHUB_RUN_ID;
  if (!server || !runId) return undefined;
  return `${server}/${repo}/actions/runs/${runId}`;
}
