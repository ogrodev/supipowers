// src/discovery/index.ts
//
// Deterministic repo-entry-point discovery. Given a workflow query (e.g.
// "fix the login bug", "review the latest commit") and context signals
// (changed files, workspace targets), rank likely-relevant files with a
// short rationale for each candidate.
//
// Used by /supi:review, /supi:plan, /supi:qa, and /supi:fix-pr to start
// from strong candidates rather than broad wandering.
//
// Non-goals:
//   - Hosted search / vector database
//   - Replacing native tools (grep/lsp). This layer *orchestrates* them.
//
// Phase 6 exit gate: fixture workspaces rank expected files first, every
// candidate carries rationale, behavior stays stable when inputs are empty.

export type {
  DiscoveryCandidate,
  DiscoveryInput,
  DiscoveryResult,
  DiscoverySource,
} from "./rank.js";

export { rankDiscoveryCandidates } from "./rank.js";
export { discoverFromSources } from "./sources.js";

export { rankWithLspAugmentation } from "./lsp.js";
export type { LspSymbolLocation, LspAugmentedResult } from "./lsp.js";
export { suggestCandidatesForWorkflow } from "./workflow.js";
export type { WorkflowDiscoveryInput, WorkflowDiscoveryResult } from "./workflow.js";