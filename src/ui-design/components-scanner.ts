import * as fs from "node:fs";
import * as path from "node:path";
import type { ExistingComponent } from "./types.js";
import { normalizeRepoPath } from "../workspace/path-mapping.js";

export interface ScanExistingComponentsOptions {
  globs?: string[];
  excludes?: string[];
  max?: number;
}

export type ComponentsScanResult =
  | { status: "missing"; items: [] }
  | { status: "error"; items: []; reason: string }
  | { status: "ok"; items: ExistingComponent[] };

const DEFAULT_GLOBS = [
  "components/**/*.{tsx,jsx,vue,svelte}",
  "src/components/**/*.{tsx,jsx,vue,svelte}",
  "app/components/**/*.{tsx,jsx,vue,svelte}",
  "ui/**/*.{tsx,jsx,vue,svelte}",
];

const DEFAULT_EXCLUDES = [
  "node_modules/**",
  "dist/**",
  ".omp/**",
  "*.test.*",
  "*.spec.*",
  "*.stories.*",
];

const DEFAULT_MAX = 100;

function detectFramework(filePath: string): ExistingComponent["framework"] {
  if (filePath.endsWith(".vue")) return "vue";
  if (filePath.endsWith(".svelte")) return "svelte";
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) return "react";
  return "unknown";
}

function extractExports(content: string): string[] {
  const names = new Set<string>();
  const re = /export\s+(?:default\s+)?(?:function|const|class|let|var)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    names.add(m[1]!);
  }
  return Array.from(names);
}

function inferName(filePath: string): string {
  const base = path.basename(filePath);
  return base.replace(/\.(tsx|jsx|vue|svelte)$/, "");
}

function matchesExcludePattern(relPath: string, patterns: string[]): boolean {
  for (const p of patterns) {
    const glob = new Bun.Glob(p);
    if (glob.match(relPath)) return true;
    const base = path.basename(relPath);
    if (glob.match(base)) return true;
  }
  return false;
}

export async function scanExistingComponents(
  repoRoot: string,
  opts: ScanExistingComponentsOptions = {},
): Promise<ComponentsScanResult> {
  const globs = opts.globs ?? DEFAULT_GLOBS;
  const excludes = opts.excludes ?? DEFAULT_EXCLUDES;
  const max = opts.max ?? DEFAULT_MAX;

  try {
    if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
      return { status: "missing", items: [] };
    }

    const items: ExistingComponent[] = [];
    const seen = new Set<string>();

    for (const pattern of globs) {
      const glob = new Bun.Glob(pattern);
      for await (const match of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
        const repoRelativePath = normalizeRepoPath(match);
        if (seen.has(repoRelativePath)) continue;
        if (matchesExcludePattern(repoRelativePath, excludes)) continue;
        seen.add(repoRelativePath);

        const absPath = path.join(repoRoot, repoRelativePath);
        let content = "";
        try {
          content = fs.readFileSync(absPath, "utf-8");
        } catch {
          continue;
        }

        items.push({
          name: inferName(repoRelativePath),
          path: repoRelativePath,
          framework: detectFramework(repoRelativePath),
          exports: extractExports(content),
        });

        if (items.length >= max) break;
      }
      if (items.length >= max) break;
    }

    if (items.length === 0) {
      return { status: "missing", items: [] };
    }

    items.sort((a, b) => a.path.localeCompare(b.path));
    return { status: "ok", items };
  } catch (err) {
    return {
      status: "error",
      items: [],
      reason: (err as Error).message,
    };
  }
}
