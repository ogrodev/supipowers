import * as fs from "node:fs";
import * as path from "node:path";
import type { GateResult, GateStatus, ReviewReport } from "../types.js";
import type { PlatformPaths } from "../platform/types.js";

function getReportsDir(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "reports");
}

function isGateStatus(value: unknown): value is GateStatus {
  return value === "passed" || value === "failed" || value === "skipped" || value === "blocked";
}

function isGateResult(value: unknown): value is GateResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as GateResult).gate === "string" &&
    isGateStatus((value as GateResult).status) &&
    typeof (value as GateResult).summary === "string" &&
    Array.isArray((value as GateResult).issues)
  );
}

function isReviewReport(value: unknown): value is ReviewReport {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReviewReport).timestamp === "string" &&
    Array.isArray((value as ReviewReport).selectedGates) &&
    Array.isArray((value as ReviewReport).gates) &&
    (value as ReviewReport).gates.every(isGateResult) &&
    typeof (value as ReviewReport).summary === "object" &&
    (value as ReviewReport).summary !== null &&
    typeof (value as ReviewReport).summary.passed === "number" &&
    typeof (value as ReviewReport).summary.failed === "number" &&
    typeof (value as ReviewReport).summary.skipped === "number" &&
    typeof (value as ReviewReport).summary.blocked === "number" &&
    ((value as ReviewReport).overallStatus === "passed" ||
      (value as ReviewReport).overallStatus === "failed" ||
      (value as ReviewReport).overallStatus === "blocked")
  );
}

/** Save a review report */
export function saveReviewReport(paths: PlatformPaths, cwd: string, report: ReviewReport): string {
  const dir = getReportsDir(paths, cwd);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `review-${report.timestamp.slice(0, 10)}.json`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2) + "\n");
  return filePath;
}

/** Load the latest review report */
export function loadLatestReport(paths: PlatformPaths, cwd: string): ReviewReport | null {
  const dir = getReportsDir(paths, cwd);
  if (!fs.existsSync(dir)) return null;

  const files = fs
    .readdirSync(dir)
    .filter((file) => file.startsWith("review-") && file.endsWith(".json"))
    .sort()
    .reverse();

  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      if (isReviewReport(parsed)) {
        return parsed;
      }
    } catch {
      // Ignore malformed report files and continue to older entries.
    }
  }

  return null;
}
