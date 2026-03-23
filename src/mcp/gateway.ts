// src/mcp/gateway.ts
import type { ServerConfig, McpTool } from "./types.js";
import type { McpcClient } from "./mcpc.js";

const SNIPPET_TOOL_LIMIT = 10;

export function buildPromptSnippet(name: string, tools: McpTool[]): string {
  const toolNames = tools.slice(0, SNIPPET_TOOL_LIMIT).map((t) => t.name);
  const suffix = tools.length > SNIPPET_TOOL_LIMIT
    ? ` (${tools.length} tools, see README for full list)`
    : ` (${tools.length} tools)`;
  return `mcpc_${name} — ${toolNames.join(", ")}${suffix}`;
}

export function buildPromptGuidelines(config: ServerConfig): string[] {
  const guidelines: string[] = [];
  if (config.triggers.length > 0) {
    guidelines.push(`Use when the context involves: ${config.triggers.join(", ")}`);
  }
  if (config.antiTriggers.length > 0) {
    guidelines.push(`Do NOT use for: ${config.antiTriggers.join(", ")}`);
  }
  return guidelines;
}

export interface GatewayToolDef {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: any; // TypeBox schema — built at registration time
  executeFn: (toolName: string, args?: Record<string, unknown>) => Promise<any>;
}

export function buildGatewayToolDef(
  name: string,
  config: ServerConfig,
  tools: McpTool[],
): GatewayToolDef {
  const descriptions = tools.slice(0, 5).map((t) => t.description).filter(Boolean);
  const summary = descriptions.join(". ").slice(0, 200);

  return {
    name: `mcpc_${name}`,
    label: `${name} (via mcpc)`,
    description: summary || `MCP server: ${name}`,
    promptSnippet: buildPromptSnippet(name, tools),
    promptGuidelines: buildPromptGuidelines(config),
    parameters: {}, // Placeholder — actual TypeBox schema built at registration time
    executeFn: async () => {}, // Placeholder — wired at registration time
  };
}

/**
 * Build the mcpc args serialization and execute a tool call via mcpc.
 * Returns content blocks for the agent.
 */
export async function executeGatewayCall(
  client: McpcClient,
  sessionName: string,
  toolName: string,
  args?: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, any> }> {
  let result = await client.toolsCall(sessionName, toolName, args);

  // Session crash (exit code 3) — restart and retry once
  if (result.code === 3) {
    const restartResult = await client.restart(sessionName);
    if (restartResult.code !== 0) {
      throw new Error(`Session @supi-${sessionName} crashed and couldn't recover. Run /supi:mcp login ${sessionName} or check network.`);
    }
    result = await client.toolsCall(sessionName, toolName, args);
    if (result.code !== 0) {
      throw new Error(result.error || `mcpc call failed after restart (code ${result.code})`);
    }
  }

  // Stale tool cache (exit code 2) — hint to refresh
  if (result.code === 2) {
    const refreshed = await client.toolsList(sessionName);
    const toolNames = refreshed.tools.map((t) => t.name).join(", ");
    throw new Error(`Tool "${toolName}" not found. Server tools have been refreshed. Available: [${toolNames}]. Please retry.`);
  }

  if (result.code !== 0) {
    throw new Error(result.error || `mcpc exited with code ${result.code}`);
  }

  // mcpc --json returns { content: [...] } for tool calls
  if (result.data?.content) {
    return {
      content: result.data.content,
      details: { serverSession: `@supi-${sessionName}`, toolName },
    };
  }

  // Fallback: wrap raw output
  return {
    content: [{ type: "text", text: typeof result.data === "string" ? result.data : JSON.stringify(result.data) }],
    details: { serverSession: `@supi-${sessionName}`, toolName },
  };
}
