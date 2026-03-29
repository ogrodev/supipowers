// src/platform/types.ts
import { join } from "node:path";
import { homedir } from "node:os";

// ── Path Resolution ────────────────────────────────────────

export interface PlatformPaths {
  /** The dot-directory name: ".pi" or ".omp" */
  dotDir: string;
  /** For user-visible messages and LLM prompts */
  dotDirDisplay: string;
  /** Resolve project-local: paths.project(cwd, "plans") → "<cwd>/.pi/supipowers/plans" */
  project(cwd: string, ...segments: string[]): string;
  /** Resolve global: paths.global("config.json") → "~/.pi/supipowers/config.json" */
  global(...segments: string[]): string;
  /** Resolve agent-level: paths.agent("extensions") → "~/.pi/agent/extensions" */
  agent(...segments: string[]): string;
}

export function createPaths(dotDir: string): PlatformPaths {
  return {
    dotDir,
    dotDirDisplay: dotDir,
    project: (cwd: string, ...segments: string[]) =>
      join(cwd, dotDir, "supipowers", ...segments),
    global: (...segments: string[]) =>
      join(homedir(), dotDir, "supipowers", ...segments),
    agent: (...segments: string[]) =>
      join(homedir(), dotDir, "agent", ...segments),
  };
}

// ── Capabilities ───────────────────────────────────────────

export interface PlatformCapabilities {
  agentSessions: boolean;
  compactionHooks: boolean;
  customWidgets: boolean;
  registerTool: boolean;
}

// ── Agent Sessions ─────────────────────────────────────────

export interface AgentSessionOptions {
  cwd?: string;
  taskDepth?: number;
  parentTaskPrefix?: string;
  [key: string]: unknown;
}

export interface AgentSession {
  subscribe(handler: (event: any) => void): () => void;
  prompt(text: string, opts?: { expandPromptTemplates?: boolean }): Promise<void>;
  state: { messages: any[] };
  dispose(): Promise<void>;
}

// ── Exec ───────────────────────────────────────────────────

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

// ── Messages ───────────────────────────────────────────────

export interface SendMessageOptions {
  deliverAs?: "steer" | "followUp" | "nextTurn";
  triggerTurn?: boolean;
}

// ── Commands ───────────────────────────────────────────────

export interface CommandInfo {
  name: string;
  description?: string;
  source?: string;
  handler?: (args: string | undefined, ctx: any) => void | Promise<void>;
}

// ── Context ────────────────────────────────────────────────

export interface PlatformContext {
  cwd: string;
  hasUI: boolean;
  ui: PlatformUI;
}

export interface PlatformUI {
  select(title: string, options: any[], opts?: any): Promise<string | null>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  input(label: string, opts?: any): Promise<string | null>;
  confirm?(title: string, message: string): Promise<boolean>;
  setWidget?(name: string, content: any): void;
  setStatus?(key: string, text: string | undefined): void;
}

// ── Platform ───────────────────────────────────────────────

export interface Platform {
  name: "pi" | "omp";

  // Commands
  registerCommand(name: string, opts: any): void;
  getCommands(): CommandInfo[];

  // Events
  on(event: string, handler: (...args: any[]) => any): void;

  // Execution
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  sendMessage(content: any, opts?: SendMessageOptions): void;

  // Introspection
  getActiveTools(): string[];

  // Tool registration (Pi-only)
  registerTool?(definition: any): void;
  setActiveTools?(names: string[]): void;

  // Rendering
  registerMessageRenderer<T>(type: string, renderer: any): void;

  // Model access
  setModel?(model: string): void;
  getCurrentModel?(): string;
  getModelForRole?(role: string): string | null;

  // Agent Sessions
  createAgentSession(opts: AgentSessionOptions): Promise<AgentSession>;

  // Paths
  paths: PlatformPaths;

  // Capabilities
  capabilities: PlatformCapabilities;
}
