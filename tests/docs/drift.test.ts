import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Platform, PlatformPaths } from "../../src/platform/types.js";
import type { DriftFinding } from "../../src/types.js";
import {
  buildFixPrompt,
  buildSubAgentPrompt,
  checkDocDrift,
  discoverDocFiles,
  groupDocsByAffinity,
  isProjectDoc,
  loadState,
  saveState,
  statePath,
} from "../../src/docs/drift.js";
import type { DocDriftGroup } from "../../src/docs/drift.js";
import { detectPackageManager } from "../../src/workspace/package-manager.js";
import { discoverWorkspaceTargets } from "../../src/workspace/targets.js";

// ── isProjectDoc ──────────────────────────────────────────────

describe("isProjectDoc", () => {
  test("keeps top-level project docs", () => {
    expect(isProjectDoc("README.md")).toBe(true);
    expect(isProjectDoc("AGENTS.md")).toBe(true);
    expect(isProjectDoc("CLAUDE.md")).toBe(true);
    expect(isProjectDoc("CONTRIBUTING.md")).toBe(true);
    expect(isProjectDoc("CHANGELOG.md")).toBe(true);
  });

  test("keeps docs/ directory files", () => {
    expect(isProjectDoc("docs/setup.md")).toBe(true);
    expect(isProjectDoc("docs/api/reference.md")).toBe(true);
  });

  test("keeps non-agentic paths", () => {
    expect(isProjectDoc("src/ARCHITECTURE.md")).toBe(true);
    expect(isProjectDoc("bin/README.md")).toBe(true);
  });

  test("excludes test/ tests/ __tests__/ directories", () => {
    expect(isProjectDoc("test/AGENTS.md")).toBe(false);
    expect(isProjectDoc("tests/fixtures/sample.md")).toBe(false);
    expect(isProjectDoc("__tests__/helpers/README.md")).toBe(false);
    expect(isProjectDoc("src/__tests__/snapshot.md")).toBe(false);
  });

  test("excludes skills/ segment anywhere in path", () => {
    expect(isProjectDoc("skills/planning/SKILL.md")).toBe(false);
    expect(isProjectDoc("skills/code-review/README.md")).toBe(false);
    expect(isProjectDoc(".omp/skills/omp-extension-dev/SKILL.md")).toBe(false);
    expect(isProjectDoc(".omp/skills/omp-extension-dev/references/api_reference.md")).toBe(false);
  });

  test("excludes commands/ segment anywhere in path", () => {
    expect(isProjectDoc("src/commands/README.md")).toBe(false);
    expect(isProjectDoc("commands/generate.md")).toBe(false);
  });

  test("excludes prompts/ and default-agents/ segments", () => {
    expect(isProjectDoc("src/review/prompts/single-review.md")).toBe(false);
    expect(isProjectDoc("src/review/default-agents/correctness.md")).toBe(false);
  });

  test("excludes SKILL.md and SYSTEM.md filenames anywhere", () => {
    expect(isProjectDoc("some/nested/SKILL.md")).toBe(false);
    expect(isProjectDoc("bin/.omp/SYSTEM.md")).toBe(false);
    // But not files with the word in a different name
    expect(isProjectDoc("docs/skill-guide.md")).toBe(true);
  });
});

// ── Fixtures ──────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-drift-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createPaths(baseDir?: string): PlatformPaths {
  const dir = baseDir ?? tmpDir;
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) =>
      path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) => path.join(dir, ...segments),
    agent: (...segments: string[]) => path.join(dir, ...segments),
  };
}

function createPlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: createPaths(),
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
    ...overrides,
  } as unknown as Platform;
}

function createWorkspaceRepo(): void {
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({
      name: "root-app",
      version: "1.0.0",
      workspaces: ["packages/*"],
    }, null, 2),
  );
  fs.mkdirSync(path.join(tmpDir, "packages", "pkg-a"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "packages", "pkg-b"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "packages", "pkg-a", "package.json"),
    JSON.stringify({ name: "pkg-a", version: "1.0.0" }, null, 2),
  );
  fs.writeFileSync(
    path.join(tmpDir, "packages", "pkg-b", "package.json"),
    JSON.stringify({ name: "pkg-b", version: "1.0.0" }, null, 2),
  );
}

describe("targeted doc drift", () => {
  test("discoverDocFiles filters to the selected workspace target", async () => {
    createWorkspaceRepo();
    const platform = createPlatform({
      exec: mock(async () => ({
        code: 0,
        stdout: [
          "README.md",
          "packages/pkg-a/README.md",
          "packages/pkg-a/docs/setup.md",
          "packages/pkg-b/README.md",
        ].join("\n"),
        stderr: "",
      })),
    } as any);

    const targets = discoverWorkspaceTargets(tmpDir, detectPackageManager(tmpDir));
    const pkgATarget = targets.find((target) => target.name === "pkg-a");
    const rootTarget = targets.find((target) => target.kind === "root");
    expect(pkgATarget).toBeDefined();
    expect(rootTarget).toBeDefined();

    const pkgADocs = await discoverDocFiles(platform, tmpDir, {
      target: pkgATarget!,
      allTargets: targets,
    });
    expect(pkgADocs).toEqual([
      "packages/pkg-a/README.md",
      "packages/pkg-a/docs/setup.md",
    ]);

    const rootDocs = await discoverDocFiles(platform, tmpDir, {
      target: rootTarget!,
      allTargets: targets,
    });
    expect(rootDocs).toEqual(["README.md"]);
  });

  test("checkDocDrift filters changed files to the selected workspace target", async () => {
    createWorkspaceRepo();
    fs.writeFileSync(path.join(tmpDir, "packages", "pkg-a", "README.md"), "# pkg-a");
    const targets = discoverWorkspaceTargets(tmpDir, detectPackageManager(tmpDir));
    const pkgATarget = targets.find((target) => target.name === "pkg-a");
    expect(pkgATarget).toBeDefined();

    saveState(
      createPaths(),
      tmpDir,
      {
        trackedFiles: ["packages/pkg-a/README.md"],
        lastCommit: "abc123",
        lastRunAt: "2026-04-13T00:00:00Z",
      },
      pkgATarget!,
    );

    const session = {
      prompt: mock(async () => {}),
      state: {
        messages: [{ role: "assistant", content: JSON.stringify({ findings: [], status: "ok" }) }],
      },
      dispose: mock(async () => {}),
    };

    const platform = createPlatform({
      exec: mock(async (cmd: string, args: string[]) => {
        if (cmd === "git" && args[0] === "diff") {
          return {
            code: 0,
            stdout: [
              "packages/pkg-a/src/index.ts",
              "packages/pkg-b/src/index.ts",
              "src/root.ts",
            ].join("\n"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
      createAgentSession: mock(async () => session),
    } as any);

    const result = await checkDocDrift(platform, tmpDir, {
      target: pkgATarget!,
      allTargets: targets,
    });

    expect(result).toEqual({ drifted: false, summary: "All documentation is up to date.", findings: [] });
    expect(session.prompt).toHaveBeenCalled();
    const promptCalls = (session.prompt as any).mock.calls as Array<[string]>;
    const prompt = String(promptCalls[0]?.[0] ?? "");
    expect(prompt).toContain("packages/pkg-a/src/index.ts");
    expect(prompt).not.toContain("packages/pkg-b/src/index.ts");
    expect(prompt).not.toContain("src/root.ts");
  });
});

// ── groupDocsByAffinity ──────────────────────────────────────

describe("groupDocsByAffinity", () => {
  test("groups docs/review.md with src/review/runner.ts changes", () => {
    const groups = groupDocsByAffinity(
      ["docs/review.md"],
      ["src/review/runner.ts"],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].docs).toEqual(["docs/review.md"]);
    expect(groups[0].changedFiles).toEqual(["src/review/runner.ts"]);
  });

  test("groups docs/planning.md with src/planning/approval.ts changes", () => {
    const groups = groupDocsByAffinity(
      ["docs/planning.md"],
      ["src/planning/approval.ts"],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].docs).toEqual(["docs/planning.md"]);
    expect(groups[0].changedFiles).toEqual(["src/planning/approval.ts"]);
  });

  test("top-level docs get unmatched changes", () => {
    const groups = groupDocsByAffinity(
      ["README.md", "AGENTS.md"],
      ["src/index.ts"],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].docs).toEqual(["README.md", "AGENTS.md"]);
    expect(groups[0].changedFiles).toEqual(["src/index.ts"]);
  });

  test("empty changedFiles produces groups with empty changedFiles arrays", () => {
    const groups = groupDocsByAffinity(
      ["docs/review.md", "README.md"],
      [],
    );
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.changedFiles).toEqual([]);
    }
  });

  test("single doc file produces single group", () => {
    const groups = groupDocsByAffinity(["docs/setup.md"], ["src/setup/init.ts"]);
    expect(groups).toHaveLength(1);
    expect(groups[0].docs).toEqual(["docs/setup.md"]);
  });

  test("multiple docs with same stem get merged into one group", () => {
    const groups = groupDocsByAffinity(
      ["docs/review.md", "docs/review/advanced.md"],
      ["src/review/runner.ts"],
    );
    // Both docs share the "review" stem
    const reviewGroup = groups.find((g) => g.docs.some((d) => d.includes("review")));
    expect(reviewGroup).toBeDefined();
    expect(reviewGroup!.docs).toContain("docs/review.md");
    expect(reviewGroup!.docs).toContain("docs/review/advanced.md");
    expect(reviewGroup!.changedFiles).toEqual(["src/review/runner.ts"]);
  });

  test("docs/nested/deep.md uses first segment after docs/", () => {
    const groups = groupDocsByAffinity(
      ["docs/nested/deep.md"],
      ["src/nested/foo.ts"],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].docs).toEqual(["docs/nested/deep.md"]);
    expect(groups[0].changedFiles).toEqual(["src/nested/foo.ts"]);
  });

  test("mixed scoped and top-level docs with mixed changes", () => {
    const groups = groupDocsByAffinity(
      ["README.md", "docs/review.md", "docs/planning.md"],
      ["src/review/runner.ts", "src/planning/approval.ts", "src/index.ts"],
    );
    // Should produce: review group, planning group, top-level group
    expect(groups).toHaveLength(3);

    const reviewGroup = groups.find((g) => g.docs.includes("docs/review.md"))!;
    expect(reviewGroup.changedFiles).toContain("src/review/runner.ts");

    const planningGroup = groups.find((g) => g.docs.includes("docs/planning.md"))!;
    expect(planningGroup.changedFiles).toContain("src/planning/approval.ts");

    const topLevel = groups.find((g) => g.docs.includes("README.md"))!;
    expect(topLevel.changedFiles).toContain("src/index.ts");
  });
});

// ── buildSubAgentPrompt ──────────────────────────────────────

describe("buildSubAgentPrompt", () => {
  const group: DocDriftGroup = {
    docs: ["docs/review.md", "docs/planning.md"],
    changedFiles: ["src/review/runner.ts", "src/planning/approval.ts"],
  };

  test("first run prompt includes full documentation audit text", () => {
    const prompt = buildSubAgentPrompt(group, true);
    expect(prompt).toContain("full documentation audit");
  });

  test("subsequent run prompt includes Code Changes to Consider section", () => {
    const prompt = buildSubAgentPrompt(group, false);
    expect(prompt).toContain("Code Changes to Consider");
  });

  test("prompt includes all doc file paths", () => {
    const prompt = buildSubAgentPrompt(group, false);
    expect(prompt).toContain("`docs/review.md`");
    expect(prompt).toContain("`docs/planning.md`");
  });

  test("prompt includes all changed file paths", () => {
    const prompt = buildSubAgentPrompt(group, false);
    expect(prompt).toContain("`src/review/runner.ts`");
    expect(prompt).toContain("`src/planning/approval.ts`");
  });

  test("prompt includes skill://create-readme critical block", () => {
    const prompt = buildSubAgentPrompt(group, false);
    expect(prompt).toContain("skill://create-readme");
  });

  test("prompt includes schema-backed JSON response instructions", () => {
    const prompt = buildSubAgentPrompt(group, false);
    // renderSchemaText output mentions the top-level keys from DocDriftOutputSchema.
    expect(prompt).toContain("findings");
    expect(prompt).toContain("status");
    expect(prompt).toContain("JSON");
    // Severity literals are embedded in the rendered schema.
    expect(prompt).toContain('"info"');
    expect(prompt).toContain('"warning"');
    expect(prompt).toContain('"error"');
  });

  test("first run does not include Code Changes to Consider", () => {
    const prompt = buildSubAgentPrompt(group, true);
    expect(prompt).not.toContain("Code Changes to Consider");
  });
});

// ── checkDocDrift (schema-backed) ──────────────────────────────

describe("checkDocDrift", () => {
  function mockSessionFactory(assistantText: string | string[]) {
    const texts = Array.isArray(assistantText) ? assistantText : [assistantText];
    let call = 0;
    return mock(async () => {
      const text = texts[Math.min(call, texts.length - 1)];
      call += 1;
      return {
        prompt: mock(async () => {}),
        state: {
          messages: [
            { role: "assistant", content: text },
          ],
        },
        dispose: mock(async () => {}),
      } as any;
    });
  }

  function execMock(diffFiles: string[]) {
    return mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "diff" && args[1] === "--name-only") {
        return { code: 0, stdout: diffFiles.join("\n") + "\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: "deadbeef\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
  }

  test("parses valid schema-compliant drift output", async () => {
    const paths = createPaths();
    saveState(paths, tmpDir, {
      trackedFiles: ["README.md"],
      lastCommit: "abc123",
      lastRunAt: "2026-04-01T00:00:00Z",
    });
    const platform = createPlatform({
      exec: execMock(["src/app.ts"]),
      createAgentSession: mockSessionFactory(JSON.stringify({
        findings: [
          { file: "README.md", description: "Outdated example", severity: "warning" },
        ],
        status: "drifted",
      })),
      paths,
    } as any);

    const result = await checkDocDrift(platform, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.drifted).toBe(true);
    expect(result!.findings).toHaveLength(1);
    expect(result!.findings[0].file).toBe("README.md");
    expect(result!.findings[0].severity).toBe("warning");
    expect(result!.errors).toBeUndefined();
  });

  test("preserves relatedFiles from valid output", async () => {
    const paths = createPaths();
    saveState(paths, tmpDir, {
      trackedFiles: ["README.md"],
      lastCommit: "abc123",
      lastRunAt: "2026-04-01T00:00:00Z",
    });
    const platform = createPlatform({
      exec: execMock(["src/app.ts"]),
      createAgentSession: mockSessionFactory(JSON.stringify({
        findings: [
          { file: "README.md", description: "Wrong", severity: "error", relatedFiles: ["src/app.ts"] },
        ],
        status: "drifted",
      })),
      paths,
    } as any);

    const result = await checkDocDrift(platform, tmpDir);
    expect(result!.findings[0].relatedFiles).toEqual(["src/app.ts"]);
  });

  test("invalid schema (unknown severity) blocks after retries — no findings fabricated", async () => {
    const paths = createPaths();
    saveState(paths, tmpDir, {
      trackedFiles: ["README.md"],
      lastCommit: "abc123",
      lastRunAt: "2026-04-01T00:00:00Z",
    });
    const platform = createPlatform({
      exec: execMock(["src/app.ts"]),
      createAgentSession: mockSessionFactory(JSON.stringify({
        findings: [
          { file: "README.md", description: "Something", severity: "bogus" },
        ],
        status: "drifted",
      })),
      paths,
    } as any);

    const result = await checkDocDrift(platform, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.findings).toHaveLength(0);
    expect(result!.drifted).toBe(false);
    expect(result!.errors).toBeDefined();
    expect(result!.errors!.length).toBeGreaterThan(0);
  });

  test("non-JSON output blocks after retries — no heuristic invention", async () => {
    const paths = createPaths();
    saveState(paths, tmpDir, {
      trackedFiles: ["README.md"],
      lastCommit: "abc123",
      lastRunAt: "2026-04-01T00:00:00Z",
    });
    // Previously, text containing "outdated" would have fabricated a drift finding.
    const platform = createPlatform({
      exec: execMock(["src/app.ts"]),
      createAgentSession: mockSessionFactory("This documentation is outdated and missing sections."),
      paths,
    } as any);

    const result = await checkDocDrift(platform, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.findings).toHaveLength(0);
    expect(result!.drifted).toBe(false);
    expect(result!.errors).toBeDefined();
    expect(result!.errors!.length).toBe(1);
  });

  test("skips when no tracked files", async () => {
    const platform = createPlatform();
    const result = await checkDocDrift(platform, tmpDir);
    expect(result).toBeNull();
  });

  test("skips when no code changes since last commit", async () => {
    const paths = createPaths();
    saveState(paths, tmpDir, {
      trackedFiles: ["README.md"],
      lastCommit: "abc123",
      lastRunAt: "2026-04-01T00:00:00Z",
    });
    const platform = createPlatform({
      exec: execMock([]),
      paths,
    } as any);
    const result = await checkDocDrift(platform, tmpDir);
    expect(result).toBeNull();
  });
});


// ── buildFixPrompt ───────────────────────────────────────────

describe("buildFixPrompt", () => {
  const findings: DriftFinding[] = [
    { file: "docs/api.md", description: "Wrong endpoint", severity: "error" },
    { file: "docs/api.md", description: "Missing param docs", severity: "warning" },
    { file: "README.md", description: "Outdated install steps", severity: "info", relatedFiles: ["package.json"] },
  ];

  test("groups findings by file", () => {
    const prompt = buildFixPrompt(findings);
    // docs/api.md header should appear once, with both findings under it
    expect(prompt).toContain("### `docs/api.md`");
    expect(prompt).toContain("### `README.md`");
  });

  test("includes severity tags", () => {
    const prompt = buildFixPrompt(findings);
    expect(prompt).toContain("[error]");
    expect(prompt).toContain("[warning]");
    expect(prompt).toContain("[info]");
  });

  test("includes relatedFiles when present", () => {
    const prompt = buildFixPrompt(findings);
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("Related source");
  });
});

// ── State persistence ────────────────────────────────────────

describe("state persistence", () => {
  test("loadState returns empty state when file does not exist", () => {
    const paths = createPaths();
    const state = loadState(paths, tmpDir);
    expect(state.trackedFiles).toEqual([]);
    expect(state.lastCommit).toBeNull();
    expect(state.lastRunAt).toBeNull();
  });

  test("saveState / loadState round-trip", () => {
    const paths = createPaths();
    const original = {
      trackedFiles: ["README.md", "docs/setup.md"],
      lastCommit: "abc123",
      lastRunAt: "2026-04-13T00:00:00Z",
    };
    saveState(paths, tmpDir, original);
    const loaded = loadState(paths, tmpDir);
    expect(loaded).toEqual(original);
  });

  test("saveState creates directories if needed", () => {
    const paths = createPaths();
    // Should not throw even on a fresh tmpDir
    saveState(paths, tmpDir, {
      trackedFiles: [],
      lastCommit: null,
      lastRunAt: null,
    });
    const loaded = loadState(paths, tmpDir);
    expect(loaded.trackedFiles).toEqual([]);
  });
  test("workspace targets use isolated state files", () => {
    createWorkspaceRepo();
    const paths = createPaths();
    const targets = discoverWorkspaceTargets(tmpDir, detectPackageManager(tmpDir));
    const rootTarget = targets.find((target) => target.kind === "root");
    const pkgATarget = targets.find((target) => target.name === "pkg-a");
    expect(rootTarget).toBeDefined();
    expect(pkgATarget).toBeDefined();

    saveState(paths, tmpDir, {
      trackedFiles: ["README.md"],
      lastCommit: "root123",
      lastRunAt: "2026-04-13T00:00:00Z",
    }, rootTarget!);
    saveState(paths, tmpDir, {
      trackedFiles: ["packages/pkg-a/README.md"],
      lastCommit: "pkg123",
      lastRunAt: "2026-04-14T00:00:00Z",
    }, pkgATarget!);

    expect(statePath(paths, tmpDir, rootTarget!)).not.toBe(statePath(paths, tmpDir, pkgATarget!));
    expect(loadState(paths, tmpDir, { target: rootTarget!, allTargets: targets }).trackedFiles).toEqual(["README.md"]);
    expect(loadState(paths, tmpDir, { target: pkgATarget!, allTargets: targets }).trackedFiles).toEqual(["packages/pkg-a/README.md"]);
  });

});
