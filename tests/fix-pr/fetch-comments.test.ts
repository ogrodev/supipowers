import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fetchPrComments } from "../../src/fix-pr/fetch-comments.js";

function makePlatform(execResults: Record<string, { stdout: string; stderr: string; code: number }>) {
  return {
    exec: mock((cmd: string, args: string[]) => {
      // Match on the API endpoint to return the right result
      const endpoint = args.find((a) => a.startsWith("repos/"));
      if (endpoint?.includes("/comments")) return Promise.resolve(execResults.comments);
      if (endpoint?.includes("/reviews")) return Promise.resolve(execResults.reviews);
      return Promise.resolve({ stdout: "", stderr: "unknown endpoint", code: 1, killed: false });
    }),
  } as any;
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
      comments: { stdout: inlineComment + "\n", stderr: "", code: 0 },
      reviews: { stdout: reviewComment + "\n", stderr: "", code: 0 },
    });

    const outputPath = path.join(tmpDir, "snapshots", "comments-0.jsonl");
    const error = await fetchPrComments(platform, "owner/repo", 42, outputPath, tmpDir);

    expect(error).toBeUndefined();
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toBe(inlineComment + "\n" + reviewComment + "\n");
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
      comments: { stdout: comment + "\n", stderr: "", code: 0 },
      reviews: { stdout: "", stderr: "not found", code: 1 },
    });

    const outputPath = path.join(tmpDir, "comments.jsonl");
    const error = await fetchPrComments(platform, "owner/repo", 1, outputPath, tmpDir);

    expect(error).toBeUndefined();
    expect(fs.readFileSync(outputPath, "utf-8")).toBe(comment + "\n");
  });

  test("writes empty file when inline fetch fails", async () => {
    const review = JSON.stringify({ id: 2, body: "review" });
    const platform = makePlatform({
      comments: { stdout: "", stderr: "error", code: 1 },
      reviews: { stdout: review + "\n", stderr: "", code: 0 },
    });

    const outputPath = path.join(tmpDir, "comments.jsonl");
    const error = await fetchPrComments(platform, "owner/repo", 1, outputPath, tmpDir);

    expect(error).toBeUndefined();
    // Inline failed → empty write, then review appended
    expect(fs.readFileSync(outputPath, "utf-8")).toBe(review + "\n");
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
});
