import type { Platform } from "./platform/types.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSupiCommand, handleSupi } from "./commands/supi.js";
import { registerConfigCommand, handleConfig } from "./commands/config.js";
import { registerStatusCommand, handleStatus } from "./commands/status.js";
import { registerPlanCommand, getActiveVisualSessionDir, setActiveVisualSessionDir } from "./commands/plan.js";
import { getScriptsDir } from "./visual/companion.js";
import { registerRunCommand } from "./commands/run.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerQaCommand } from "./commands/qa.js";
import { registerReleaseCommand } from "./commands/release.js";
import { registerUpdateCommand, handleUpdate } from "./commands/update.js";
import { registerDoctorCommand, handleDoctor } from "./commands/doctor.js";
import { registerMcpCommand, handleMcp } from "./commands/mcp.js";
import { registerFixPrCommand } from "./commands/fix-pr.js";
import { loadConfig } from "./config/loader.js";
import { registerContextModeHooks } from "./context-mode/hooks.js";
import { registerProgressRenderer } from "./orchestrator/progress-renderer.js";
import { loadMcpRegistry } from "./mcp/config.js";
import { McpcClient } from "./mcp/mcpc.js";
import { parseTags, computeActiveServers } from "./mcp/activation.js";
import { initializeMcpServers, shutdownMcpServers } from "./mcp/lifecycle.js";

// TUI-only commands — intercepted at the input level to prevent
// message submission and "Working..." indicator
const TUI_COMMANDS: Record<string, (platform: Platform, ctx: any) => void> = {
  "supi": (platform, ctx) => handleSupi(platform, ctx),
  "supi:config": (platform, ctx) => handleConfig(platform, ctx),
  "supi:status": (platform, ctx) => handleStatus(platform, ctx),
  "supi:update": (platform, ctx) => handleUpdate(platform, ctx),
  "supi:doctor": (platform, ctx) => handleDoctor(platform, ctx),
  "supi:mcp": (platform, ctx) => handleMcp(platform, ctx),
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
  registerRunCommand(platform);
  registerReviewCommand(platform);
  registerQaCommand(platform);
  registerReleaseCommand(platform);
  registerUpdateCommand(platform);
  registerFixPrCommand(platform);
  registerDoctorCommand(platform);
  registerMcpCommand(platform);

  // Register custom message renderers
  registerProgressRenderer(platform);

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

    handler(platform, ctx);
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
      const stopScript = join(getScriptsDir(), "stop-server.sh");
      platform.exec("bash", [stopScript, previousVisualDir], { cwd: getScriptsDir() }).catch(() => {});
      setActiveVisualSessionDir(null);
    }

    // MCP server initialization
    const mcpRegistry = loadMcpRegistry(platform.paths, ctx.cwd);
    if (Object.keys(mcpRegistry.servers).length > 0) {
      const mcpClient = new McpcClient((cmd, args, opts) => platform.exec(cmd, args, opts));
      const installed = await mcpClient.checkInstalled();
      if (!installed.installed) {
        const ok = await mcpClient.autoInstall();
        if (!ok) {
          ctx.ui.notify("mcpc install failed — MCP features unavailable. Run /supi:update", "error");
        }
      }
      if (installed.installed || await mcpClient.checkInstalled().then(r => r.installed)) {
        await initializeMcpServers(mcpRegistry, mcpClient);
        // Gateway tool registration will happen here in a future task
        // when we have the full tool registration wiring
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
