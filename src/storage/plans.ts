import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeLineEndings } from "../text.js";
import type { Plan, PlanTask, TaskComplexity, WorkspaceTarget } from "../types.js";
import type { PlatformPaths } from "../platform/types.js";
import { getTargetStatePath } from "../workspace/state-paths.js";

function getPlansDir(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "plans");
}

function listPlanFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
}

/** List all saved plans */
export function listPlans(paths: PlatformPaths, cwd: string): string[] {
  return listPlanFiles(getPlansDir(paths, cwd));
}

/** List all saved plans for a specific workspace target. */
export function listTargetPlans(paths: PlatformPaths, target: WorkspaceTarget): string[] {
  return listPlanFiles(getTargetStatePath(paths, target, "plans"));
}

/** Read a plan file by name */
export function readPlanFile(paths: PlatformPaths, cwd: string, name: string): string | null {
  const filePath = path.join(getPlansDir(paths, cwd), name);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

/** Save a plan markdown file */
export function savePlan(paths: PlatformPaths, cwd: string, filename: string, content: string): string {
  const dir = getPlansDir(paths, cwd);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Parse a plan markdown file into a Plan object */
export function parsePlan(content: string, filePath: string): Plan {
  const normalizedContent = normalizeLineEndings(content);
  const frontmatterMatch = normalizedContent.match(/^---\n([\s\S]*?)\n---/);
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

  const tasks = parseTasksFromMarkdown(normalizedContent);

  return {
    name: (meta.name as string) ?? path.basename(filePath, ".md"),
    created: (meta.created as string) ?? "",
    tags: (meta.tags as string[]) ?? [],
    context: extractContext(normalizedContent),
    tasks,
    filePath,
  };
}

function extractContext(content: string): string {
  const contextMatch = content.match(/## Context\n\n?([\s\S]*?)(?=\n## |$)/);
  return contextMatch?.[1]?.trim() ?? "";
}

/** Strip fenced code blocks to prevent matching task headers inside examples */
function stripCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, "");
}

function parseTasksFromMarkdown(content: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  // Strip code blocks so we don't match headers inside examples
  const stripped = stripCodeBlocks(content);
  // Match both "### 1. Name" and "### Task 1: Name" formats, anchored to line start
  const taskRegex = /^### (?:Task )?(\d+)[.:] (.+)/gm;
  let match: RegExpExecArray | null;

  while ((match = taskRegex.exec(stripped)) !== null) {
    const id = parseInt(match[1], 10);
    const headerLine = match[2];
    const startIdx = match.index + match[0].length;
    const nextTaskMatch = /\n### (?:Task )?\d+[.:] /.exec(stripped.slice(startIdx));
    const endIdx = nextTaskMatch
      ? startIdx + nextTaskMatch.index
      : stripped.length;
    const body = stripped.slice(startIdx, endIdx);

    const name = headerLine.replace(/\[.*?\]/g, "").trim();
    const model = parseModel(headerLine);
    const files = parseFiles(body);
    const criteria = parseCriteria(body);
    const complexity = parseComplexity(body);

    tasks.push({ id, name, description: name, files, criteria, complexity, ...(model ? { model } : {}) });
  }
  return tasks;
}


function parseModel(header: string): string | undefined {
  const match = header.match(/\[model:\s*([^\]]+)\]/);
  return match?.[1]?.trim();
}

function parseFiles(body: string): string[] {
  // Match header only (no greedy \s* that eats newlines)
  // Supports: **files**: ..., **File**: ..., **Files:** ...
  const headerMatch = body.match(/\*\*files?\*\*:/i) ?? body.match(/\*\*files?:\*\*/i);
  if (!headerMatch) return [];

  const afterHeader = body.slice(headerMatch.index! + headerMatch[0].length);
  const firstLine = afterHeader.split("\n")[0].trim();

  // Single-line format: **files**: src/a.ts, src/b.ts
  if (firstLine && !firstLine.startsWith("-")) {
    return firstLine.split(",").map((s) => s.trim());
  }

  // Multi-line format: **Files:**\n- Modify: `src/a.ts`\n- Create: `src/b.ts`
  const lines = afterHeader.split("\n");
  const files: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) {
      if (trimmed === "") continue; // skip blank lines between header and list
      break; // non-list line = end of files section
    }
    // Strip "- Modify: `src/types.ts`" → "src/types.ts"
    const content = trimmed.slice(1).trim(); // remove leading -
    const afterPrefix = content.replace(/^(?:Modify|Create|Test|Delete|Rename|Move):\s*/i, "");
    const filePath = afterPrefix.replace(/`/g, "").replace(/\s*\(.*\)\s*$/, "").trim();
    if (filePath && !filePath.startsWith("(")) {
      files.push(filePath);
    }
  }
  return files;
}

function parseCriteria(body: string): string {
  // Match both **criteria**: ... and **Criteria:** ...
  const match = body.match(/\*\*criteria\*\*:\s*(.+)/i) ?? body.match(/\*\*criteria:\*\*\s*(.+)/i);
  return match?.[1]?.trim() ?? "";
}

function parseComplexity(body: string): TaskComplexity {
  // Match both **complexity**: ... and **Complexity:** ...
  const match = body.match(/\*\*complexity\*\*:\s*(\w+)/i) ?? body.match(/\*\*complexity:\*\*\s*(\w+)/i);
  const val = match?.[1]?.toLowerCase();
  if (val === "small" || val === "medium" || val === "large") return val;
  return "medium";
}
