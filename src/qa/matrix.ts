import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { WorkspaceTarget } from "../types.js";
import { getTargetStatePath } from "../workspace/state-paths.js";
import type { E2eFlowRecord, E2eMatrix, E2eRegression, E2eTestResult } from "./types.js";

const MATRIX_FILENAME = "e2e-matrix.json";

function getMatrixPath(paths: PlatformPaths, cwd: string, target?: WorkspaceTarget): string {
  if (target) {
    return getTargetStatePath(paths, target, MATRIX_FILENAME);
  }

  return paths.project(cwd, MATRIX_FILENAME);
}

export function createEmptyMatrix(appType: string): E2eMatrix {
  return {
    version: "1.0.0",
    updatedAt: new Date().toISOString(),
    appType,
    flows: [],
  };
}

export function loadE2eMatrix(paths: PlatformPaths, cwd: string, target?: WorkspaceTarget): E2eMatrix | null {
  const matrixPath = getMatrixPath(paths, cwd, target);
  if (!fs.existsSync(matrixPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(matrixPath, "utf-8")) as E2eMatrix;
  } catch {
    return null;
  }
}

export function saveE2eMatrix(paths: PlatformPaths, cwd: string, matrix: E2eMatrix, target?: WorkspaceTarget): void {
  const matrixPath = getMatrixPath(paths, cwd, target);
  fs.mkdirSync(path.dirname(matrixPath), { recursive: true });
  fs.writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
}

export function detectRegressions(
  previousFlows: E2eFlowRecord[],
  results: E2eTestResult[],
): E2eRegression[] {
  const regressions: E2eRegression[] = [];

  for (const result of results) {
    if (result.status !== "fail") continue;

    const previousFlow = previousFlows.find((f) => f.id === result.flowId);
    if (!previousFlow || previousFlow.lastStatus !== "pass") continue;

    regressions.push({
      flowId: result.flowId,
      flowName: previousFlow.name,
      previousStatus: "pass",
      currentStatus: "fail",
      error: result.error ?? "Unknown error",
    });
  }

  return regressions;
}

export function updateMatrixFromResults(
  matrix: E2eMatrix,
  results: E2eTestResult[],
): E2eMatrix {
  const now = new Date().toISOString();
  const resultMap = new Map(results.map((r) => [r.flowId, r]));

  const updatedFlows = matrix.flows.map((flow) => {
    const result = resultMap.get(flow.id);
    if (!result) return flow;

    return {
      ...flow,
      lastStatus: result.status === "skip" ? flow.lastStatus : (result.status as "pass" | "fail"),
      lastTestedAt: now,
      lastError: result.status === "fail" ? result.error : undefined,
    };
  });

  return {
    ...matrix,
    updatedAt: now,
    flows: updatedFlows,
  };
}
