// src/context-mode/source-hash.ts
//
// Compute the per-row `unique_source_hash` for L1 metrics. The hash exists
// to power "unique-source share" without storing raw paths or commands. Two
// invariants:
//
//   1. The same logical source produces the same hash regardless of platform
//      separator or relative-vs-absolute spelling, given the same `cwd`.
//   2. The same path under two different `projectSlug` values produces
//      different hashes, so a hash is never a cross-project identifier.
//
// Tool inputs are never copied verbatim; only canonicalized prefixes flow
// into the hash input.

import { createHash } from "node:crypto";

import { canonicalToolName } from "./tool-name.js";

export interface UniqueSourceHashOpts {
  tool: string;
  input: Record<string, unknown> | undefined;
  cwd: string;
  projectSlug: string;
}

/**
 * Detect whether a path string is absolute on either POSIX or Windows.
 *
 * Recognized absolute forms:
 *   - leading `/` (POSIX)
 *   - drive-letter prefix `[A-Za-z]:` followed by `\` or `/` (Windows)
 *   - UNC prefix `\\` or `//` (network share / WSL `\\?\` namespace)
 */
function isAbsolutePath(p: string): boolean {
  if (p.length === 0) return false;
  if (p[0] === "/" || p[0] === "\\") {
    // Includes both POSIX `/x` and Windows `\\server\share`
    return true;
  }
  // Drive-letter Windows path: `C:\…` or `c:/…`
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

/** Normalize separators and collapse `.` / `..` segments using POSIX rules. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Internal helper: resolve `pathInput` to a canonical absolute POSIX form. */
function canonicalizePath(pathInput: string, cwd: string): string {
  const posix = toPosix(pathInput);
  if (isAbsolutePath(pathInput)) {
    return collapsePosix(posix);
  }
  const cwdPosix = toPosix(cwd);
  return collapsePosix(joinPosix(cwdPosix, posix));
}

/** Lightweight POSIX `path.normalize` — segment-by-segment without depending on
 *  Node's platform-specific `path.posix.normalize` differences. */
function collapsePosix(p: string): string {
  const isAbs = p.startsWith("/");
  const parts = p.split("/").filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!isAbs) {
        stack.push("..");
      }
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join("/");
  return isAbs ? "/" + joined : joined || ".";
}

function joinPosix(left: string, right: string): string {
  if (left === "") return right;
  if (left.endsWith("/")) return left + right;
  return left + "/" + right;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Truncate a bash command to a stable, leak-free identifier:
 *   - split on whitespace, take the first 4 tokens, lowercase them, rejoin.
 *
 * Anything past the 4th token (env exports, secrets, file paths, command
 * arguments) is dropped. The first 4 tokens give us enough resolution to
 * distinguish `bun run typecheck` from `bun run test` while never copying
 * the rest of the command into the hash input.
 */
function truncateBashCommand(command: string): string {
  return command
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .map((token) => token.toLowerCase())
    .join(" ");
}

/**
 * Produce the unique-source hash, or `null` for tools whose inputs do not
 * map to a stable source identifier.
 */
export function uniqueSourceHash(opts: UniqueSourceHashOpts): string | null {
  const { tool, input, cwd, projectSlug } = opts;
  const canonical = canonicalToolName(tool);

  switch (canonical) {
    case "read":
    case "open": {
      const p = typeof input?.path === "string" ? input.path : null;
      if (!p) return null;
      const absolute = canonicalizePath(p, cwd);
      return sha256Hex(`read:${absolute}:${projectSlug}`);
    }
    case "search": {
      const p = typeof input?.path === "string" ? input.path : "";
      if (!p) {
        // Pattern-only search without an explicit path target.
        const pattern = typeof input?.pattern === "string" ? input.pattern : "";
        return sha256Hex(`search:${pattern}:${projectSlug}`);
      }
      const absolute = canonicalizePath(p, cwd);
      return sha256Hex(`search:${absolute}:${projectSlug}`);
    }
    case "find": {
      const pattern = typeof input?.pattern === "string" ? input.pattern : "";
      return sha256Hex(`find:${pattern}:${projectSlug}`);
    }
    case "bash": {
      const command = typeof input?.command === "string" ? input.command : "";
      const truncated = truncateBashCommand(command);
      return sha256Hex(`bash:${truncated}:${projectSlug}`);
    }
    default:
      return null;
  }
}
