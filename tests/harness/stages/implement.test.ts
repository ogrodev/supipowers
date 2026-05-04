import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  decideImplementRouting,
  HarnessImplementStage,
  preflightImplement,
} from "../../../src/harness/stages/implement.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { HarnessStageRunnerContext } from "../../../src/harness/stage-runner.js";
import type { Plan, PlanTask } from "../../../src/types.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-implement-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(): HarnessStageRunnerContext {
  return {
    platform: { paths } as any,
    paths,
    cwd,
    sessionId: "harness-imp-1",
    modelConfig: { version: "1", default: null, actions: {} },
    gateMode: "auto",
    now: () => "2026-05-03T12:00:00.000Z",
  };
}

function makePlan(taskCount: number): Plan {
  const tasks: PlanTask[] = [];
  for (let i = 1; i <= taskCount; i += 1) {
    tasks.push({
      id: i,
      name: `Task ${i}`,
      description: "do thing",
      files: [],
      criteria: "done",
      complexity: "small",
    });
  }
  return {
    name: "test-plan",
    created: "2026-05-03T12:00:00.000Z",
    tags: [],
    context: "ctx",
    tasks,
    filePath: path.join(cwd, ".omp", "supipowers", "plans", "test-plan.md"),
  };
}

describe("decideImplementRouting", () => {
  test("≤ threshold → in-session", () => {
    const decision = decideImplementRouting({ plan: makePlan(5), threshold: 10 });
    expect(decision.routing).toBe("in-session");
    expect(decision.reason).toContain("in-session");
  });

  test("> threshold → batch", () => {
    const decision = decideImplementRouting({ plan: makePlan(15), threshold: 10 });
    expect(decision.routing).toBe("batch");
    expect(decision.reason).toContain("batch");
  });

  test("equality → in-session (≤ threshold)", () => {
    const decision = decideImplementRouting({ plan: makePlan(10), threshold: 10 });
    expect(decision.routing).toBe("in-session");
  });
});

describe("preflightImplement", () => {
  test("missing plan → error", () => {
    const errors = preflightImplement({ cwd, planPath: "/nonexistent/plan.md", allowDirtyTree: true });
    expect(errors.find((e) => e.includes("not found"))).toBeDefined();
  });

  test("dirty tree warning when allowDirtyTree=false", () => {
    const planPath = path.join(cwd, "plan.md");
    fs.writeFileSync(planPath, "# plan");
    const errors = preflightImplement({ cwd, planPath });
    expect(errors.find((e) => e.includes("clean"))).toBeDefined();
  });

  test("clean preflight when allowDirtyTree=true and plan exists", () => {
    const planPath = path.join(cwd, "plan.md");
    fs.writeFileSync(planPath, "# plan");
    const errors = preflightImplement({ cwd, planPath, allowDirtyTree: true });
    expect(errors).toEqual([]);
  });
});

describe("HarnessImplementStage", () => {
  test("blocks on missing plan", async () => {
    const stage = new HarnessImplementStage({ planPath: "/nonexistent" });
    const result = await stage.run(ctx());
    expect(result.status).toBe("blocked");
  });

  test("returns awaiting-user with routing details", async () => {
    const planPath = path.join(cwd, "plan.md");
    fs.writeFileSync(
      planPath,
      [
        "---",
        "name: test",
        "created: 2026-05-03T12:00:00.000Z",
        "---",
        "",
        "## Tasks",
        "",
        "### Task 1: Foo",
        "**criteria**: done",
        "**complexity**: small",
      ].join("\n"),
    );
    const stage = new HarnessImplementStage({ planPath, threshold: 1 });
    const result = await stage.run(ctx());
    expect(result.status).toBe("awaiting-user");
    expect((result.details as { routing: string }).routing).toBe("in-session");
  });
});
