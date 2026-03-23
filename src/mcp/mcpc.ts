// src/mcp/mcpc.ts
import type { McpTool } from "./types.js";

type ExecFn = (cmd: string, args: string[], opts?: any) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Combine stdout + stderr, deduplicating if identical */
function combineOutput(r: { stdout: string; stderr: string }): string {
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  if (!out) return err;
  if (!err) return out;
  if (out === err) return out;
  return [out, err].join("\n");
}

export class McpcClient {
  constructor(private exec: ExecFn) {}

  async checkInstalled(): Promise<{ installed: boolean; version?: string }> {
    try {
      const r = await this.exec("mcpc", ["--version"]);
      if (r.code !== 0) return { installed: false };
      const match = r.stdout.match(/mcpc\s+([\d.]+)/);
      return { installed: true, version: match?.[1] };
    } catch {
      return { installed: false };
    }
  }

  async autoInstall(): Promise<boolean> {
    try {
      const r = await this.exec("npm", ["install", "-g", "@apify/mcpc"]);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  async connect(target: string, sessionName: string, authHeader?: string): Promise<{ code: number; output: string }> {
    const args = authHeader
      ? ["-H", authHeader, target, "connect", `@supi-${sessionName}`]
      : [target, "connect", `@supi-${sessionName}`];
    const r = await this.exec("mcpc", args);
    return { code: r.code, output: combineOutput(r) };
  }

  async close(sessionName: string): Promise<{ code: number; output: string }> {
    const r = await this.exec("mcpc", [`@supi-${sessionName}`, "close"]);
    return { code: r.code, output: combineOutput(r) };
  }

  async restart(sessionName: string): Promise<{ code: number; output: string }> {
    const r = await this.exec("mcpc", [`@supi-${sessionName}`, "restart"]);
    return { code: r.code, output: combineOutput(r) };
  }

  async toolsList(sessionName: string): Promise<{ code: number; tools: McpTool[] }> {
    const r = await this.exec("mcpc", ["--json", `@supi-${sessionName}`, "tools-list"]);
    if (r.code !== 0) return { code: r.code, tools: [] };
    try {
      const tools = JSON.parse(r.stdout) as McpTool[];
      return { code: 0, tools };
    } catch {
      return { code: r.code, tools: [] };
    }
  }

  async toolsCall(
    sessionName: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<{ code: number; data?: any; error?: string }> {
    const cmdArgs = ["--json", `@supi-${sessionName}`, "tools-call", toolName];
    if (args) {
      cmdArgs.push(...this.serializeArgs(args));
    }
    const r = await this.exec("mcpc", cmdArgs);
    if (r.code !== 0) return { code: r.code, error: r.stderr || r.stdout };
    try {
      return { code: 0, data: JSON.parse(r.stdout) };
    } catch {
      return { code: 0, data: r.stdout };
    }
  }

  async login(target: string): Promise<{ code: number; output: string }> {
    // OAuth flows can take minutes (user approving in browser)
    const r = await this.exec("mcpc", [target, "login"], { timeout: 120000 });
    return { code: r.code, output: combineOutput(r) };
  }

  async logout(target: string): Promise<{ code: number; output: string }> {
    const r = await this.exec("mcpc", [target, "logout"]);
    return { code: r.code, output: combineOutput(r) };
  }

  async listSessions(): Promise<{ code: number; output: string }> {
    const r = await this.exec("mcpc", ["--json"]);
    return { code: r.code, output: r.stdout };
  }

  serializeArgs(args: Record<string, unknown>): string[] {
    const result: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string") {
        result.push(`${key}:="${value}"`);
      } else {
        result.push(`${key}:=${JSON.stringify(value)}`);
      }
    }
    return result;
  }
}
