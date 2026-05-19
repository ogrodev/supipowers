import { spawnSync } from "node:child_process";
import type { ExecOptions, ExecResult, Platform } from "../../platform/types.js";
import { findExecutable } from "../../utils/executable.js";

export interface CliInvocation {
  cmd: string;
  args: string[];
}

function quoteCmdArgument(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

export function buildCliInvocation(
  resolvedCommand: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): CliInvocation {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(resolvedCommand)) {
    return {
      cmd: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `"${[resolvedCommand, ...args].map(quoteCmdArgument).join(" ")}"`,
      ],
    };
  }

  return { cmd: resolvedCommand, args };
}

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

  const invocation = buildCliInvocation(resolvedCommand, args);

  const result = spawnSync(invocation.cmd, invocation.args, {
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
