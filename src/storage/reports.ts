import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewReport } from "../types.js";

const REPORTS_DIR = [".omp", "supipowers", "reports"];

function getReportsDir(cwd: string): string {
  return path.join(cwd, ...REPORTS_DIR);
}

/** Save a review report */
export function saveReviewReport(cwd: string, report: ReviewReport): string {
  const dir = getReportsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `review-${report.timestamp.slice(0, 10)}.json`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2) + "\n");
  return filePath;
}

/** Load the latest review report */
export function loadLatestReport(cwd: string): ReviewReport | null {
  const dir = getReportsDir(cwd);
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
