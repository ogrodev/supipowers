// src/mcp/config.ts
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { McpRegistry, ServerConfig, HostMcpServer } from "./types.js";
import { createEmptyRegistry, isValidServerName } from "./types.js";

function getMcpConfigPath(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, ".mcp.json");
}

function getGlobalMcpConfigPath(paths: PlatformPaths): string {
  return paths.global(".mcp.json");
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function loadMcpRegistry(paths: PlatformPaths, cwd: string): McpRegistry {
  const globalData = readJsonSafe(getGlobalMcpConfigPath(paths)) as McpRegistry | null;
  const projectData = readJsonSafe(getMcpConfigPath(paths, cwd)) as McpRegistry | null;

  const merged: McpRegistry = createEmptyRegistry();

  // Global servers first
  if (globalData?.servers) {
    for (const [name, config] of Object.entries(globalData.servers)) {
      merged.servers[name] = applyDefaults(config);
    }
  }

  // Project servers override global
  if (projectData?.servers) {
    for (const [name, config] of Object.entries(projectData.servers)) {
      merged.servers[name] = applyDefaults(config);
    }
  }

  return merged;
}

function applyDefaults(partial: Partial<ServerConfig>): ServerConfig {
  return {
    transport: "http",
    activation: "contextual",
    taggable: true,
    triggers: [],
    antiTriggers: [],
    enabled: true,
    authPending: false,
    addedAt: new Date().toISOString(),
    ...partial,
  } as ServerConfig;
}

export function saveMcpRegistry(paths: PlatformPaths, cwd: string, registry: McpRegistry): void {
  const configPath = getMcpConfigPath(paths, cwd);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(registry, null, 2) + "\n");
}

/** Load project-only registry (not merged with global) for save operations */
function loadProjectRegistry(paths: PlatformPaths, cwd: string): McpRegistry {
  const data = readJsonSafe(getMcpConfigPath(paths, cwd)) as McpRegistry | null;
  return data ?? createEmptyRegistry();
}

export function addServer(
  paths: PlatformPaths,
  cwd: string,
  name: string,
  config: Partial<ServerConfig>,
): { ok: boolean; reason?: string } {
  const validation = isValidServerName(name);
  if (!validation.valid) return { ok: false, reason: validation.reason };

  const registry = loadProjectRegistry(paths, cwd);
  registry.servers[name] = applyDefaults({ ...config, addedAt: new Date().toISOString() });
  saveMcpRegistry(paths, cwd, registry);
  return { ok: true };
}

export function removeServer(paths: PlatformPaths, cwd: string, name: string): void {
  const registry = loadProjectRegistry(paths, cwd);
  delete registry.servers[name];
  saveMcpRegistry(paths, cwd, registry);
}

export function updateServer(
  paths: PlatformPaths,
  cwd: string,
  name: string,
  updates: Partial<ServerConfig>,
): { ok: boolean; reason?: string } {
  const registry = loadProjectRegistry(paths, cwd);
  if (!registry.servers[name]) return { ok: false, reason: `Server "${name}" not found` };
  registry.servers[name] = { ...registry.servers[name], ...updates };
  saveMcpRegistry(paths, cwd, registry);
  return { ok: true };
}

export function getServerConfig(
  paths: PlatformPaths,
  cwd: string,
  name: string,
): ServerConfig | undefined {
  const registry = loadMcpRegistry(paths, cwd);
  return registry.servers[name];
}

// ── Lockfile ──────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 5000;

export function acquireLock(paths: PlatformPaths, cwd: string): { acquired: boolean; release: () => void } {
  const lockPath = paths.project(cwd, ".mcp.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // Check for stale lock
  if (fs.existsSync(lockPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      const age = Date.now() - data.timestamp;
      if (age < LOCK_TIMEOUT_MS) {
        return { acquired: false, release: () => {} };
      }
    } catch { /* corrupt lock, overwrite */ }
  }

  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));

  return {
    acquired: true,
    release: () => {
      try { fs.unlinkSync(lockPath); } catch { /* already cleaned */ }
    },
  };
}


// ── Host Config Discovery ─────────────────────────────────────

interface HostMcpRaw {
  mcpServers?: Record<string, {
    type?: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    enabled?: boolean;
    auth?: unknown;
    oauth?: unknown;
  }>;
}

/**
 * Discover MCP servers from host config files:
 *   - User-level OMP: paths.agent("mcp.json") → ~/.omp/agent/mcp.json
 *   - Project-level OMP: <cwd>/<dotDir>/mcp.json → <cwd>/.omp/mcp.json
 *   - Claude Code:          ~/.claude.json
 *
 * All use the same { mcpServers: Record<string, ...> } shape.
 */
export function discoverHostMcpServers(
  paths: PlatformPaths,
  cwd: string,
): HostMcpServer[] {
  const dot = paths.dotDir;

  // OMP agent-level (user) config: ~/.omp/agent/mcp.json
  const userPath = paths.agent("mcp.json");
  // OMP project-level config: <cwd>/.omp/mcp.json
  const projectPath = path.join(cwd, dot, "mcp.json");
  // Claude Code user config: ~/.claude.json
  const claudeCodePath = path.join(homedir(), ".claude.json");

  const sources: Array<{ scope: HostMcpServer["scope"]; filePath: string }> = [
    { scope: "user", filePath: userPath },
    { scope: "project", filePath: projectPath },
    { scope: "claude-code", filePath: claudeCodePath },
  ];

  const discovered: HostMcpServer[] = [];

  for (const { scope, filePath } of sources) {
    const data = readJsonSafe(filePath) as HostMcpRaw | null;
    if (!data?.mcpServers) continue;

    for (const [name, raw] of Object.entries(data.mcpServers)) {
      // Skip explicitly disabled servers
      if (raw.enabled === false) continue;

      const effectiveType = raw.type ?? "stdio";
      let transport: HostMcpServer["transport"] = "stdio";
      if (effectiveType === "http") transport = "http";
      else if (effectiveType === "sse") transport = "sse";

      discovered.push({
        name,
        scope,
        transport,
        url: raw.url,
        command: raw.command,
        args: raw.args,
        env: raw.env,
        headers: raw.headers,
        enabled: raw.enabled,
        hasAuth: raw.auth !== undefined || raw.oauth !== undefined,
      });
    }
  }

  return discovered;
}
