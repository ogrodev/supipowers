// src/context-mode/model.ts
//
// Registers the model-action ID used by the context-mode compaction-time
// LLM summarizer. The summarizer is wired in `src/context-mode/hooks.ts`
// at `session_before_compact` and gated by
// `contextMode.llmSummarization && byteLength(snapshot) > contextMode.llmThreshold`.
//
// Registering here (rather than at the call site) keeps registration as a
// module side-effect, mirroring the pattern in `src/quality/ai-setup.ts`,
// `src/commands/plan.ts`, etc.

import { modelRegistry } from "../config/model-registry-instance.js";

export const COMPACTION_SUMMARIZER_ACTION_ID = "context-mode.compaction-summarizer";

modelRegistry.register({
  id: COMPACTION_SUMMARIZER_ACTION_ID,
  category: "command",
  label: "Compaction summarizer",
  // Summarization is cheap text reduction; the cheapest available model is
  // fine. "default" keeps it inheriting from the user's main session model
  // when no per-action override is configured.
  harnessRoleHint: "default",
});
