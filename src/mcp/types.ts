// src/mcp/types.ts

export interface McpAuth {
  type: "oauth" | "bearer";
  profile?: string;
  envVar?: string;
}

export interface ServerConfig {
  url?: string;
  command?: string;
  args?: string[];
  transport: "http" | "stdio";
  activation: "always" | "contextual" | "disabled";
  taggable: boolean;
  triggers: string[];
  antiTriggers: string[];
  auth?: McpAuth;
  docsUrl?: string;
  enabled: boolean;
  authPending: boolean;
  addedAt: string;
}

export interface McpRegistry {
  schemaVersion: number;
  servers: Record<string, ServerConfig>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolCatalog {
  serverName: string;
  tools: McpTool[];
  fetchedAt: string;
}

export type ServerStatus = "connected" | "disconnected" | "offline" | "auth-pending";

export interface ServerState {
  config: ServerConfig;
  status: ServerStatus;
  catalog?: ToolCatalog;
}

/** A server discovered from the OMP host MCP config (not yet in supipowers registry) */
export interface HostMcpServer {
  name: string;
  scope: "user" | "project" | "claude-code";
  transport: "http" | "stdio" | "sse";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  hasAuth?: boolean;
}

/** mcpc exit codes per documentation */
export const MCPC_EXIT = {
  SUCCESS: 0,
  CLIENT_ERROR: 1,
  SERVER_ERROR: 2,
  NETWORK_ERROR: 3,
  AUTH_ERROR: 4,
} as const;

export function createEmptyRegistry(): McpRegistry {
  return { schemaVersion: 1, servers: {} };
}

/** Reserved names that cannot be used as server names ($tag safety) */
export const RESERVED_NAMES = new Set([
  "path", "home", "user", "shell", "env", "pwd", "term", "lang",
  "editor", "display", "host", "port", "http_proxy", "https_proxy", "no_proxy",
]);

/** Validate a server name */
export function isValidServerName(name: string): { valid: boolean; reason?: string } {
  if (name.length < 1 || name.length > 63) {
    return { valid: false, reason: "Name must be 1-63 characters" };
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return { valid: false, reason: "Lowercase alphanumeric and hyphens only, cannot start/end with hyphen" };
  }
  if (RESERVED_NAMES.has(name)) {
    return { valid: false, reason: `"${name}" is reserved (conflicts with shell variables)` };
  }
  return { valid: true };
}
