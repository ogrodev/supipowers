import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clusterPrCommentsByTarget,
  fetchPrComments,
  stringifyPrCommentsJsonl,
} from "../../src/fix-pr/fetch-comments.js";
import type { PrComment } from "../../src/fix-pr/types.js";
import { discoverWorkspaceTargets } from "../../src/workspace/targets.js";

function makePlatform(execResults: Record<string, { stdout: string; stderr: string; code: number }>) {
  return {
    exec: mock((cmd: string, args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith("repos/"));
      if (endpoint?.includes("/comments")) return Promise.resolve(execResults.comments);
      if (endpoint?.includes("/reviews")) return Promise.resolve(execResults.reviews);
      return Promise.resolve({ stdout: "", stderr: "unknown endpoint", code: 1, killed: false });
    }),
  } as any;
}

function makeComment(overrides: Partial<PrComment> = {}): PrComment {
  return {
    id: overrides.id ?? 1,
    path: overrides.path === undefined ? "src/index.ts" : overrides.path,
    line: overrides.line ?? 1,
    body: overrides.body ?? "fix this",
    user: overrides.user ?? "reviewer",
    createdAt: overrides.createdAt ?? "2026-04-16T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-04-16T00:00:00Z",
    inReplyToId: overrides.inReplyToId ?? null,
    diffHunk: overrides.diffHunk ?? null,
    state: overrides.state ?? "COMMENTED",
    userType: overrides.userType ?? "User",
  };
}

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2));
}

function createWorkspaceRepo(baseDir: string): string {
  const repoRoot = path.join(baseDir, "repo");
  writeManifest(repoRoot, {
    name: "repo-root",
    version: "1.0.0",
    private: true,
    workspaces: ["packages/*"],
  });
  writeManifest(path.join(repoRoot, "packages", "pkg-a"), {
    name: "pkg-a",
    version: "1.0.0",
  });
  writeManifest(path.join(repoRoot, "packages", "pkg-b"), {
    name: "pkg-b",
    version: "1.0.0",
  });
  return repoRoot;
}

function createSinglePackageRepo(baseDir: string): string {
  const repoRoot = path.join(baseDir, "single-repo");
  writeManifest(repoRoot, {
    name: "single-repo",
    version: "1.0.0",
    private: true,
  });
  return repoRoot;
}

describe("fetchPrComments", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-fetch-comments-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes inline and review comments as JSONL", async () => {
    const inlineComment = JSON.stringify({ id: 1, body: "fix this", state: "COMMENTED" });
    const reviewComment = JSON.stringify({ id: 2, body: "looks good", state: "APPROVED" });

    const platform = makePlatform({
      comments: { stdout: `${inlineComment}\n`, stderr: "", code: 0 },
      reviews: { stdout: `${reviewComment}\n`, stderr: "", code: 0 },
    });

    const outputPath = path.join(tmpDir, "snapshots", "comments-0.jsonl");
    const error = await fetchPrComments(platform, "owner/repo", 42, outputPath, tmpDir);

    expect(error).toBeUndefined();
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toBe(`${inlineComment}\n${reviewComment}\n`);
  });

  test("creates output directory recursively", async () => {
    const platform = makePlatform({
      comments: { stdout: "", stderr: "", code: 0 },
      reviews: { stdout: "", stderr: "", code: 0 },
    });

    const outputPath = path.join(tmpDir, "deep", "nested", "dir", "comments.jsonl");
    await fetchPrComments(platform, "owner/repo", 1, outputPath, tmpDir);

    expect(fs.existsSync(path.dirname(outputPath))).toBe(true);
  });

  test("returns undefined when both calls succeed with empty results", async () => {
    const platform = makePlatform({
      comments: { stdout: "", stderr: "", code: 0 },
      reviews: { stdout: "", stderr: "", code: 0 },
    });

    const outputPath = path.join(tmpDir, "comments.jsonl");
    const error = await fetchPrComments(platform, "owner/repo", 1, outputPath, tmpDir);

    expect(error).toBeUndefined();
    expect(fs.readFileSync(outputPath, "utf-8")).toBe("");
  });

  test("returns error when both gh api calls fail", async () => {
    const platform = makePlatform({
      comments: { stdout: "", stderr: "auth required", code: 1 },
      reviews: { stdout: "", stderr: "auth required", code: 1 },
    });

    const outputPath = path.join(tmpDir, "comments.jsonl");
    const error = await fetchPrComments(platform, "owner/repo", 1, outputPath, tmpDir);

    expect(error).toBe("auth required");
  });

  test("succeeds with partial data when one call fails", async () => {
    const comment = JSON.stringify({ id: 1, body: "inline" });
    const platform = makePlatform({
      comments: { stdout: `${comment}\n`, stderr: "", code: 0 },
      reviews: { stdout: "", stderr: "not found", code: 1 },
    });

    const outputPath = path.join(tmpDir, "comments.jsonl");
    const error = await fetchPrComments(platform, "owner/repo", 1, outputPath, tmpDir);

    expect(error).toBeUndefined();
    expect(fs.readFileSync(outputPath, "utf-8")).toBe(`${comment}\n`);
  });

  test("writes empty file when inline fetch fails", async () => {
    const review = JSON.stringify({ id: 2, body: "review" });
    const platform = makePlatform({
      comments: { stdout: "", stderr: "error", code: 1 },
      reviews: { stdout: `${review}\n`, stderr: "", code: 0 },
    });

    const outputPath = path.join(tmpDir, "comments.jsonl");
    const error = await fetchPrComments(platform, "owner/repo", 1, outputPath, tmpDir);

    expect(error).toBeUndefined();
    expect(fs.readFileSync(outputPath, "utf-8")).toBe(`${review}\n`);
  });

  test("calls gh api with correct arguments", async () => {
    const platform = makePlatform({
      comments: { stdout: "", stderr: "", code: 0 },
      reviews: { stdout: "", stderr: "", code: 0 },
    });

    const outputPath = path.join(tmpDir, "comments.jsonl");
    await fetchPrComments(platform, "octocat/hello", 99, outputPath, "/work");

    expect(platform.exec).toHaveBeenCalledTimes(2);

    const [call1, call2] = platform.exec.mock.calls;
    expect(call1[0]).toBe("gh");
    expect(call1[1]).toContain("repos/octocat/hello/pulls/99/comments");
    expect(call1[2]).toEqual({ cwd: "/work" });

    expect(call2[0]).toBe("gh");
    expect(call2[1]).toContain("repos/octocat/hello/pulls/99/reviews");
    expect(call2[2]).toEqual({ cwd: "/work" });
  });

  test("clusters comments by workspace target and keeps root comments visible", () => {
    const repoRoot = createWorkspaceRepo(tmpDir);
    const targets = discoverWorkspaceTargets(repoRoot, "bun");
    const clustered = clusterPrCommentsByTarget(targets, [
      makeComment({ id: 1, path: "packages/pkg-a/src/index.ts" }),
      makeComment({ id: 2, path: "packages/pkg-b/src/index.ts" }),
      makeComment({ id: 3, path: "README.md" }),
      makeComment({ id: 4, path: null, line: null }),
    ]);

    expect(clustered.commentsByTargetId.get("pkg-a")?.map((comment) => comment.id)).toEqual([1]);
    expect(clustered.commentsByTargetId.get("pkg-b")?.map((comment) => comment.id)).toEqual([2]);
    expect(clustered.commentsByTargetId.get("repo-root")?.map((comment) => comment.id)).toEqual([3, 4]);
    expect(clustered.unscopedComments.map((comment) => comment.id)).toEqual([4]);
  });

  test("selected package serialization excludes sibling package and root comments", () => {
    const repoRoot = createWorkspaceRepo(tmpDir);
    const targets = discoverWorkspaceTargets(repoRoot, "bun");
    const clustered = clusterPrCommentsByTarget(targets, [
      makeComment({ id: 1, path: "packages/pkg-a/src/index.ts" }),
      makeComment({ id: 2, path: "packages/pkg-b/src/index.ts" }),
      makeComment({ id: 3, path: null, line: null }),
    ]);

    const packageCommentsJsonl = stringifyPrCommentsJsonl(clustered.commentsByTargetId.get("pkg-a") ?? []);
    expect(packageCommentsJsonl).toContain('"id":1');
    expect(packageCommentsJsonl).not.toContain('"id":2');
    expect(packageCommentsJsonl).not.toContain('"id":3');
  });

  test("single-package repos keep fileless review comments actionable at root", () => {
    const repoRoot = createSinglePackageRepo(tmpDir);
    const targets = discoverWorkspaceTargets(repoRoot, "bun");
    const clustered = clusterPrCommentsByTarget(targets, [
      makeComment({ id: 1, path: "src/index.ts" }),
      makeComment({ id: 2, path: null, line: null }),
    ]);

    expect(targets).toHaveLength(1);
    expect(clustered.commentsByTargetId.get("single-repo")?.map((comment) => comment.id)).toEqual([1, 2]);
  });
});
