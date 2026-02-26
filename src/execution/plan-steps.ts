import { existsSync, readFileSync } from "node:fs";

const DEFAULT_STEPS = ["Implement feature changes", "Run tests", "Prepare review notes"];

export function parsePlanSteps(planArtifactPath?: string): string[] {
  if (!planArtifactPath || !existsSync(planArtifactPath)) {
    return [...DEFAULT_STEPS];
  }

  const lines = readFileSync(planArtifactPath, "utf-8").split("\n");
  const parsed = lines
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, "").trim())
    .filter((line) => line.length > 0);

  return parsed.length > 0 ? parsed : [...DEFAULT_STEPS];
}
