import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform, PlatformContext } from "../platform/types.js";
import { loadMcpRegistry, addServer, removeServer, updateServer, getServerConfig, acquireLock } from "../mcp/config.js";
import { McpcClient } from "../mcp/mcpc.js";
import { generateTriggers } from "../mcp/triggers.js";
import { generateReadme, writeReadme, writeToolsCache, generateSkill, writeSkill, updateAgentsMd } from "../mcp/docs.js";
import { MCPC_EXIT } from "../mcp/types.js";
import type { McpTool, ServerConfig } from "../mcp/types.js";

export interface ParsedMcpArgs {
  subcommand?: string;
  name?: string;
  url?: string;
  transport?: string;
  command?: string;
  commandArgs?: string[];
  activation?: string;
  taggable?: boolean;
  json?: boolean;
  docsUrl?: string;
}

export function parseCliArgs(input: string): ParsedMcpArgs {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};

  const result: ParsedMcpArgs = { subcommand: tokens[0] };
  let i = 1;

  // Parse flags
  while (i < tokens.length && tokens[i].startsWith("--")) {
    const flag = tokens[i].slice(2);
    if (flag === "json") { result.json = true; i++; continue; }
    if (flag === "transport" && i + 1 < tokens.length) { result.transport = tokens[++i]; i++; continue; }
    if (flag === "docs" && i + 1 < tokens.length) { result.docsUrl = tokens[++i]; i++; continue; }
    i++;
  }

  // Parse positional args based on subcommand
  switch (result.subcommand) {
    case "add":
      if (i < tokens.length) result.name = tokens[i++];
      if (result.transport === "stdio") {
        if (i < tokens.length) result.command = tokens[i++];
        result.commandArgs = tokens.slice(i);
      } else {
        if (i < tokens.length) result.url = tokens[i++];
      }
      break;
    case "activation":
      if (i < tokens.length) result.name = tokens[i++];
      if (i < tokens.length) result.activation = tokens[i++];
      break;
    case "tag":
      if (i < tokens.length) result.name = tokens[i++];
      if (i < tokens.length) result.taggable = tokens[i] === "on";
      break;
    default:
      if (i < tokens.length) result.name = tokens[i++];
      break;
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────

function createMcpc(platform: Platform): McpcClient {
  return new McpcClient((cmd, args, opts) => platform.exec(cmd, args, opts));
}

function buildServerDescription(tools: McpTool[]): string {
  const descs = tools.slice(0, 3).map((t) => t.description).filter(Boolean);
  return descs.length > 0 ? descs.join("; ") : "MCP server";
}

function collectServersForSkill(
  platform: Platform,
  cwd: string,
): Record<string, { tools: McpTool[] }> {
  const registry = loadMcpRegistry(platform.paths, cwd);
  const result: Record<string, { tools: McpTool[] }> = {};
  for (const name of Object.keys(registry.servers)) {
    const toolsPath = path.join(
      platform.paths.project(cwd, "mcpc", name, "tools.json"),
    );
    try {
      const tools = JSON.parse(fs.readFileSync(toolsPath, "utf-8")) as McpTool[];
      result[name] = { tools };
    } catch {
      result[name] = { tools: [] };
    }
  }
  return result;
}

function collectServersForAgentsMd(
  platform: Platform,
  cwd: string,
): Record<string, { description: string }> {
  const registry = loadMcpRegistry(platform.paths, cwd);
  const result: Record<string, { description: string }> = {};
  for (const [name, config] of Object.entries(registry.servers)) {
    if (!config.enabled) continue;
    const toolsPath = platform.paths.project(cwd, "mcpc", name, "tools.json");
    let tools: McpTool[] = [];
    try {
      tools = JSON.parse(fs.readFileSync(toolsPath, "utf-8")) as McpTool[];
    } catch { /* no cache yet */ }
    result[name] = { description: buildServerDescription(tools) };
  }
  return result;
}

function regenerateArtifacts(platform: Platform, cwd: string): void {
  const basePath = platform.paths.project(cwd, "");
  const skillServers = collectServersForSkill(platform, cwd);
  writeSkill(basePath, generateSkill(skillServers));
  updateAgentsMd(cwd, collectServersForAgentsMd(platform, cwd));
}

// ── CLI Dispatch ──────────────────────────────────────────────

export async function handleMcpCli(
  platform: Platform,
  ctx: PlatformContext,
  parsed: ParsedMcpArgs,
): Promise<void> {
  const { paths } = platform;
  const { cwd } = ctx;

  switch (parsed.subcommand) {
    // ── ADD ────────────────────────────────────────────────
    case "add": {
      if (!parsed.name) {
        ctx.ui.notify("Usage: /supi:mcp add <name> <url>", "warning");
        return;
      }

      const lock = acquireLock(paths, cwd);
      if (!lock.acquired) {
        ctx.ui.notify("Another MCP operation is in progress", "warning");
        return;
      }

      try {
        const serverPartial: Partial<ServerConfig> = {
          transport: (parsed.transport ?? "http") as "http" | "stdio",
        };
        if (parsed.url) serverPartial.url = parsed.url;
        if (parsed.command) {
          serverPartial.command = parsed.command;
          serverPartial.args = parsed.commandArgs ?? [];
        }
        if (parsed.docsUrl) serverPartial.docsUrl = parsed.docsUrl;

        const addResult = addServer(paths, cwd, parsed.name, serverPartial);
        if (!addResult.ok) {
          ctx.ui.notify(`Failed to add server: ${addResult.reason}`, "error");
          return;
        }

        // Connect and fetch tools
        const mcpc = createMcpc(platform);
        const target = parsed.url ?? parsed.command ?? parsed.name;
        const connectResult = await mcpc.connect(target, parsed.name);
        if (connectResult.code !== MCPC_EXIT.SUCCESS) {
          ctx.ui.notify(`Server added but connection failed: ${connectResult.output}`, "warning");
          return;
        }

        const toolsResult = await mcpc.toolsList(parsed.name);
        const tools = toolsResult.tools;

        // Generate triggers and update config
        const triggers = generateTriggers(parsed.name, tools);
        updateServer(paths, cwd, parsed.name, { triggers });

        // Write artifacts
        const basePath = platform.paths.project(cwd, "");
        writeToolsCache(basePath, parsed.name, tools);

        const config = getServerConfig(paths, cwd, parsed.name)!;
        const readme = generateReadme(parsed.name, config, tools);
        writeReadme(basePath, parsed.name, readme);

        // Regenerate skill and AGENTS.md
        regenerateArtifacts(platform, cwd);

        ctx.ui.notify(`Added server "${parsed.name}" with ${tools.length} tools`, "info");
      } finally {
        lock.release();
      }
      break;
    }

    // ── REMOVE ─────────────────────────────────────────────
    case "remove": {
      if (!parsed.name) {
        ctx.ui.notify("Usage: /supi:mcp remove <name>", "warning");
        return;
      }

      removeServer(paths, cwd, parsed.name);

      // Clean up mcpc/<name>/ directory
      const serverDir = platform.paths.project(cwd, "mcpc", parsed.name);
      if (fs.existsSync(serverDir)) {
        fs.rmSync(serverDir, { recursive: true });
      }

      regenerateArtifacts(platform, cwd);
      ctx.ui.notify(`Removed server "${parsed.name}"`, "info");
      break;
    }

    // ── ENABLE ─────────────────────────────────────────────
    case "enable": {
      if (!parsed.name) {
        ctx.ui.notify("Usage: /supi:mcp enable <name>", "warning");
        return;
      }
      const result = updateServer(paths, cwd, parsed.name, { enabled: true });
      if (!result.ok) {
        ctx.ui.notify(result.reason ?? "Failed to enable server", "error");
        return;
      }
      regenerateArtifacts(platform, cwd);
      ctx.ui.notify(`Enabled server "${parsed.name}"`, "info");
      break;
    }

    // ── DISABLE ────────────────────────────────────────────
    case "disable": {
      if (!parsed.name) {
        ctx.ui.notify("Usage: /supi:mcp disable <name>", "warning");
        return;
      }
      const result = updateServer(paths, cwd, parsed.name, { enabled: false });
      if (!result.ok) {
        ctx.ui.notify(result.reason ?? "Failed to disable server", "error");
        return;
      }
      regenerateArtifacts(platform, cwd);
      ctx.ui.notify(`Disabled server "${parsed.name}"`, "info");
      break;
    }

    // ── REFRESH ────────────────────────────────────────────
    case "refresh": {
      const mcpc = createMcpc(platform);
      const registry = loadMcpRegistry(paths, cwd);

      const names = parsed.name
        ? [parsed.name]
        : Object.keys(registry.servers);

      for (const name of names) {
        const config = registry.servers[name];
        if (!config) {
          ctx.ui.notify(`Server "${name}" not found`, "warning");
          continue;
        }

        const target = config.url ?? config.command ?? name;
        const connectResult = await mcpc.connect(target, name);
        if (connectResult.code !== MCPC_EXIT.SUCCESS) {
          ctx.ui.notify(`Refresh failed for "${name}": ${connectResult.output}`, "warning");
          continue;
        }

        const toolsResult = await mcpc.toolsList(name);
        const tools = toolsResult.tools;

        const triggers = generateTriggers(name, tools);
        updateServer(paths, cwd, name, { triggers });

        const basePath = platform.paths.project(cwd, "");
        writeToolsCache(basePath, name, tools);

        const updatedConfig = getServerConfig(paths, cwd, name)!;
        const readme = generateReadme(name, updatedConfig, tools);
        writeReadme(basePath, name, readme);
      }

      regenerateArtifacts(platform, cwd);
      ctx.ui.notify(
        parsed.name
          ? `Refreshed server "${parsed.name}"`
          : `Refreshed ${names.length} server(s)`,
        "info",
      );
      break;
    }

    // ── LOGIN ──────────────────────────────────────────────
    case "login": {
      if (!parsed.name) {
        ctx.ui.notify("Usage: /supi:mcp login <name>", "warning");
        return;
      }
      const config = getServerConfig(paths, cwd, parsed.name);
      if (!config) {
        ctx.ui.notify(`Server "${parsed.name}" not found`, "error");
        return;
      }
      const target = config.url ?? config.command ?? parsed.name;
      const mcpc = createMcpc(platform);
      const result = await mcpc.login(target);
      if (result.code !== MCPC_EXIT.SUCCESS) {
        ctx.ui.notify(`Login failed: ${result.output}`, "error");
        return;
      }
      ctx.ui.notify(`Logged in to "${parsed.name}"`, "info");
      break;
    }

    // ── LOGOUT ─────────────────────────────────────────────
    case "logout": {
      if (!parsed.name) {
        ctx.ui.notify("Usage: /supi:mcp logout <name>", "warning");
        return;
      }
      const config = getServerConfig(paths, cwd, parsed.name);
      if (!config) {
        ctx.ui.notify(`Server "${parsed.name}" not found`, "error");
        return;
      }
      const target = config.url ?? config.command ?? parsed.name;
      const mcpc = createMcpc(platform);
      const result = await mcpc.logout(target);
      if (result.code !== MCPC_EXIT.SUCCESS) {
        ctx.ui.notify(`Logout failed: ${result.output}`, "error");
        return;
      }
      ctx.ui.notify(`Logged out of "${parsed.name}"`, "info");
      break;
    }

    // ── ACTIVATION ─────────────────────────────────────────
    case "activation": {
      if (!parsed.name || !parsed.activation) {
        ctx.ui.notify("Usage: /supi:mcp activation <name> <always|contextual|disabled>", "warning");
        return;
      }
      const result = updateServer(paths, cwd, parsed.name, {
        activation: parsed.activation as ServerConfig["activation"],
      });
      if (!result.ok) {
        ctx.ui.notify(result.reason ?? "Failed to update activation", "error");
        return;
      }
      ctx.ui.notify(`Set activation for "${parsed.name}" to ${parsed.activation}`, "info");
      break;
    }

    // ── TAG ────────────────────────────────────────────────
    case "tag": {
      if (!parsed.name || parsed.taggable === undefined) {
        ctx.ui.notify("Usage: /supi:mcp tag <name> <on|off>", "warning");
        return;
      }
      const result = updateServer(paths, cwd, parsed.name, {
        taggable: parsed.taggable,
      });
      if (!result.ok) {
        ctx.ui.notify(result.reason ?? "Failed to update taggable", "error");
        return;
      }
      ctx.ui.notify(`Set taggable for "${parsed.name}" to ${parsed.taggable ? "on" : "off"}`, "info");
      break;
    }

    // ── LIST ───────────────────────────────────────────────
    case "list": {
      const registry = loadMcpRegistry(paths, cwd);
      const entries = Object.entries(registry.servers);

      if (entries.length === 0) {
        ctx.ui.notify("No MCP servers configured", "info");
        return;
      }

      if (parsed.json) {
        ctx.ui.notify(JSON.stringify(registry.servers, null, 2), "info");
      } else {
        const lines = entries.map(([name, config]) => {
          const status = config.enabled ? "enabled" : "disabled";
          const transport = config.transport.toUpperCase();
          const activation = config.activation;
          return `  ${name} [${transport}] ${status} (${activation})`;
        });
        ctx.ui.notify("MCP Servers:\n" + lines.join("\n"), "info");
      }
      break;
    }

    // ── INFO ───────────────────────────────────────────────
    case "info": {
      if (!parsed.name) {
        ctx.ui.notify("Usage: /supi:mcp info <name>", "warning");
        return;
      }
      const config = getServerConfig(paths, cwd, parsed.name);
      if (!config) {
        ctx.ui.notify(`Server "${parsed.name}" not found`, "error");
        return;
      }

      const toolsPath = platform.paths.project(cwd, "mcpc", parsed.name, "tools.json");
      let tools: McpTool[] = [];
      try {
        tools = JSON.parse(fs.readFileSync(toolsPath, "utf-8")) as McpTool[];
      } catch { /* no cache */ }

      const lines: string[] = [];
      lines.push(`Server: ${parsed.name}`);
      if (config.url) lines.push(`URL: ${config.url}`);
      if (config.command) lines.push(`Command: ${config.command} ${(config.args ?? []).join(" ")}`);
      lines.push(`Transport: ${config.transport.toUpperCase()}`);
      lines.push(`Activation: ${config.activation}`);
      lines.push(`Enabled: ${config.enabled}`);
      lines.push(`Taggable: ${config.taggable}`);
      lines.push(`Added: ${config.addedAt}`);
      if (config.triggers?.length > 0) lines.push(`Triggers: ${config.triggers.join(", ")}`);
      lines.push(`Tools (${tools.length}): ${tools.map((t) => t.name).join(", ") || "none cached"}`);

      ctx.ui.notify(lines.join("\n"), "info");
      break;
    }

    default:
      ctx.ui.notify(
        `Unknown subcommand "${parsed.subcommand}". Available: add, remove, enable, disable, refresh, login, logout, activation, tag, list, info`,
        "warning",
      );
  }
}

export function handleMcp(platform: Platform, ctx: PlatformContext): void {
  if (!ctx.hasUI) {
    ctx.ui.notify("MCP UI requires interactive mode", "warning");
    return;
  }

  void (async () => {
    // TUI implementation — interactive server list
    // Follows the pattern from config.ts:
    // 1. Load registry
    // 2. Show server list via ctx.ui.select()
    // 3. On select: show action menu
    // 4. Execute action, loop
    ctx.ui.notify("MCP management — use /supi:mcp <subcommand> for CLI mode", "info");
  })();
}

export function registerMcpCommand(platform: Platform): void {
  platform.registerCommand("supi:mcp", {
    description: "Manage MCP servers — add, remove, enable, disable, refresh",
    async handler(args: string | undefined, ctx: any) {
      if (args) {
        // CLI mode — parse and dispatch
        await handleMcpCli(platform, ctx, parseCliArgs(args));
      } else {
        handleMcp(platform, ctx);
      }
    },
  });
}
