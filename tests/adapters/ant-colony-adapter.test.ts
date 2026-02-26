import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeAntColonyAdapter } from "../../src/adapters/ant-colony-adapter";
import { readExecutionEvents } from "../../src/storage/execution-history";

function createWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "supipowers-colony-"));
  mkdirSync(join(cwd, ".pi", "supipowers", "artifacts"), { recursive: true });
  return cwd;
}

function writePlan(cwd: string, steps: number): string {
  const path = join(cwd, ".pi", "supipowers", "artifacts", "plan.md");
  const lines = ["# Plan", "", "## Planned Steps"];
  for (let i = 1; i <= steps; i += 1) {
    lines.push(`${i}. Step ${i}`);
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
  return path;
}

describe("ant colony adapter", () => {
  test("executes and emits colony progress", async () => {
    const cwd = createWorkspace();
    const planPath = writePlan(cwd, 5);
    const phases: string[] = [];

    const result = await executeAntColonyAdapter({
      cwd,
      runId: "run-colony-1",
      objective: "Refactor module",
      planArtifactPath: planPath,
      onProgress: (update) => phases.push(update.phase),
    });

    expect(result.adapter).toBe("ant_colony");
    expect(result.status).toBe("completed");
    expect(existsSync(result.summaryPath)).toBe(true);
    expect(phases).toContain("scouting");
    expect(phases).toContain("workers");
    expect(phases).toContain("complete");

    const events = readExecutionEvents(cwd);
    expect(events.some((event) => event.type === "execution_started")).toBe(true);
    expect(events.some((event) => event.type === "execution_completed")).toBe(true);
  });

  test("supports abort signal", async () => {
    const cwd = createWorkspace();
    const planPath = writePlan(cwd, 40);
    const controller = new AbortController();

    const promise = executeAntColonyAdapter({
      cwd,
      runId: "run-colony-2",
      objective: "Abort run",
      planArtifactPath: planPath,
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const result = await promise;
    expect(result.status).toBe("stopped");
  });
});
