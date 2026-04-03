/** Supported automated PR reviewers */
export type ReviewerType = "coderabbit" | "copilot" | "gemini" | "none";

/** How to handle comment replies */
export type CommentReplyPolicy = "answer-all" | "answer-selective" | "no-answer";

/** Model preference for a specific role */
export interface ModelPref {
  provider: string;
  model: string;
  tier: "low" | "high";
}

/** Per-repo fix-pr configuration */
export interface FixPrConfig {
  reviewer: {
    type: ReviewerType;
    triggerMethod: string | null;
  };
  commentPolicy: CommentReplyPolicy;
  loop: {
    delaySeconds: number;
    maxIterations: number;
  };
  models: {
    orchestrator: ModelPref;
    planner: ModelPref;
    fixer: ModelPref;
  };
}

/** A PR review comment from GitHub API */
export interface PrComment {
  id: number;
  path: string | null;
  line: number | null;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  inReplyToId: number | null;
  diffHunk: string | null;
  state: string;
  userType: string;
}

/** Assessment verdict for a single comment */
export type CommentVerdict = "accept" | "reject" | "investigate";

/** A group of related comments to fix together */
export interface FixGroup {
  id: string;
  commentIds: number[];
  files: string[];
  description: string;
}

/** Session status */
export type FixPrSessionStatus = "running" | "completed" | "failed";

/** Session ledger for a fix-pr run */
export interface FixPrSessionLedger {
  id: string;
  createdAt: string;
  updatedAt: string;
  prNumber: number;
  repo: string;
  status: FixPrSessionStatus;
  iteration: number;
  config: FixPrConfig;
  commentsProcessed: number[];
}
