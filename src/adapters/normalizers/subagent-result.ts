export interface RawSubagentRun {
  id: string;
  mode: "single" | "chain" | "parallel";
  steps: Array<{ agent: string; task: string; output: string }>;
  status: "completed" | "failed" | "stopped";
}

export interface NormalizedSubagentResult {
  runId: string;
  adapter: "subagent";
  mode: "single" | "chain" | "parallel";
  status: "completed" | "failed" | "stopped";
  completedSteps: number;
  totalSteps: number;
  outputs: string[];
}

export function normalizeSubagentResult(raw: RawSubagentRun): NormalizedSubagentResult {
  return {
    runId: raw.id,
    adapter: "subagent",
    mode: raw.mode,
    status: raw.status,
    completedSteps: raw.steps.length,
    totalSteps: raw.steps.length,
    outputs: raw.steps.map((step) => step.output),
  };
}
