import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writePlanArtifact(cwd: string, objective: string): string {
  const artifactsDir = join(cwd, ".pi", "supipowers", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  const filename = `plan-${Date.now()}.md`;
  const filePath = join(artifactsDir, filename);
  const content = [
    "# Supipowers Plan Artifact",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Objective",
    objective || "(not specified)",
    "",
    "## Planned Steps",
    "1. Implement feature incrementally",
    "2. Validate with tests",
    "3. Review and refine",
  ].join("\n");

  writeFileSync(filePath, `${content}\n`, "utf-8");
  return filePath;
}
