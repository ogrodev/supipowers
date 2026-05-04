/**
 * Render a human-readable summary of a GC report.
 */

import type { GcReport } from "./runner.js";

export function renderGcReport(report: GcReport): string {
  const lines: string[] = [];
  lines.push("Harness GC report");
  lines.push("─────────────────");
  lines.push(`Inspected:           ${report.inspected}`);
  lines.push(`Mechanical attempted: ${report.mechanicalAttempted}`);
  lines.push(`Mechanical resolved:  ${report.mechanicalResolved}`);
  lines.push(`Judgmental reported:  ${report.judgmentalReported}`);
  if (report.failures.length > 0) {
    lines.push("");
    lines.push(`Failures (${report.failures.length}):`);
    for (const failure of report.failures.slice(0, 10)) {
      lines.push(`  - ${failure.id}: ${failure.reason}`);
    }
    if (report.failures.length > 10) {
      lines.push(`  …and ${report.failures.length - 10} more.`);
    }
  }
  lines.push("");
  lines.push(`Elapsed: ${report.durationMs} ms`);
  return lines.join("\n");
}
