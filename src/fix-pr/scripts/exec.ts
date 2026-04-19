import { spawnSync } from "node:child_process";
import type { ExecOptions, ExecResult, Platform } from "../../platform/types.js";
import { findExecutable } from "../../utils/executable.js";

export function runCliCommand(
  command: string,
  args: string[],
  options?: ExecOptions,
): ExecResult {
  const env = options?.env ? { ...process.env, ...options.env } : process.env;
  const resolvedCommand = findExecutable(command, {
    searchPath: env.PATH,
    pathext: env.PATHEXT,
  }) ?? command;

  const result = spawnSync(resolvedCommand, args, {
    cwd: options?.cwd,
    env,
    encoding: "utf8",
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr || (result.error instanceof Error ? result.error.message : ""),
    code: result.status ?? (result.error ? 1 : 0),
    killed: result.signal != null,
  };
}

export function createCliPlatformExec(): Pick<Platform, "exec"> {
  return {
    exec: async (command, args, options) => runCliCommand(command, args, options),
  };
}
