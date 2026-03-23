import type { Platform, PlatformContext } from "../platform/types.js";

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
        // handleMcpCli(platform, ctx, parseCliArgs(args));
      } else {
        handleMcp(platform, ctx);
      }
    },
  });
}
