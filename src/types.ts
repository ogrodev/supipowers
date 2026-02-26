export type Strictness = "strict" | "balanced" | "advisory";

export type WorkflowPhase =
  | "idle"
  | "brainstorming"
  | "design_pending_approval"
  | "design_approved"
  | "planning"
  | "plan_ready"
  | "executing"
  | "review_pending"
  | "ready_to_finish"
  | "completed"
  | "blocked"
  | "aborted";

export interface WorkflowCheckpoints {
  hasDesignApproval: boolean;
  hasPlanArtifact: boolean;
  hasReviewPass: boolean;
}

export interface WorkflowState {
  phase: WorkflowPhase;
  blocker?: string;
  nextAction: string;
  updatedAt: number;
  objective?: string;
  planArtifactPath?: string;
  checkpoints: WorkflowCheckpoints;
}

export interface SupipowersConfig {
  strictness: Strictness;
  showWidget: boolean;
  showStatus: boolean;
}

export interface StatusSnapshot {
  phase: WorkflowPhase;
  blocker?: string;
  nextAction: string;
}

export interface TransitionResult {
  ok: boolean;
  reason?: string;
  state: WorkflowState;
}
