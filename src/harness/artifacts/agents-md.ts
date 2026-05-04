/**
 * AGENTS.md emitter.
 *
 * The repo-root AGENTS.md is the agent-neutral entry point. It MUST stay short (≤120
 * lines) and reference `docs/architecture.md` + `docs/golden-principles.md` for depth.
 * Every agent harness (Codex, Claude Code, Cursor, supipowers) reads this file first.
 */

import type { HarnessDesignSpec } from "../../types.js";

const HARD_LINE_CAP = 120;

export interface AgentsMdInput {
  projectName: string;
  spec: HarnessDesignSpec;
  /** Whether the harness is using fallow / desloppify / hybrid / supi-native. */
  backendLabel: string;
  /** Repo entry-point hint (e.g. `bun install && bun test`). */
  bootstrapHint?: string;
}

/**
 * Render AGENTS.md content. Pure function; emitter caps at HARD_LINE_CAP and asserts the
 * cap so a future edit can't silently exceed it.
 */
export function renderAgentsMd(input: AgentsMdInput): string {
  const lines: string[] = [];

  lines.push(`# AGENTS.md — ${input.projectName}`);
  lines.push("");
  lines.push("This file orients any AI coding agent operating in this repo.");
  lines.push("");
  lines.push("## TL;DR");
  lines.push("");
  lines.push(`- This repo uses the supipowers harness (\`/supi:harness\`) with the **${input.backendLabel}** anti-slop backend.`);
  lines.push("- Architecture rules: see [`docs/architecture.md`](docs/architecture.md). Read before editing files in unfamiliar layers.");
  lines.push("- Golden principles: see [`docs/golden-principles.md`](docs/golden-principles.md). These are mechanical — a `grep` should be able to enforce them.");
  if (input.bootstrapHint) {
    lines.push(`- Bootstrap: \`${input.bootstrapHint}\``);
  }
  lines.push("");

  lines.push("## What you MUST do");
  lines.push("");
  lines.push("- Edit only the files the task names. Do not refactor adjacent code without a task gate.");
  lines.push("- Reuse existing utilities. Search before introducing a new abstraction.");
  lines.push("- Run targeted verification before claiming a task done. Tests you did not write are bugs shipped.");
  if (input.spec.tooling.lint) {
    lines.push(`- Run \`${input.spec.tooling.lint}\` on touched files.`);
  }
  if (input.spec.tooling.structuralTest) {
    lines.push(`- Run \`${input.spec.tooling.structuralTest}\` on the changed scope.`);
  }
  lines.push("");

  lines.push("## What you MUST NOT do");
  lines.push("");
  lines.push("- Duplicate functions that already exist. The pre-edit dupe probe will block the write.");
  lines.push("- Leave dead code after a session. The post-session sweep will append it to the slop queue.");
  lines.push("- Cross layer boundaries from `docs/architecture.md`. Imports forbidden by the layer table fail review.");
  lines.push("- Suppress tests, weaken assertions, or comment out failing checks to make a build pass.");
  lines.push("");

  if (input.spec.tasteInvariants.length > 0) {
    lines.push("## Taste invariants");
    lines.push("");
    for (const inv of input.spec.tasteInvariants.slice(0, 7)) {
      lines.push(`- ${inv}`);
    }
    lines.push("");
  }

  lines.push("## When in doubt");
  lines.push("");
  lines.push("- Re-read the task description before editing.");
  lines.push("- Search the codebase for prior art (`search`/`ast_grep`).");
  lines.push("- Surface uncertainty explicitly — better to ask than to ship a plausible lie.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Maintained by `/supi:harness`. Run `/supi:harness gc` to refresh.");

  // Cap enforcement.
  if (lines.length > HARD_LINE_CAP) {
    throw new Error(`AGENTS.md emitter exceeded hard cap (${lines.length}/${HARD_LINE_CAP} lines)`);
  }
  return lines.join("\n") + "\n";
}
