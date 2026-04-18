import { describe, expect, test } from "bun:test";
import { rankWithLspAugmentation } from "../../src/discovery/lsp.js";

describe("rankWithLspAugmentation", () => {
  test("includes LSP hits as external signals with rationale", async () => {
    const result = await rankWithLspAugmentation({
      cwd: ".",
      repoRoot: ".",
      query: "login",
      candidatePool: ["src/a.ts"],
      async querySymbols(query) {
        expect(query).toBe("login");
        return [
          { path: "src/auth/login.ts", reason: "symbol `handleLogin` defined here" },
        ];
      },
    });

    expect(result.lspAvailable).toBe(true);
    expect(result.lspHitCount).toBe(1);
    expect(result.candidates.map((c) => c.path)).toContain("src/auth/login.ts");
    const lspCandidate = result.candidates.find((c) => c.path === "src/auth/login.ts");
    expect(lspCandidate?.rationale.join(" ")).toContain("handleLogin");
    expect(lspCandidate?.sources).toContain("external-signal");
  });

  test("gracefully falls back when querySymbols throws", async () => {
    const result = await rankWithLspAugmentation({
      cwd: ".",
      repoRoot: ".",
      query: "login",
      changedFiles: ["src/auth/login.ts"],
      async querySymbols() {
        throw new Error("LSP not running");
      },
    });

    expect(result.lspAvailable).toBe(false);
    expect(result.lspHitCount).toBe(0);
    // Ranking still works from changedFiles.
    expect(result.candidates.map((c) => c.path)).toEqual(["src/auth/login.ts"]);
  });

  test("empty query skips LSP entirely (no side effects)", async () => {
    let called = false;
    const result = await rankWithLspAugmentation({
      cwd: ".",
      repoRoot: ".",
      changedFiles: ["src/x.ts"],
      async querySymbols() {
        called = true;
        return [];
      },
    });
    expect(called).toBe(false);
    expect(result.lspAvailable).toBe(true);
    expect(result.candidates.length).toBe(1);
  });

  test("LSP + changed stacks score on the same path", async () => {
    const result = await rankWithLspAugmentation({
      cwd: ".",
      repoRoot: ".",
      query: "login",
      changedFiles: ["src/auth/login.ts"],
      candidatePool: ["src/auth/login.ts"],
      async querySymbols() {
        return [{ path: "src/auth/login.ts", reason: "symbol match" }];
      },
    });
    const c = result.candidates[0];
    expect(c.sources).toContain("changed");
    expect(c.sources).toContain("external-signal");
    expect(c.score).toBeGreaterThanOrEqual(10 /* changed */ + 6 /* lsp */);
  });

  test("merges pre-existing externalSignals with LSP hits", async () => {
    const result = await rankWithLspAugmentation({
      cwd: ".",
      repoRoot: ".",
      query: "login",
      externalSignals: {
        "src/auth/login.ts": { score: 3, rationale: "mentioned in PR comment" },
      },
      async querySymbols() {
        return [{ path: "src/auth/login.ts", reason: "symbol match" }];
      },
    });
    const c = result.candidates[0];
    expect(c.path).toBe("src/auth/login.ts");
    expect(c.rationale.join("; ")).toContain("mentioned in PR comment");
    expect(c.rationale.join("; ")).toContain("symbol match");
  });
});
