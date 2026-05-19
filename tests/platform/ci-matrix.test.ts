import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

interface WorkflowStep {
  name?: unknown;
  run?: unknown;
  env?: Record<string, unknown>;
}

interface WorkflowJob {
  "runs-on"?: unknown;
  strategy?: {
    matrix?: {
      os?: unknown;
    };
  };
  steps?: unknown;
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function loadCiWorkflow(): Workflow {
  const workflowPath = path.resolve(import.meta.dir, "../..", ".github", "workflows", "ci.yml");
  return parse(fs.readFileSync(workflowPath, "utf8")) as Workflow;
}

function workflowSteps(job: WorkflowJob): WorkflowStep[] {
  return Array.isArray(job.steps) ? (job.steps as WorkflowStep[]) : [];
}

describe("CI cross-platform contract", () => {
  test("validate job runs on Linux, macOS, and Windows", () => {
    const workflow = loadCiWorkflow();
    const validate = workflow.jobs?.validate;

    expect(validate).toBeDefined();
    expect(validate?.["runs-on"]).toBe("${{ matrix.os }}");
    expect(validate?.strategy?.matrix?.os).toEqual([
      "ubuntu-latest",
      "macos-latest",
      "windows-latest",
    ]);
  });

  test("validate job uses the canonical local CI command", () => {
    const workflow = loadCiWorkflow();
    const validate = workflow.jobs?.validate;
    const runs = validate ? workflowSteps(validate).map((step) => step.run) : [];

    expect(runs).toContain("bun run ci");
    expect(runs).not.toContain("bun run typecheck");
    expect(runs).not.toContain("bun run test");
  });

  test("Windows validation uses the canonical CI entrypoint with the fast Windows profile", () => {
    const workflow = loadCiWorkflow();
    const validate = workflow.jobs?.validate;
    const steps = validate ? workflowSteps(validate) : [];

    const canonicalCi = steps.find((step) => step.name === "Canonical CI");

    expect(canonicalCi?.run).toBe("bun run ci");
    expect(canonicalCi?.env?.SUPIPOWERS_CI_PROFILE).toBe("${{ runner.os == 'Windows' && 'windows-fast' || 'default' }}");
  });
});
