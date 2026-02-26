import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeSubagentAdapter } from "../../src/adapters/subagent-adapter";
import { readExecutionEvents } from "../../src/storage/execution-history";

function createWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "supipowers-subagent-"));
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

describe("subagent adapter", () => {
  test("executes in auto mode and writes artifacts", async () => {
    const cwd = createWorkspace();
    const planPath = writePlan(cwd, 5);

    const result = await executeSubagentAdapter({
      cwd,
      runId: "run-subagent-1",
      objective: "Implement subagent flow",
      planArtifactPath: planPath,
      mode: "auto",
    });

    expect(result.adapter).toBe("subagent");
    expect(result.mode).toBe("parallel");
    expect(result.status).toBe("completed");
    expect(existsSync(result.summaryPath)).toBe(true);

    const events = readExecutionEvents(cwd);
    expect(events.some((event) => event.type === "execution_started")).toBe(true);
    expect(events.some((event) => event.type === "execution_completed")).toBe(true);
  });

  test("supports stop signal", async () => {
    const cwd = createWorkspace();
    const planPath = writePlan(cwd, 30);
    const controller = new AbortController();

    const promise = executeSubagentAdapter({
      cwd,
      runId: "run-subagent-2",
      objective: "Stop me",
      planArtifactPath: planPath,
      mode: "parallel",
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    const result = await promise;
    expect(result.status).toBe("stopped");
  });
});
