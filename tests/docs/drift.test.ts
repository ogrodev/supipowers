import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatformPaths } from "../../src/platform/types.js";
import type { DriftFinding } from "../../src/types.js";
import {
  buildFixPrompt,
  buildSubAgentPrompt,
  groupDocsByAffinity,
  isProjectDoc,
  loadState,
  parseDriftFindings,
  saveState,
} from "../../src/docs/drift.js";
import type { DocDriftGroup } from "../../src/docs/drift.js";

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

  test("prompt includes JSON response format instructions", () => {
    const prompt = buildSubAgentPrompt(group, false);
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"status"');
    expect(prompt).toContain("JSON");
  });

  test("first run does not include Code Changes to Consider", () => {
    const prompt = buildSubAgentPrompt(group, true);
    expect(prompt).not.toContain("Code Changes to Consider");
  });
});

// ── parseDriftFindings ───────────────────────────────────────

describe("parseDriftFindings", () => {
  test("valid JSON with findings returns structured findings", () => {
    const input = JSON.stringify({
      findings: [
        { file: "README.md", description: "Missing setup section", severity: "warning" },
      ],
      status: "drifted",
    });
    const result = parseDriftFindings(input);
    expect(result.status).toBe("drifted");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe("README.md");
    expect(result.findings[0].description).toBe("Missing setup section");
    expect(result.findings[0].severity).toBe("warning");
  });

  test("valid JSON with status ok and empty findings", () => {
    const input = JSON.stringify({ findings: [], status: "ok" });
    const result = parseDriftFindings(input);
    expect(result.status).toBe("ok");
    expect(result.findings).toHaveLength(0);
  });

  test("JSON wrapped in markdown code fences", () => {
    const input = [
      "```json",
      JSON.stringify({
        findings: [
          { file: "docs/setup.md", description: "Outdated example", severity: "error" },
        ],
        status: "drifted",
      }),
      "```",
    ].join("\n");
    const result = parseDriftFindings(input);
    expect(result.status).toBe("drifted");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("error");
  });

  test("invalid JSON falls back to heuristic", () => {
    const input = "This documentation is outdated and needs updating.";
    const result = parseDriftFindings(input);
    // "outdated" triggers fallback
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe("unknown");
    expect(result.findings[0].severity).toBe("warning");
  });

  test("text mentioning missing produces fallback finding", () => {
    const input = "There are missing sections in the documentation.";
    const result = parseDriftFindings(input);
    expect(result.findings).toHaveLength(1);
    expect(result.status).toBe("drifted");
  });

  test("text with no drift indicators returns empty findings", () => {
    const input = "Everything looks great, no issues found.";
    const result = parseDriftFindings(input);
    expect(result.findings).toHaveLength(0);
    expect(result.status).toBe("ok");
  });

  test("findings with missing severity default to info", () => {
    const input = JSON.stringify({
      findings: [
        { file: "README.md", description: "Minor note", severity: "unknown" },
      ],
      status: "drifted",
    });
    const result = parseDriftFindings(input);
    expect(result.findings[0].severity).toBe("info");
  });

  test("findings with relatedFiles are preserved", () => {
    const input = JSON.stringify({
      findings: [
        {
          file: "docs/api.md",
          description: "API changed",
          severity: "warning",
          relatedFiles: ["src/api/handler.ts", "src/api/routes.ts"],
        },
      ],
      status: "drifted",
    });
    const result = parseDriftFindings(input);
    expect(result.findings[0].relatedFiles).toEqual([
      "src/api/handler.ts",
      "src/api/routes.ts",
    ]);
  });

  test("malformed findings entries are filtered out", () => {
    const input = JSON.stringify({
      findings: [
        { file: "valid.md", description: "Valid finding", severity: "info" },
        { description: "No file field" },
        { file: "no-desc.md" },
        "not an object",
      ],
      status: "drifted",
    });
    const result = parseDriftFindings(input);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe("valid.md");
  });

  test("findings without relatedFiles omit the field", () => {
    const input = JSON.stringify({
      findings: [
        { file: "README.md", description: "Something", severity: "info" },
      ],
      status: "ok",
    });
    const result = parseDriftFindings(input);
    expect(result.findings[0]).not.toHaveProperty("relatedFiles");
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
});
