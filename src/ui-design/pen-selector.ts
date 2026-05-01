import * as path from "node:path";
import { scanPenFiles, type PenFileEntry } from "./pen-scanner.js";

export interface PenSelection {
  kind: "existing" | "new";
  /** Absolute path — passed directly to `mcp__pencil_*` tools. */
  penFilePath: string;
}

export interface SelectPenFileOptions {
  ctx: any;
  repoRoot: string;
  /** Used as the parent for the "Create a new .pen" fallback. */
  sessionDir: string;
  /** Injection hook for tests. Defaults to `scanPenFiles`. */
  scan?: (repoRoot: string) => PenFileEntry[];
}

const CREATE_NEW_LABEL = "Create a new .pen in the session directory";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLabel(entry: PenFileEntry): string {
  return `${entry.relativePath} (${formatBytes(entry.bytes)})`;
}

function newPenPath(sessionDir: string): string {
  return path.join(sessionDir, "design.pen");
}

/**
 * Ask the user which `.pen` file to drive this `/supi:ui-design` session
 * against. Scans `repoRoot` for existing `.pen` files and offers them plus a
 * "create a new one in the session dir" fallback.
 *
 * Zero discovered files or a headless context → auto-default (no prompt). A
 * null UI selection (user cancelled) → returns `null`; the caller aborts.
 */
export async function selectPenFile(
  opts: SelectPenFileOptions,
): Promise<PenSelection | null> {
  const scan = opts.scan ?? scanPenFiles;
  const entries = scan(opts.repoRoot);

  if (entries.length === 0) {
    return { kind: "new", penFilePath: newPenPath(opts.sessionDir) };
  }

  if (!opts.ctx?.hasUI) {
    // Headless: deterministic fallback to the first (alphabetically sorted) entry
    // so CI smokes stay non-interactive.
    const first = entries[0]!;
    return { kind: "existing", penFilePath: first.absolutePath };
  }

  const labels = [...entries.map(formatLabel), CREATE_NEW_LABEL];
  const choice = await opts.ctx.ui.select("Select a .pen file", labels);
  if (!choice) return null;

  if (choice === CREATE_NEW_LABEL) {
    return { kind: "new", penFilePath: newPenPath(opts.sessionDir) };
  }

  const matched = entries.find((entry) => formatLabel(entry) === choice);
  if (!matched) return null;

  return { kind: "existing", penFilePath: matched.absolutePath };
}
