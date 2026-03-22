import type { Platform, PlatformContext } from "../platform/types.js";

export interface CheckResult {
  name: string;
  presence: { ok: boolean; detail: string };
  functional?: { ok: boolean; detail: string };
}

export interface SectionResult {
  title: string;
  checks: CheckResult[];
}

const LABEL_WIDTH = 19; // "  Context Mode ... " padded width

export function formatCheckResult(check: CheckResult): string[] {
  const lines: string[] = [];
  const icon = (ok: boolean) => ok ? "✓" : "✗";
  const dots = ".".repeat(Math.max(2, LABEL_WIDTH - check.name.length - 2));
  const label = `  ${check.name} ${dots} `;
  const indent = " ".repeat(label.length);

  lines.push(`${label}${icon(check.presence.ok)} ${check.presence.detail}`);

  if (check.functional) {
    lines.push(`${indent}${icon(check.functional.ok)} ${check.functional.detail}`);
  }

  return lines;
}

/** Core infra checks where a presence failure is critical (blocks the extension) */
const CRITICAL_CHECKS = new Set(["Platform", "Config", "Git"]);

export function formatSummary(sections: SectionResult[]): string {
  let passed = 0;
  let warnings = 0;
  let critical = 0;

  for (const section of sections) {
    for (const check of section.checks) {
      const presenceOk = check.presence.ok;
      const functionalOk = check.functional ? check.functional.ok : true;

      if (presenceOk && functionalOk) {
        passed++;
      } else if (!presenceOk && CRITICAL_CHECKS.has(check.name)) {
        critical++;
      } else {
        warnings++;
      }
    }
  }

  return `Summary: ${passed} passed, ${warnings} warning${warnings !== 1 ? "s" : ""}, ${critical} critical`;
}
