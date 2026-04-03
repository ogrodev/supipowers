import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { discoverCommitConventions } from "../../src/git/conventions.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-conv-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mockExec(stdout = "", code = 0) {
  return mock().mockResolvedValue({ stdout, code });
}

function writeFile(relativePath: string, content: string) {
  const full = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("discoverCommitConventions", () => {
  test("returns empty when no convention files exist", async () => {
    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.guidelines).toBe("");
    expect(result.sources).toEqual([]);
  });

  test("extracts commit sections from CONTRIBUTING.md", async () => {
    writeFile(
      "CONTRIBUTING.md",
      [
        "# Contributing",
        "",
        "## Getting Started",
        "Install deps.",
        "",
        "## Commit Message Format",
        "We use conventional commits.",
        "Type must be one of: feat, fix, chore.",
        "",
        "## Code Style",
        "Use prettier.",
      ].join("\n"),
    );

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).toContain("CONTRIBUTING.md");
    expect(result.guidelines).toContain("Commit Message Format");
    expect(result.guidelines).toContain("conventional commits");
    // Should NOT include unrelated sections
    expect(result.guidelines).not.toContain("Getting Started");
    expect(result.guidelines).not.toContain("Code Style");
  });

  test("reads COMMIT.md in full when present", async () => {
    writeFile("COMMIT.md", "All commits must follow angular format.\nfeat: new feature");

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).toContain("COMMIT.md");
    expect(result.guidelines).toContain("angular format");
  });

  test("reads COMMIT_CONVENTIONS.md in full", async () => {
    writeFile("COMMIT_CONVENTIONS.md", "Use type(scope): description");

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).toContain("COMMIT_CONVENTIONS.md");
    expect(result.guidelines).toContain("type(scope)");
  });

  test("parses .commitlintrc.json", async () => {
    writeFile(
      ".commitlintrc.json",
      JSON.stringify({ extends: ["@commitlint/config-conventional"] }),
    );

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).toContain(".commitlintrc.json");
    expect(result.guidelines).toContain("config-conventional");
  });

  test("reads package.json commitlint config", async () => {
    writeFile(
      "package.json",
      JSON.stringify({
        name: "test",
        commitlint: { extends: ["@commitlint/config-conventional"] },
      }),
    );

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).toContain("package.json");
    expect(result.guidelines).toContain("commitlint");
  });

  test("reads package.json commitizen config", async () => {
    writeFile(
      "package.json",
      JSON.stringify({
        name: "test",
        config: { commitizen: { path: "cz-conventional-changelog" } },
      }),
    );

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).toContain("package.json");
    expect(result.guidelines).toContain("cz-conventional-changelog");
  });

  test("skips package.json when no relevant fields", async () => {
    writeFile("package.json", JSON.stringify({ name: "test", version: "1.0.0" }));

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).not.toContain("package.json");
  });

  test("reads .husky/commit-msg hook", async () => {
    writeFile(".husky/commit-msg", '#!/bin/sh\nnpx commitlint --edit "$1"');

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).toEqual(
      expect.arrayContaining([expect.stringContaining("commit-msg")]),
    );
    expect(result.guidelines).toContain("commitlint");
  });

  test("reads git commit.template when configured", async () => {
    writeFile(".gitmessage", "feat: \n\nWhy:\n\n");
    const exec = mockExec(".gitmessage\n", 0);

    const result = await discoverCommitConventions(exec, tmpDir);
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["config", "commit.template"],
      { cwd: tmpDir },
    );
    expect(result.sources).toEqual(
      expect.arrayContaining([expect.stringContaining("commit.template")]),
    );
    expect(result.guidelines).toContain("feat:");
  });

  test("handles git config returning non-zero (no template)", async () => {
    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    // Should not fail
    expect(result.guidelines).toBe("");
  });

  test("truncates to ~4KB when conventions are very large", async () => {
    // Create a large COMMIT.md
    const bigContent = "x".repeat(5000);
    writeFile("COMMIT.md", bigContent);

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).toContain("COMMIT.md");
    // Guidelines should be capped
    expect(Buffer.byteLength(result.guidelines, "utf8")).toBeLessThanOrEqual(
      4096 + 20, // allow for "[truncated]" suffix
    );
  });

  test("truncation drops later sections first", async () => {
    // First source: large but within budget
    writeFile("COMMIT.md", "A".repeat(3000));
    // Second source: pushes over
    writeFile(
      ".commitlintrc.json",
      JSON.stringify({ rule: "B".repeat(3000) }),
    );

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    // COMMIT.md should survive; .commitlintrc.json should be dropped
    expect(result.sources).toContain("COMMIT.md");
    expect(result.sources).not.toContain(".commitlintrc.json");
  });

  test("handles unreadable files gracefully", async () => {
    // Create a directory where a file is expected — readFileSync will throw
    fs.mkdirSync(path.join(tmpDir, "CONTRIBUTING.md"), { recursive: true });

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    // Should not throw, just skip
    expect(result.sources).not.toContain("CONTRIBUTING.md");
  });

  test("reads .czrc commitizen config", async () => {
    writeFile(".czrc", JSON.stringify({ path: "cz-emoji" }));

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).toContain(".czrc");
    expect(result.guidelines).toContain("cz-emoji");
  });

  test("combines multiple sources with labeled sections", async () => {
    writeFile("COMMIT.md", "Use conventional commits.");
    writeFile(".czrc", JSON.stringify({ path: "cz-conventional-changelog" }));

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).toEqual(
      expect.arrayContaining(["COMMIT.md", ".czrc"]),
    );
    // Each source gets a ### heading
    expect(result.guidelines).toContain("### COMMIT.md");
    expect(result.guidelines).toContain("### .czrc");
  });

  test("extracts sections from AGENTS.md mentioning conventions", async () => {
    writeFile(
      "AGENTS.md",
      [
        "# Agent Guide",
        "",
        "## Conventional Commit Rules",
        "Always use type: description format.",
        "",
        "## Other Stuff",
        "Unrelated content.",
      ].join("\n"),
    );

    const result = await discoverCommitConventions(mockExec("", 1), tmpDir);
    expect(result.sources).toContain("AGENTS.md");
    expect(result.guidelines).toContain("type: description format");
    expect(result.guidelines).not.toContain("Unrelated content");
  });
});
