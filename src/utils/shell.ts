import type { ExecOptions, ExecResult } from "../platform/types.js";

export interface ShellInvocation {
  command: string;
  args: string[];
}

export function getShellInvocation(command: string): ShellInvocation {
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/d", "/s", "/c", command] };
  }

  return { command: "sh", args: ["-lc", command] };
}

export function createExecShell(
  exec: (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>,
): (command: string, opts?: ExecOptions) => Promise<ExecResult> {
  return async (command: string, opts?: ExecOptions): Promise<ExecResult> => {
    const shell = getShellInvocation(command);
    return exec(shell.command, shell.args, opts);
  };
}

export async function execShellCommand(
  exec: (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>,
  command: string,
  opts?: ExecOptions,
): Promise<ExecResult> {
  return createExecShell(exec)(command, opts);
}
