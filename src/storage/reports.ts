import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewReport } from "../types.js";
import type { PlatformPaths } from "../platform/types.js";

function getReportsDir(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "reports");
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
    .filter((f) => f.startsWith("review-") && f.endsWith(".json"))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf-8"));
  } catch {
    return null;
  }
}
