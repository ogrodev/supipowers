import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

import type { ExecOptions, ExecResult } from "../platform/types.js";
import { findExecutable } from "./executable.js";

/**
 * Cross-platform invocation for npm/npx that survives Windows `.cmd` shims.
 *
 * OMP's `platform.exec` is a thin wrapper over libuv's `uv_spawn`. On Windows
 * that exposes two distinct bugs when the target is an npm-shipped CLI:
 *
 *   1. libuv does not consult `PATHEXT`, so spawning `"npm"` fails with
 *      `ENOENT: uv_spawn 'npm'` because the on-disk file is `npm.cmd`.
 *   2. Even when callers resolve the absolute path, Node ≥18.20.2 hard-rejects
 *      spawning `.cmd`/`.bat` shims without `shell: true` (CVE-2024-27980).
 *      `ExecOptions` does not expose `shell`.
 *
 * Wrapping in `cmd.exe /d /s /c` is the canonical workaround, but only safe
 * when the spawner sets `windowsVerbatimArguments: true` — Node's default
 * CRT escaping double-quotes the command line and cmd's `/s` only strips one
 * pair. We don't control the spawner, so we sidestep the whole problem by
 * resolving the shim to the real `node <cli.js>` invocation, which is exactly
 * what `npm.cmd` does internally. `node.exe` is a plain binary that libuv
 * spawns without ceremony.
 *
 * Non-shim binaries (`bun`, `git`, `node`, `gh`, `rustup`, `go`, `pip`, …
 * all ship as `.exe` on Windows) pass through untouched; POSIX always passes
 * through.
 */

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: ExecOptions,
) => Promise<ExecResult>;

interface ResolvedInvocation {
  cmd: string;
  prefixArgs: string[];
}

const NODE_SHIMS = new Set<string>(["npm", "npx"]);
const resolutionCache = new Map<string, ResolvedInvocation>();

function resolveNodeShim(command: string): ResolvedInvocation | null {
  if (!NODE_SHIMS.has(command)) return null;

  // node.exe is the executor; npm-cli.js / npx-cli.js sits next to it under
  // node_modules/npm/bin/. We deliberately key off node's location (not the
  // shim's) because `npm.cmd` can live in a user-global dir (e.g. nvm,
  // %AppData%\npm) while the actual CLI bundle stays alongside node.
  const nodeBin = findExecutable("node");
  if (!nodeBin) return null;

  const cliJs = join(
    dirname(nodeBin),
    "node_modules",
    "npm",
    "bin",
    `${command}-cli.js`,
  );
  if (!existsSync(cliJs)) return null;

  return { cmd: nodeBin, prefixArgs: [cliJs] };
}

function resolveInvocation(command: string): ResolvedInvocation {
  if (process.platform !== "win32") {
    return { cmd: command, prefixArgs: [] };
  }
  const cached = resolutionCache.get(command);
  if (cached) return cached;

  const resolved = resolveNodeShim(command) ?? { cmd: command, prefixArgs: [] };
  resolutionCache.set(command, resolved);
  return resolved;
}

/**
 * Drop-in replacement for `platform.exec` callers that invoke npm/npx by name.
 * Other commands pass through unchanged.
 */
export function execCli(
  exec: ExecFn,
  command: string,
  args: string[],
  opts?: ExecOptions,
): Promise<ExecResult> {
  const resolved = resolveInvocation(command);
  return exec(resolved.cmd, [...resolved.prefixArgs, ...args], opts);
}

/**
 * Wrap an `ExecFn` so every call routes through `execCli`. Use when threading
 * an exec callback into helpers that dispatch arbitrary tools by string name
 * (e.g. the deps installer which splits install-command strings).
 */
export function wrapExecForCli(exec: ExecFn): ExecFn {
  return (cmd, args, opts) => execCli(exec, cmd, args, opts);
}

/** Test-only: forget cached resolutions between unit-test runs. */
export function _resetExecCliCacheForTesting(): void {
  resolutionCache.clear();
}
