import { describe, expect, test } from "bun:test";
import { rankDiscoveryCandidates } from "../../src/discovery/rank.js";

describe("rankDiscoveryCandidates", () => {
  test("returns empty when no inputs", () => {
    const result = rankDiscoveryCandidates({ cwd: ".", repoRoot: "." });
    expect(result.candidates).toEqual([]);
    expect(result.sourcesUsed).toEqual([]);
  });

  test("ranks changed files first", () => {
    const result = rankDiscoveryCandidates({
      cwd: ".",
      repoRoot: ".",
      changedFiles: ["src/a.ts", "src/b.ts"],
      candidatePool: ["src/a.ts", "src/b.ts", "src/unrelated.ts"],
    });
    expect(result.candidates.map((c) => c.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.candidates[0].rationale).toContain("changed in current context");
  });

  test("adds query-token-match score on top of changed boost", () => {
    const result = rankDiscoveryCandidates({
      cwd: ".",
      repoRoot: ".",
      query: "fix login",
      changedFiles: ["src/auth/login.ts"],
      candidatePool: ["src/auth/login.ts", "src/auth/signup.ts"],
    });
    const paths = result.candidates.map((c) => c.path);
    expect(paths[0]).toBe("src/auth/login.ts");
    const loginCandidate = result.candidates[0];
    expect(loginCandidate.sources).toContain("changed");
    expect(loginCandidate.sources).toContain("query-path-match");
  });

  test("query alone surfaces matching files", () => {
    const result = rankDiscoveryCandidates({
      cwd: ".",
      repoRoot: ".",
      query: "login flow",
      candidatePool: ["src/auth/login.ts", "src/billing.ts"],
    });
    expect(result.candidates.map((c) => c.path)).toEqual(["src/auth/login.ts"]);
    expect(result.candidates[0].rationale[0]).toContain("query token");
  });

  test("short tokens (< 4 chars) are ignored to prevent noise", () => {
    const result = rankDiscoveryCandidates({
      cwd: ".",
      repoRoot: ".",
      query: "fix a",
      candidatePool: ["src/a.ts", "src/architecture.ts"],
    });
    // 'fix' is 3 chars so shouldn't match; 'a' is 1 char so shouldn't match.
    // Neither file has any hit, so result is empty.
    expect(result.candidates).toEqual([]);
  });

  test("external signals contribute score and rationale", () => {
    const result = rankDiscoveryCandidates({
      cwd: ".",
      repoRoot: ".",
      externalSignals: {
        "src/x.ts": { score: 7, rationale: "mentioned in PR comment #42" },
      },
      candidatePool: ["src/x.ts", "src/y.ts"],
    });
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].path).toBe("src/x.ts");
    expect(result.candidates[0].score).toBe(7);
    expect(result.candidates[0].rationale).toContain("mentioned in PR comment #42");
    expect(result.candidates[0].sources).toContain("external-signal");
  });

  test("deterministic tie-break: higher score first, then lex asc on path", () => {
    const result = rankDiscoveryCandidates({
      cwd: ".",
      repoRoot: ".",
      changedFiles: ["src/z.ts", "src/a.ts"],
    });
    expect(result.candidates.map((c) => c.path)).toEqual(["src/a.ts", "src/z.ts"]);
  });

  test("normalizes path separators and leading ./", () => {
    const result = rankDiscoveryCandidates({
      cwd: ".",
      repoRoot: ".",
      changedFiles: ["./src/a.ts", "src\\b.ts"],
      candidatePool: ["src/a.ts", "src/b.ts"],
    });
    const paths = result.candidates.map((c) => c.path);
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("limit caps returned candidates", () => {
    const changedFiles: string[] = [];
    for (let i = 0; i < 50; i++) changedFiles.push(`src/file-${i}.ts`);
    const result = rankDiscoveryCandidates({
      cwd: ".",
      repoRoot: ".",
      changedFiles,
      limit: 5,
    });
    expect(result.candidates.length).toBe(5);
  });

  test("sourcesUsed reflects every scoring source that contributed", () => {
    const result = rankDiscoveryCandidates({
      cwd: ".",
      repoRoot: ".",
      query: "authentication",
      changedFiles: ["src/login.ts"],
      candidatePool: ["src/login.ts", "src/authentication.ts"],
      externalSignals: {
        "src/authentication.ts": { score: 3, rationale: "external" },
      },
    });
    expect(result.sourcesUsed).toContain("changed");
    expect(result.sourcesUsed).toContain("query-path-match");
    expect(result.sourcesUsed).toContain("external-signal");
  });
});
