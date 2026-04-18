import { spawnSync } from "node:child_process";
import type { ExecOptions, ExecResult, Platform } from "../../platform/types.js";

export function runCliCommand(
  command: string,
  args: string[],
  options?: ExecOptions,
): ExecResult {
  const result = spawnSync(command, args, {
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : process.env,
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
