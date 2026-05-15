/**
 * Normalizes a captured `platform.exec` call back to its logical command name.
 *
 * `src/utils/exec-cli.ts` rewrites `npm` / `npx` invocations on Windows into
 * `node <path-to-cli.js> <args...>` to work around two `uv_spawn` limitations
 * (PATHEXT not consulted; Node ≥18.20.2 refuses `.cmd` shims without
 * `shell: true`). Tests that assert against the call shape stay platform-
 * stable by collapsing the rewritten form back to `{ cmd: "npm", args }`.
 *
 * Non-rewritten calls pass through untouched.
 */
export interface ExecCallShape {
  cmd: string;
  args: string[];
  opts?: unknown;
}

const CLI_BY_FILENAME: Array<{ suffix: string; name: string }> = [
  { suffix: "npm-cli.js", name: "npm" },
  { suffix: "npx-cli.js", name: "npx" },
];

function looksLikeNode(cmd: string): boolean {
  const lower = cmd.toLowerCase();
  return (
    lower === "node" ||
    lower.endsWith("\\node.exe") ||
    lower.endsWith("/node.exe") ||
    lower.endsWith("\\node") ||
    lower.endsWith("/node")
  );
}

export function normalizeExecCall<T extends ExecCallShape>(call: T): T {
  if (!looksLikeNode(call.cmd)) return call;
  const first = call.args[0];
  if (typeof first !== "string") return call;
  for (const { suffix, name } of CLI_BY_FILENAME) {
    if (first.endsWith(suffix)) {
      return { ...call, cmd: name, args: call.args.slice(1) };
    }
  }
  return call;
}

export function normalizeExecCalls<T extends ExecCallShape>(calls: T[]): T[] {
  return calls.map((c) => normalizeExecCall(c));
}
