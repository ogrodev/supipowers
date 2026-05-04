/**
 * Tier 1 documentation emitters.
 *
 * `docs/architecture.md` — layer table consumed by `parseArchitectureMarkdown` and the
 * layer-context-inject hook. Mandatory columns: `Layer | Files | Allowed | Forbidden`.
 *
 * `docs/golden-principles.md` — top 10 mechanical rules from the design spec.
 */

import type { HarnessDesignSpec, HarnessLayerRule } from "../../types.js";

export function renderArchitectureMd(input: { spec: HarnessDesignSpec }): string {
  const lines: string[] = [];
  lines.push("# Architecture");
  lines.push("");
  lines.push(
    "This document defines the layered architecture rules enforced by the harness. The table below is parsed by `parseArchitectureMarkdown` and consumed by the `layer-context-inject` hook on every agent session.",
  );
  lines.push("");
  lines.push("Edit with care: the columns are positional and the parser tolerates only the canonical convention.");
  lines.push("");
  lines.push("## Layer table");
  lines.push("");
  lines.push("| Layer | Files | Allowed | Forbidden | Description |");
  lines.push("|---|---|---|---|---|");
  if (input.spec.layerRules.length === 0) {
    lines.push("| (single bucket) | `**` | (any) | — | No layered rules. |");
  } else {
    for (const rule of input.spec.layerRules) {
      const files = rule.globs.map((g) => `\`${g}\``).join(", ");
      const allowed = rule.allowedImports.length > 0 ? rule.allowedImports.join(", ") : "—";
      const forbidden = rule.forbiddenImports.length > 0 ? rule.forbiddenImports.join(", ") : "—";
      const description = rule.description ?? "—";
      lines.push(`| ${rule.layer} | ${files} | ${allowed} | ${forbidden} | ${description} |`);
    }
  }
  lines.push("");
  lines.push("## Conventions");
  lines.push("");
  lines.push("- Layer names are lowercase and stable. Renaming a layer requires updating every reference in this table and in agent prompts.");
  lines.push("- File globs use `**` to match any path segments and `*` to match within a segment.");
  lines.push("- Use `—` (em dash) or `-` for empty cells. The parser treats them as the empty list.");
  lines.push("");
  return lines.join("\n") + "\n";
}

export function renderGoldenPrinciplesMd(input: { spec: HarnessDesignSpec }): string {
  const lines: string[] = [];
  lines.push("# Golden Principles");
  lines.push("");
  lines.push(
    "Mechanical rules enforced by the harness. Each is `grep`-checkable; ambiguity is a bug in the rule, not a license to interpret.",
  );
  lines.push("");
  if (input.spec.goldenPrinciples.length === 0) {
    lines.push("_No principles recorded yet. Run `/supi:harness design` to set them._");
  } else {
    for (let i = 0; i < input.spec.goldenPrinciples.length; i += 1) {
      lines.push(`${i + 1}. ${input.spec.goldenPrinciples[i]}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("Maintained by `/supi:harness`.");
  return lines.join("\n") + "\n";
}

/**
 * Convenience: build a minimal layer rule from a layer name + glob, used in unit tests.
 * Centralized so the test fixtures don't drift from the real shape.
 */
export function makeLayerRuleStub(layer: string, glob: string): HarnessLayerRule {
  return {
    layer,
    globs: [glob],
    allowedImports: [layer],
    forbiddenImports: [],
  };
}
