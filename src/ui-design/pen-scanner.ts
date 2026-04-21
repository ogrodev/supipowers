import * as fs from "node:fs";
import * as path from "node:path";

export interface PenFileEntry {
  /** Absolute path — passed to `mcp_pencil_*` tools as `filePath`. */
  absolutePath: string;
  /** Path relative to the repo root, using POSIX separators for display. */
  relativePath: string;
  /** File size in bytes (cheap disambiguation between same-named files). */
  bytes: number;
}

export interface ScanPenFilesOptions {
  excludes?: string[];
  max?: number;
}

const DEFAULT_EXCLUDES = [
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  ".omp",
  ".git",
];

const DEFAULT_MAX = 50;

/**
 * Walk `repoRoot` recursively and collect every `.pen` file outside the
 * excluded directories. Never throws: IO failures degrade to an empty list.
 * Entries are returned sorted by relative path for deterministic UI order.
 */
export function scanPenFiles(
  repoRoot: string,
  opts: ScanPenFilesOptions = {},
): PenFileEntry[] {
  const excludes = new Set(opts.excludes ?? DEFAULT_EXCLUDES);
  const max = opts.max ?? DEFAULT_MAX;

  let root: string;
  try {
    const stat = fs.statSync(repoRoot);
    if (!stat.isDirectory()) return [];
    root = path.resolve(repoRoot);
  } catch {
    return [];
  }

  const entries: PenFileEntry[] = [];

  const visit = (absDir: string): void => {
    if (entries.length >= max) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of dirents) {
      if (entries.length >= max) return;
      const entryAbs = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        if (excludes.has(entry.name)) continue;
        visit(entryAbs);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".pen")) continue;

      let bytes = 0;
      try {
        bytes = fs.statSync(entryAbs).size;
      } catch {
        continue;
      }

      const relative = path.relative(root, entryAbs).split(path.sep).join("/");
      entries.push({
        absolutePath: entryAbs,
        relativePath: relative,
        bytes,
      });
    }
  };

  visit(root);

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}
