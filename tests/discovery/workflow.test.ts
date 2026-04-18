import { describe, expect, test } from "bun:test";
import { suggestCandidatesForWorkflow } from "../../src/discovery/workflow.js";

describe("suggestCandidatesForWorkflow", () => {
  test("empty inputs produce empty candidates (safe default)", async () => {
    const result = await suggestCandidatesForWorkflow({ cwd: ".", repoRoot: "." });
    expect(result.candidates).toEqual([]);
    expect(result.summaryLines).toEqual([]);
    expect(result.lspUsed).toBe(false);
  });

  test("ranks from changedFiles + query without LSP when querySymbols is omitted", async () => {
    const result = await suggestCandidatesForWorkflow({
      cwd: ".",
      repoRoot: ".",
      query: "login feature",
      changedFiles: ["src/auth/login.ts"],
      candidatePool: ["src/auth/login.ts"],
    });
    expect(result.lspUsed).toBe(false);
    expect(result.candidates[0].path).toBe("src/auth/login.ts");
    expect(result.summaryLines[0]).toContain("src/auth/login.ts");
    expect(result.summaryLines[0]).toContain("score");
    expect(result.summaryLines[0]).toContain("—");
  });

  test("reports lspUsed=true when LSP returns hits", async () => {
    const result = await suggestCandidatesForWorkflow({
      cwd: ".",
      repoRoot: ".",
      query: "login",
      async querySymbols() {
        return [{ path: "src/auth/login.ts", reason: "definition of handleLogin" }];
      },
    });
    expect(result.lspUsed).toBe(true);
    expect(result.candidates[0].path).toBe("src/auth/login.ts");
  });

  test("reports lspUsed=false when LSP throws; falls back to deterministic ranking", async () => {
    const result = await suggestCandidatesForWorkflow({
      cwd: ".",
      repoRoot: ".",
      query: "login",
      changedFiles: ["src/auth/login.ts"],
      async querySymbols() {
        throw new Error("no lsp");
      },
    });
    expect(result.lspUsed).toBe(false);
    expect(result.candidates[0].path).toBe("src/auth/login.ts");
  });

  test("summaryLines cap at 5", async () => {
    const changedFiles = Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`);
    const result = await suggestCandidatesForWorkflow({
      cwd: ".",
      repoRoot: ".",
      changedFiles,
    });
    expect(result.summaryLines.length).toBe(5);
  });
});
