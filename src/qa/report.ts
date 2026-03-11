import * as fs from "node:fs";
import * as path from "node:path";

export interface QaReport {
  timestamp: string;
  framework: string;
  scope: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: { name: string; file: string; error: string }[];
}

export function saveQaReport(cwd: string, report: QaReport): string {
  const dir = path.join(cwd, ".omp", "supipowers", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const filename = `qa-${report.timestamp.slice(0, 10)}.json`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2) + "\n");
  return filePath;
}
