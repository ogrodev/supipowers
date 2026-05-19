import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { applyHarnessPlan } from "../../../src/harness/stages/implement-apply.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { Platform } from "../../../src/platform/types.js";
import type { HarnessDesignSpec } from "../../../src/types.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-apply-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSpec(overrides: Partial<HarnessDesignSpec> = {}): HarnessDesignSpec {
  return {
    sessionId: "harness-apply-1",
    recordedAt: "2026-05-12T12:00:00.000Z",
    layerRules: [
      { layer: "lib", globs: ["src/lib/**"], allowedImports: [], forbiddenImports: [] },
      { layer: "app", globs: ["src/app/**"], allowedImports: ["lib"], forbiddenImports: [] },
    ],
    tasteInvariants: ["No emojis in source"],
    tooling: { lint: "eslint", structuralTest: null, eval: null },
    goldenPrinciples: ["No `as any` casts", "Every async fn handles its rejection path"],
    docsTree: ["docs/architecture.md", "docs/golden-principles.md"],
    validationGates: [],
    ci: {
      provider: "github-actions",
      trigger: { mode: "branches", branches: ["dev", "main"] },
      localCommand: "bun run harness:quality",
      workflowPath: ".github/workflows/harness-quality.yml",
    },
    supipowersWiring: { addReviewAgent: true, wireChecksGate: true },
    antiSlop: {
      backend: "fallow",
      hooks: {
        pre_edit_dupe_probe: { enabled: true, threshold: 0.85, min_token_count: 30 },
        post_session_sweep: { enabled: true, block_on_new_dead_code: false },
        layer_context_inject: { enabled: true, addendum_max_chars: 800 },
        score_floor: { strict: 75, lenient: 90, release_blocking: false },
      },
      skillTargets: [],
    },
    ...overrides,
  };
}

function makePlatform(): Platform {
  return { paths } as unknown as Platform;
}

describe("applyHarnessPlan — happy path", () => {
  test("writes every Tier 1 artifact from the design spec", async () => {
    const outcome = await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec(),
    });

    expect(outcome.errors).toEqual([]);
    expect(fs.existsSync(path.join(cwd, "docs", "architecture.md"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "docs", "golden-principles.md"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "eslint.config.js"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".github", "workflows", "harness-quality.yml"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".fallowrc.json"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".omp", "supipowers", "harness", "marker.json"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".omp", "supipowers", "harness", "score.json"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".omp", "supipowers", "harness", "checks-wiring.json"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".omp", "supipowers", "review-agents", "harness-architecture.md"))).toBe(true);
  });

  test("re-running over an applied repo reports skips with no diff", async () => {
    const platform = makePlatform();
    const spec = makeSpec();
    await applyHarnessPlan({ platform, paths, cwd, spec });

    const architectureMd = fs.readFileSync(path.join(cwd, "docs", "architecture.md"));
    const agentsMd = fs.readFileSync(path.join(cwd, "AGENTS.md"));
    const markerBefore = fs.readFileSync(path.join(cwd, ".omp", "supipowers", "harness", "marker.json"));

    const outcome = await applyHarnessPlan({ platform, paths, cwd, spec });

    expect(outcome.errors).toEqual([]);
    const wroteEntries = outcome.applied.filter((entry) => entry.action === "wrote" || entry.action === "patched");
    expect(wroteEntries.map((entry) => entry.step)).toEqual([]);

    // Byte-exact: nothing changed on disk.
    expect(fs.readFileSync(path.join(cwd, "docs", "architecture.md")).equals(architectureMd)).toBe(true);
    expect(fs.readFileSync(path.join(cwd, "AGENTS.md")).equals(agentsMd)).toBe(true);
    expect(fs.readFileSync(path.join(cwd, ".omp", "supipowers", "harness", "marker.json")).equals(markerBefore)).toBe(
      true,
    );
  });
});

describe("applyHarnessPlan — conditional appliers", () => {
  test("skips lint config when no tool is configured", async () => {
    const outcome = await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec({ tooling: { lint: null, structuralTest: null, eval: null } }),
    });
    expect(outcome.errors).toEqual([]);
    expect(fs.existsSync(path.join(cwd, "eslint.config.js"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, "biome.json"))).toBe(false);
  });

  test("skips review agent when addReviewAgent=false", async () => {
    const outcome = await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec({ supipowersWiring: { addReviewAgent: false, wireChecksGate: false } }),
    });
    expect(outcome.errors).toEqual([]);
    expect(fs.existsSync(path.join(cwd, ".omp", "supipowers", "review-agents", "harness-architecture.md"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".omp", "supipowers", "harness", "checks-wiring.json"))).toBe(false);
  });

  test("desloppify backend appends .desloppify/ to .gitignore", async () => {
    fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
    const outcome = await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec({
        antiSlop: {
          ...makeSpec().antiSlop,
          backend: "desloppify",
        },
      }),
    });
    expect(outcome.errors).toEqual([]);
    expect(fs.existsSync(path.join(cwd, ".fallowrc.json"))).toBe(false);
    expect(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8")).toContain(".desloppify/");
  });

  test("hybrid backend installs both fallow + desloppify side effects", async () => {
    fs.writeFileSync(path.join(cwd, ".gitignore"), "");
    const outcome = await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec({
        antiSlop: { ...makeSpec().antiSlop, backend: "hybrid" },
      }),
    });
    expect(outcome.errors).toEqual([]);
    expect(fs.existsSync(path.join(cwd, ".fallowrc.json"))).toBe(true);
    expect(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8")).toContain(".desloppify/");
  });

  test("supi-native backend writes no installer-side artifacts", async () => {
    const outcome = await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec({
        antiSlop: { ...makeSpec().antiSlop, backend: "supi-native" },
      }),
    });
    expect(outcome.errors).toEqual([]);
    expect(fs.existsSync(path.join(cwd, ".fallowrc.json"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".gitignore"))).toBe(false);
  });
});

describe("applyHarnessPlan — failure handling", () => {
  test("dry-run reports actions without writing", async () => {
    const outcome = await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec(),
      apply: false,
    });
    expect(outcome.errors).toEqual([]);
    expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, "docs", "architecture.md"))).toBe(false);
    // Every applier should have reported a `noop` for the would-write.
    const noops = outcome.applied.filter((entry) => entry.action === "noop");
    expect(noops.length).toBeGreaterThan(0);
  });

  test("warns when local quality command is not a package script", async () => {
    const outcome = await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec({
        ci: {
          provider: "github-actions",
          trigger: { mode: "branches", branches: ["main"] },
          localCommand: "./scripts/quality.sh",
          workflowPath: ".github/workflows/harness-quality.yml",
        },
      }),
    });
    expect(outcome.warnings.some((w) => w.includes("Wire local harness quality command"))).toBe(true);
    // Workflow + everything else still applies.
    expect(fs.existsSync(path.join(cwd, ".github", "workflows", "harness-quality.yml"))).toBe(true);
  });

  test("patches existing package.json script without losing other scripts", async () => {
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "bun test" } }, null, 2),
    );
    await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec(),
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    expect(pkg.scripts.test).toBe("bun test");
    expect(typeof pkg.scripts["harness:quality"]).toBe("string");
    expect(pkg.scripts["harness:quality"]).toContain("eslint");
  });
});

describe("applyHarnessPlan — git verification wiring", () => {
  test("renders verify-pr-source job when enforceMainFromDevOnly is true", async () => {
    await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec({
        ci: {
          provider: "github-actions",
          trigger: { mode: "branches", branches: ["dev", "main"] },
          localCommand: "bun run harness:quality",
          workflowPath: ".github/workflows/harness-quality.yml",
          git: {
            mainBranch: "main",
            devBranch: "dev",
            enforceMainFromDevOnly: true,
            verification: null,
          },
        },
      }),
    });
    const workflow = fs.readFileSync(
      path.join(cwd, ".github", "workflows", "harness-quality.yml"),
      "utf8",
    );
    expect(workflow).toContain("verify-pr-source");
    expect(workflow).toContain("pull_request.base.ref");
    expect(workflow).toContain("'main'");
    expect(workflow).toContain("'dev'");
    expect(workflow).toContain("shell: bash");
  });

  test("omits verify-pr-source job when git block is absent", async () => {
    await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec(), // no git block in default spec
    });
    const workflow = fs.readFileSync(
      path.join(cwd, ".github", "workflows", "harness-quality.yml"),
      "utf8",
    );
    expect(workflow).not.toContain("verify-pr-source");
  });

  test("omits verify-pr-source job when enforceMainFromDevOnly is false", async () => {
    await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec({
        ci: {
          provider: "github-actions",
          trigger: { mode: "branches", branches: ["dev", "main"] },
          localCommand: "bun run harness:quality",
          workflowPath: ".github/workflows/harness-quality.yml",
          git: {
            mainBranch: "main",
            devBranch: "dev",
            enforceMainFromDevOnly: false,
            verification: null,
          },
        },
      }),
    });
    const workflow = fs.readFileSync(
      path.join(cwd, ".github", "workflows", "harness-quality.yml"),
      "utf8",
    );
    expect(workflow).not.toContain("verify-pr-source");
  });

  test("widens trigger.branches to include mainBranch even when the spec omits it", async () => {
    // Defense-in-depth: a hand-edited or legacy spec where `trigger.branches` lacks the
    // protected `mainBranch` would otherwise render a workflow that never fires on PRs
    // into main — making the `verify-pr-source` job dead code. The render pass must
    // widen the branches set whenever the guardrail is on.
    await applyHarnessPlan({
      platform: makePlatform(),
      paths,
      cwd,
      spec: makeSpec({
        ci: {
          provider: "github-actions",
          // Spec says branches=["dev"] but mainBranch="main" — render must add "main".
          trigger: { mode: "branches", branches: ["dev"] },
          localCommand: "bun run harness:quality",
          workflowPath: ".github/workflows/harness-quality.yml",
          git: {
            mainBranch: "main",
            devBranch: "dev",
            enforceMainFromDevOnly: true,
            verification: null,
          },
        },
      }),
    });
    const workflow = fs.readFileSync(
      path.join(cwd, ".github", "workflows", "harness-quality.yml"),
      "utf8",
    );
    expect(workflow).toContain("verify-pr-source");
    // The trigger's `branches: [...]` line must mention both 'dev' and 'main'.
    const branchesLine = workflow.split("\n").find((l) => /^\s+branches:/.test(l));
    expect(branchesLine).toBeDefined();
    expect(branchesLine).toContain("'dev'");
    expect(branchesLine).toContain("'main'");
  });
});
