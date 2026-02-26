import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeWithRouter, stopActiveRun } from "../../src/adapters/router";
import { readExecutionEvents } from "../../src/storage/execution-history";

function createWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "supipowers-native-"));
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

describe("native adapter via router", () => {
  test("executes and logs run artifacts", async () => {
    const cwd = createWorkspace();
    const planPath = writePlan(cwd, 4);

    const result = await executeWithRouter({
      cwd,
      objective: "Implement feature",
      planArtifactPath: planPath,
      batchSize: 2,
    });

    expect(result.adapter).toBe("native");
    expect(result.status).toBe("completed");
    expect(result.runId.length).toBeGreaterThan(0);
    expect(existsSync(result.summaryPath)).toBe(true);

    const events = readExecutionEvents(cwd);
    const types = events.map((event) => event.type);
    expect(types).toContain("adapter_selected");
    expect(types).toContain("execution_started");
    expect(types).toContain("execution_completed");
    expect(events.every((event) => event.runId === result.runId)).toBe(true);
  });

  test("supports stop signal", async () => {
    const cwd = createWorkspace();
    const planPath = writePlan(cwd, 20);

    const promise = executeWithRouter({
      cwd,
      objective: "Long run",
      planArtifactPath: planPath,
      batchSize: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const stop = stopActiveRun(cwd);
    const result = await promise;

    expect(stop.stopped).toBe(true);
    expect(result.status).toBe("stopped");
  });

  test("routes to subagent adapter when capability is present", async () => {
    const cwd = createWorkspace();
    const planPath = writePlan(cwd, 2);

    const result = await executeWithRouter({
      cwd,
      objective: "Subagent preferred",
      planArtifactPath: planPath,
      capabilities: {
        subagent: true,
        antColony: false,
        antColonyStatus: false,
        native: true,
      },
    });

    expect(result.adapter).toBe("subagent");
  });

  test("routes to ant colony when complex and available", async () => {
    const cwd = createWorkspace();
    const planPath = writePlan(cwd, 5);

    const result = await executeWithRouter({
      cwd,
      objective: "Complex run",
      planArtifactPath: planPath,
      capabilities: {
        subagent: true,
        antColony: true,
        antColonyStatus: true,
        native: true,
      },
    });

    expect(result.adapter).toBe("ant_colony");
  });
});
