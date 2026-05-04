import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildHarnessPlanTasks,
  emitHarnessPlanFromSpec,
  renderHarnessPlanMarkdown,
  validateHarnessPlanMarkdown,
} from "../../../src/harness/stages/plan.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { HarnessDesignSpec } from "../../../src/types.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-plan-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSpec(overrides: Partial<HarnessDesignSpec> = {}): HarnessDesignSpec {
  return {
    sessionId: "harness-plan-1",
    recordedAt: "2026-05-03T12:00:00.000Z",
    layerRules: [],
    tasteInvariants: [],
    tooling: { lint: "eslint", structuralTest: null, eval: null },
    goldenPrinciples: ["No emojis"],
    docsTree: ["docs/architecture.md"],
    validationGates: ["typecheck"],
    supipowersWiring: { addReviewAgent: true, wireChecksGate: true },
    antiSlop: {
      backend: "fallow",
      hooks: {
        pre_edit_dupe_probe: { enabled: true, threshold: 0.85, min_token_count: 30 },
        post_session_sweep: { enabled: true, block_on_new_dead_code: false },
        layer_context_inject: { enabled: true, addendum_max_chars: 800 },
        score_floor: { strict: 75, lenient: 90, release_blocking: false },
      },
      skillTargets: ["claude"],
    },
    ...overrides,
  };
}

describe("buildHarnessPlanTasks", () => {
  test("emits canonical tasks + conditional anti-slop tasks", () => {
    const tasks = buildHarnessPlanTasks(makeSpec());
    const names = tasks.map((t) => t.name);
    expect(names).toContain("Generate AGENTS.md");
    expect(names).toContain("Write docs/architecture.md");
    expect(names).toContain("Write docs/golden-principles.md");
    expect(names.some((n) => n.includes("fallow"))).toBe(true);
    expect(names).toContain("Register anti-slop hooks");
    expect(names).toContain("Add architecture-aware review agent");
    expect(names).toContain("Wire `/supi:checks` gate");
  });

  test("hybrid backend emits both fallow and desloppify tasks", () => {
    const spec = makeSpec({ antiSlop: { ...makeSpec().antiSlop, backend: "hybrid" } });
    const names = buildHarnessPlanTasks(spec).map((t) => t.name);
    expect(names.some((n) => n.includes("fallow"))).toBe(true);
    expect(names.some((n) => n.includes("desloppify"))).toBe(true);
  });

  test("supi-native backend skips fallow/desloppify tasks", () => {
    const spec = makeSpec({ antiSlop: { ...makeSpec().antiSlop, backend: "supi-native" } });
    const names = buildHarnessPlanTasks(spec).map((t) => t.name);
    expect(names.some((n) => n.includes("fallow"))).toBe(false);
    expect(names.some((n) => n.includes("desloppify"))).toBe(false);
  });
});

describe("renderHarnessPlanMarkdown", () => {
  test("includes frontmatter, context, and tasks", () => {
    const tasks = buildHarnessPlanTasks(makeSpec());
    const md = renderHarnessPlanMarkdown({
      spec: makeSpec(),
      tasks,
      recordedAt: "2026-05-03T12:00:00.000Z",
      planName: "harness-test",
    });
    expect(md).toContain("name: harness-test");
    expect(md).toContain("## Tasks");
    expect(md).toContain("**criteria**:");
    expect(md).toContain("**complexity**:");
  });
});

describe("validateHarnessPlanMarkdown", () => {
  test("accepts a generated plan", () => {
    const tasks = buildHarnessPlanTasks(makeSpec());
    const md = renderHarnessPlanMarkdown({
      spec: makeSpec(),
      tasks,
      recordedAt: "2026-05-03T12:00:00.000Z",
      planName: "harness-test",
    });
    const errors = validateHarnessPlanMarkdown(md, "harness-test");
    expect(errors).toEqual([]);
  });
});

describe("emitHarnessPlanFromSpec", () => {
  test("writes the plan markdown to the canonical plans dir", () => {
    const result = emitHarnessPlanFromSpec({
      ctx: { paths, cwd },
      spec: makeSpec(),
      recordedAt: "2026-05-03T12:00:00.000Z",
    });
    expect(fs.existsSync(result.planPath)).toBe(true);
    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.planMarkdown).toContain("## Tasks");
  });
});
