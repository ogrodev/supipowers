/**
 * Architecture-aware review-agent emitter.
 *
 * Generates the markdown for `.omp/supipowers/review-agents/harness-architecture.md` so
 * `/supi:review` automatically reviews PRs against the layer rules and golden principles.
 *
 * The frontmatter is a strict subset of the existing review-agent definition shape — see
 * `src/review/agent-loader.ts` for the canonical schema. We only emit the minimum;
 * downstream loaders fill in defaults.
 */

import type { HarnessDesignSpec } from "../../types.js";

export function renderHarnessArchitectureReviewAgent(input: {
  spec: HarnessDesignSpec;
}): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("name: harness-architecture");
  lines.push("description: Reviews changed code against layer rules + golden principles enforced by /supi:harness");
  lines.push("focus: architecture");
  lines.push("---");
  lines.push("");
  lines.push("# Harness Architecture Reviewer");
  lines.push("");
  lines.push("You review the diff under review against two sources of truth:");
  lines.push("");
  lines.push("1. The layer table in [`docs/architecture.md`](../../../docs/architecture.md).");
  lines.push("2. The golden principles in [`docs/golden-principles.md`](../../../docs/golden-principles.md).");
  lines.push("");
  lines.push("Your job:");
  lines.push("");
  lines.push("- For every changed file, identify its layer.");
  lines.push("- Flag every import that crosses a forbidden boundary (`allowedImports` does not list the source layer).");
  lines.push("- Flag every change that violates a golden principle. Cite the principle by number.");
  lines.push("- Flag duplicated logic when the diff adds a function whose body is similar to an existing exported function elsewhere.");
  lines.push("");
  lines.push("Severity rubric:");
  lines.push("- `error`: layer-boundary violation or golden-principle violation.");
  lines.push("- `warning`: near-duplicate logic or missing tests for the changed scope.");
  lines.push("- `info`: stylistic suggestions; non-blocking.");
  lines.push("");
  lines.push("You **MUST NOT** review style-only items. The lint tool owns those.");
  lines.push("");
  if (input.spec.goldenPrinciples.length > 0) {
    lines.push("## Golden principles (snapshot)");
    lines.push("");
    for (let i = 0; i < input.spec.goldenPrinciples.length; i += 1) {
      lines.push(`${i + 1}. ${input.spec.goldenPrinciples[i]}`);
    }
    lines.push("");
  }
  if (input.spec.layerRules.length > 0) {
    lines.push("## Layer table (snapshot)");
    lines.push("");
    lines.push("| Layer | Files | Allowed | Forbidden |");
    lines.push("|---|---|---|---|");
    for (const rule of input.spec.layerRules) {
      const files = rule.globs.map((g) => `\`${g}\``).join(", ");
      const allowed = rule.allowedImports.length > 0 ? rule.allowedImports.join(", ") : "—";
      const forbidden = rule.forbiddenImports.length > 0 ? rule.forbiddenImports.join(", ") : "—";
      lines.push(`| ${rule.layer} | ${files} | ${allowed} | ${forbidden} |`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
