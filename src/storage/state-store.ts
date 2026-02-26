import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowCheckpoints, WorkflowState } from "../types";

const STATE_DIR_PARTS = [".pi", "supipowers"];
const STATE_FILE = "state.json";

export function defaultCheckpoints(): WorkflowCheckpoints {
  return {
    hasDesignApproval: false,
    hasPlanArtifact: false,
    hasReviewPass: false,
  };
}

export function defaultState(): WorkflowState {
  return {
    phase: "idle",
    nextAction: "Run /sp-start to initialize a workflow",
    updatedAt: Date.now(),
    checkpoints: defaultCheckpoints(),
  };
}

export function getStateFilePath(cwd: string): string {
  return join(cwd, ...STATE_DIR_PARTS, STATE_FILE);
}

export function ensureStateDir(cwd: string): string {
  const dir = join(cwd, ...STATE_DIR_PARTS);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadState(cwd: string): WorkflowState {
  const filePath = getStateFilePath(cwd);
  if (!existsSync(filePath)) return defaultState();

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<WorkflowState>;
    if (!parsed.phase || !parsed.nextAction) return defaultState();

    return {
      phase: parsed.phase,
      nextAction: parsed.nextAction,
      blocker: parsed.blocker,
      objective: parsed.objective,
      planArtifactPath: parsed.planArtifactPath,
      checkpoints: {
        ...defaultCheckpoints(),
        ...(parsed.checkpoints ?? {}),
      },
      updatedAt: parsed.updatedAt ?? Date.now(),
    };
  } catch {
    return defaultState();
  }
}

export function saveState(cwd: string, state: WorkflowState): void {
  ensureStateDir(cwd);
  const filePath = getStateFilePath(cwd);
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}
