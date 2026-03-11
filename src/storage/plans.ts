import * as fs from "node:fs";
import * as path from "node:path";
import type { Plan, PlanTask, TaskComplexity, TaskParallelism } from "../types.js";

const PLANS_DIR = [".omp", "supipowers", "plans"];

function getPlansDir(cwd: string): string {
  return path.join(cwd, ...PLANS_DIR);
}

/** List all saved plans */
export function listPlans(cwd: string): string[] {
  const dir = getPlansDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
}

/** Read a plan file by name */
export function readPlanFile(cwd: string, name: string): string | null {
  const filePath = path.join(getPlansDir(cwd), name);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

/** Save a plan markdown file */
export function savePlan(cwd: string, filename: string, content: string): string {
  const dir = getPlansDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Parse a plan markdown file into a Plan object */
export function parsePlan(content: string, filePath: string): Plan {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const meta: Record<string, string | string[]> = {};

  if (frontmatterMatch) {
    for (const line of frontmatterMatch[1].split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        meta[key] = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim());
      } else {
        meta[key] = val;
      }
    }
  }

  const tasks = parseTasksFromMarkdown(content);

  return {
    name: (meta.name as string) ?? path.basename(filePath, ".md"),
    created: (meta.created as string) ?? "",
    tags: (meta.tags as string[]) ?? [],
    context: extractContext(content),
    tasks,
    filePath,
  };
}

function extractContext(content: string): string {
  const contextMatch = content.match(/## Context\n\n?([\s\S]*?)(?=\n## |$)/);
  return contextMatch?.[1]?.trim() ?? "";
}

function parseTasksFromMarkdown(content: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  const taskRegex = /### (\d+)\. (.+)/g;
  let match: RegExpExecArray | null;

  while ((match = taskRegex.exec(content)) !== null) {
    const id = parseInt(match[1], 10);
    const headerLine = match[2];
    const startIdx = match.index + match[0].length;
    const nextTaskMatch = /\n### \d+\. /.exec(content.slice(startIdx));
    const endIdx = nextTaskMatch
      ? startIdx + nextTaskMatch.index
      : content.length;
    const body = content.slice(startIdx, endIdx);

    const name = headerLine.replace(/\[.*?\]/g, "").trim();
    const parallelism = parseParallelism(headerLine);
    const files = parseFiles(body);
    const criteria = parseCriteria(body);
    const complexity = parseComplexity(body);

    tasks.push({ id, name, description: name, files, criteria, complexity, parallelism });
  }
  return tasks;
}

function parseParallelism(header: string): TaskParallelism {
  if (header.includes("[parallel-safe]")) return { type: "parallel-safe" };
  const seqMatch = header.match(/\[sequential: depends on (\d[\d, ]*)\]/);
  if (seqMatch) {
    const deps = seqMatch[1].split(",").map((s) => parseInt(s.trim(), 10));
    return { type: "sequential", dependsOn: deps };
  }
  return { type: "sequential", dependsOn: [] };
}

function parseFiles(body: string): string[] {
  const filesMatch = body.match(/\*\*files?\*\*:\s*(.+)/i);
  if (!filesMatch) return [];
  return filesMatch[1].split(",").map((s) => s.trim());
}

function parseCriteria(body: string): string {
  const match = body.match(/\*\*criteria\*\*:\s*(.+)/i);
  return match?.[1]?.trim() ?? "";
}

function parseComplexity(body: string): TaskComplexity {
  const match = body.match(/\*\*complexity\*\*:\s*(\w+)/i);
  const val = match?.[1]?.toLowerCase();
  if (val === "small" || val === "medium" || val === "large") return val;
  return "medium";
}
