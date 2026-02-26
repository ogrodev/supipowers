import type { Strictness } from "../types";

export type QualityGateName = "tdd" | "review" | "verification";
export type RevalidationStage = "manual" | "pre_execute" | "post_execute" | "pre_finish";

export interface QualityIssue {
  gate: QualityGateName;
  importance: "major" | "minor";
  blocking: boolean;
  message: string;
  recommendation?: string;
}

export interface QualityGateResult {
  gate: QualityGateName;
  passed: boolean;
  blocking: boolean;
  issues: QualityIssue[];
}

export interface RevalidationReport {
  strictness: Strictness;
  stage: RevalidationStage;
  passed: boolean;
  blocking: boolean;
  gates: QualityGateResult[];
  summary: string;
  nextActions: string[];
}
