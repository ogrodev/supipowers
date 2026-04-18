// src/discovery/sources.ts
//
// Side-effectful discovery helpers that read from the filesystem / git /
// workspace. Kept in a dedicated module so `rank.ts` stays pure and unit-
// testable without mocks.

import * as fs from "node:fs";
import * as path from "node:path";
import type { DiscoveryInput, DiscoveryResult } from "./rank.js";
import { rankDiscoveryCandidates } from "./rank.js";

export interface SourcesDiscoveryOptions extends Omit<DiscoveryInput, "candidatePool"> {
  /**
   * Glob-lite allow-list of path suffixes to include in the candidate pool
   * (e.g. [".ts", ".tsx"]). Empty means no suffix filter.
   */
  extensions?: string[];
  /**
   * Max pool size after filesystem walk. Prevents huge repos from dominating
   * candidate evaluation. Default: 5000.
   */
  maxPoolSize?: number;
  /**
   * Directory names to skip while walking. Defaults cover `.git`, `node_modules`,
   * `dist`, `.omp`, `.cache`.
   */
  excludeDirs?: string[];
}

const DEFAULT_EXCLUDES = new Set([".git", "node_modules", "dist", "build", ".omp", ".cache", ".next", ".turbo"]);

function walkFiles(
  root: string,
  options: { extensions?: string[]; maxPoolSize: number; excludeDirs: Set<string> },
): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  const extFilter = options.extensions && options.extensions.length > 0 ? options.extensions : null;

  while (stack.length > 0 && results.length < options.maxPoolSize) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (options.excludeDirs.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extFilter && !extFilter.some((ext) => entry.name.endsWith(ext))) continue;
      results.push(path.relative(root, full));
      if (results.length >= options.maxPoolSize) break;
    }
  }

  return results;
}

/**
 * Walk `repoRoot`, build a candidate pool, then rank. Deterministic given
 * the same filesystem state.
 */
export function discoverFromSources(options: SourcesDiscoveryOptions): DiscoveryResult {
  const excludeDirs = new Set([...DEFAULT_EXCLUDES, ...(options.excludeDirs ?? [])]);
  const maxPoolSize = options.maxPoolSize ?? 5000;

  const candidatePool = walkFiles(options.repoRoot, {
    extensions: options.extensions,
    maxPoolSize,
    excludeDirs,
  });

  return rankDiscoveryCandidates({
    cwd: options.cwd,
    repoRoot: options.repoRoot,
    query: options.query,
    changedFiles: options.changedFiles,
    candidatePool,
    externalSignals: options.externalSignals,
    limit: options.limit,
  });
}
