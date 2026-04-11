import type { Platform } from "./platform/types.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSupiCommand, handleSupi } from "./commands/supi.js";
import { registerConfigCommand, handleConfig } from "./commands/config.js";
import { registerStatusCommand, handleStatus } from "./commands/status.js";
import { registerPlanCommand, getActiveVisualSessionDir, setActiveVisualSessionDir } from "./commands/plan.js";
import { stopVisualServer } from "./visual/stop-server.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerQaCommand } from "./commands/qa.js";
import { registerReleaseCommand, handleRelease } from "./commands/release.js";
import { registerUpdateCommand, handleUpdate } from "./commands/update.js";
import { registerDoctorCommand, handleDoctor } from "./commands/doctor.js";
import { registerMcpCommand, handleMcp, handleMcpCli, parseCliArgs } from "./commands/mcp.js";
import { registerModelCommand, handleModel } from "./commands/model.js";
import { executeManagerAction } from "./mcp/manager-tool.js";
import { registerFixPrCommand } from "./commands/fix-pr.js";
import { registerContextCommand, handleContext } from "./commands/context.js";
import { registerOptimizeContextCommand, handleOptimizeContext } from "./commands/optimize-context.js";
import { registerCommitCommand, handleCommit } from "./commands/commit.js";
import { registerGenerateCommand } from "./commands/generate.js";
import { loadConfig } from "./config/loader.js";
import { registerContextModeHooks } from "./context-mode/hooks.js";
import { loadMcpRegistry } from "./mcp/config.js";
import { McpcClient } from "./mcp/mcpc.js";
import { parseTags, computeActiveServers } from "./mcp/activation.js";
import { initializeMcpServers, shutdownMcpServers } from "./mcp/lifecycle.js";
import { registerPlanApprovalHook } from "./planning/approval-flow.js";

// TUI-only commands — intercepted at the input level to prevent
// message submission and "Working..." indicator
const TUI_COMMANDS: Record<string, (platform: Platform, ctx: any, args?: string) => void> = {
  "supi": (platform, ctx) => handleSupi(platform, ctx),
  "supi:config": (platform, ctx) => handleConfig(platform, ctx),
  "supi:status": (platform, ctx) => handleStatus(platform, ctx),
  "supi:update": (platform, ctx) => handleUpdate(platform, ctx),
  "supi:doctor": (platform, ctx) => handleDoctor(platform, ctx),
  "supi:mcp": (platform, ctx) => handleMcp(platform, ctx),
  "supi:model": (platform, ctx) => handleModel(platform, ctx),
  "supi:context": (platform, ctx) => handleContext(platform, ctx),
  "supi:optimize-context": (platform, ctx) => handleOptimizeContext(platform, ctx),
  "supi:commit": (platform, ctx, args) => handleCommit(platform, ctx, args),
  "supi:release": (platform, ctx, args) => handleRelease(platform, ctx, args),
};

let pendingTags: string[] = [];

function getInstalledVersion(platform: Platform): string | null {
  const pkgPath = platform.paths.agent("extensions", "supipowers", "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    return null;
  }
}

export function bootstrap(platform: Platform): void {
  // Register all commands (needed for autocomplete)
  registerSupiCommand(platform);
  registerConfigCommand(platform);
  registerStatusCommand(platform);
  registerPlanCommand(platform);
  registerReviewCommand(platform);
  registerQaCommand(platform);
  registerReleaseCommand(platform);
  registerUpdateCommand(platform);
  registerFixPrCommand(platform);
  registerDoctorCommand(platform);
  registerMcpCommand(platform);
  registerModelCommand(platform);
  registerContextCommand(platform);
  registerOptimizeContextCommand(platform);
  registerCommitCommand(platform);
  registerGenerateCommand(platform);


  // Register plan approval flow (agent_end hook for plan approval UI)
  registerPlanApprovalHook(platform);


  // Intercept TUI-only commands at the input level — this runs BEFORE
  // message submission, so no chat message appears and no "Working..." indicator
  platform.on("input", (event, ctx) => {
    const text = event.text.trim();

    // Scan for $tags
    const registry = loadMcpRegistry(platform.paths, ctx.cwd);
    const registeredNames = new Set(Object.keys(registry.servers));
    if (registeredNames.size > 0) {
      const tags = parseTags(event.text, registeredNames);
      if (tags.length > 0) {
        pendingTags = tags;
      }
    }

    if (!text.startsWith("/")) return;

    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);

    const handler = TUI_COMMANDS[commandName];
    if (!handler) return;

    const args = spaceIndex === -1 ? undefined : text.slice(spaceIndex + 1);
    handler(platform, ctx, args);
    return { action: "handled" };
  });

  // Context-mode integration
  const config = loadConfig(platform.paths, process.cwd());
  registerContextModeHooks(platform, config);


  // MCP per-turn activation
  platform.on("before_agent_start", async (event, ctx) => {
    const registry = loadMcpRegistry(platform.paths, ctx.cwd);
    if (Object.keys(registry.servers).length === 0) {
      pendingTags = [];
      return;
    }

    const message = typeof event.message?.content === "string" ? event.message.content : "";
    const active = computeActiveServers(registry.servers, message, pendingTags);

    const activeToolNames = active.map((name) => `mcpc_${name}`);
    activeToolNames.push("mcpc_manager");

    if (platform.setActiveTools) {
      const currentTools = platform.getActiveTools();
      const nonMcpTools = currentTools.filter((t: string) => !t.startsWith("mcpc_"));
      platform.setActiveTools([...nonMcpTools, ...activeToolNames]);
    }

    pendingTags = [];
  });

  // Session start
  platform.on("session_start", async (_event, ctx) => {
    // Clean up any leftover visual companion from a previous session
    const previousVisualDir = getActiveVisualSessionDir();
    if (previousVisualDir) {
      stopVisualServer(previousVisualDir);
      setActiveVisualSessionDir(null);
    }

    // MCP: always register mcpc_manager tool (agent needs it even with zero servers)
    if (platform.registerTool) {
      registerMcpcManagerTool(platform, ctx);
    }

    // MCP server initialization (only if servers configured)
    const mcpRegistry = loadMcpRegistry(platform.paths, ctx.cwd);
    if (Object.keys(mcpRegistry.servers).length > 0) {
      const mcpClient = new McpcClient((cmd, args, opts) => platform.exec(cmd, args, opts));
      const installed = await mcpClient.checkInstalled();
      if (!installed.installed) {
        ctx.ui.notify("mcpc not installed — MCP servers won't connect. Run /supi:upgrade to install.", "warning");
      } else {
        await initializeMcpServers(mcpRegistry, mcpClient);
      }
    }

    // Check for updates in the background
    const currentVersion = getInstalledVersion(platform);
    if (!currentVersion) return;

    platform.exec("npm", ["view", "supipowers", "version"], { cwd: tmpdir() })
      .then((result) => {
        if (result.code !== 0) return;
        const latest = result.stdout.trim();
        if (latest && latest !== currentVersion) {
          ctx.ui.notify(
            `supipowers v${latest} available (current: v${currentVersion}). Run /supi:update`,
            "info",
          );
        }
      })
      .catch(() => {
        // Network error — silently ignore
      });
  });

  // MCP session shutdown
  platform.on("session_shutdown", async (_event, ctx) => {
    const mcpConfig = loadConfig(platform.paths, ctx.cwd ?? process.cwd());
    if (!mcpConfig.mcp?.closeSessionsOnExit) return;

    const registry = loadMcpRegistry(platform.paths, ctx.cwd ?? process.cwd());
    const mcpClient = new McpcClient((cmd, args, opts) => platform.exec(cmd, args, opts));
    const names = Object.keys(registry.servers).filter((n) => registry.servers[n].enabled);
    await shutdownMcpServers(names, mcpClient, true);
  });
}

function registerMcpcManagerTool(platform: Platform, ctx: any): void {
  platform.registerTool!({
    name: "mcpc_manager",
    label: "MCP Server Manager",
    description: "Add, remove, enable, disable, or refresh MCP servers managed by supipowers. Use this when the user asks to install, set up, or manage MCP servers.",
    promptSnippet: "mcpc_manager — manage MCP servers (add, remove, enable, disable, refresh, login, logout, list, info)",
    promptGuidelines: [
      "Use when the user asks to install, add, or set up an MCP server",
      "Use when the user asks to remove, disable, or manage an MCP server",
      "Do NOT use for calling MCP tools — use the mcpc_<name> gateway tools instead",
    ],
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove", "enable", "disable", "refresh", "login", "logout", "set-activation", "set-taggable", "list", "info"], description: "Action to perform" },
        name: { type: "string", description: "Server name (required for all except list/refresh-all)" },
        url: { type: "string", description: "Server URL (required for add)" },
        transport: { type: "string", enum: ["http", "stdio"], description: "Transport type" },
        docsUrl: { type: "string", description: "Documentation URL for richer README generation" },
        activation: { type: "string", enum: ["always", "contextual", "disabled"], description: "Activation mode" },
        taggable: { type: "boolean", description: "Whether $name tag activates this server" },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, toolCtx: any) {
      // First validate via routeManagerAction
      const result = await executeManagerAction(params, {
        hasUI: toolCtx.hasUI ?? true,
        ui: toolCtx.ui ?? {},
        cwd: toolCtx.cwd ?? ctx.cwd,
      }, {
        addServer: () => {},
        removeServer: () => {},
        updateServer: () => {},
      });

      if (result.error) {
        throw new Error(result.content[0]?.text ?? "Manager action failed");
      }

      // For actual operations, delegate to handleMcpCli
      const cliArgs = buildCliArgsFromParams(params);
      await handleMcpCli(platform, {
        cwd: toolCtx.cwd ?? ctx.cwd,
        hasUI: toolCtx.hasUI ?? true,
        ui: {
          notify: (msg: string) => {
            // Collect notifications — they'll be in the tool result
          },
          ...toolCtx.ui,
        },
      }, cliArgs);

      return {
        content: result.content,
        details: { action: params.action, name: params.name },
      };
    },
  });
}

function buildCliArgsFromParams(params: any): ReturnType<typeof parseCliArgs> {
  return {
    subcommand: params.action === "set-activation" ? "activation"
      : params.action === "set-taggable" ? "tag"
      : params.action,
    name: params.name,
    url: params.url,
    transport: params.transport,
    docsUrl: params.docsUrl,
    activation: params.activation,
    taggable: params.taggable,
  };
}
