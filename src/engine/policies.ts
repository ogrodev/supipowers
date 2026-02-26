import type { Strictness } from "../types";

export type GateImportance = "major" | "minor";

export function shouldBlockOnMissingGate(strictness: Strictness, importance: GateImportance): boolean {
  if (strictness === "strict") return true;
  if (strictness === "balanced") return importance === "major";
  return false;
}
