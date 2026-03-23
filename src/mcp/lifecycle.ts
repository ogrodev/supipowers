// src/mcp/lifecycle.ts
import type { McpRegistry, ServerState } from "./types.js";
import type { McpcClient } from "./mcpc.js";

const RETRY_DELAY_MS = 2000;

export async function initializeMcpServers(
  registry: McpRegistry,
  client: McpcClient,
): Promise<Record<string, ServerState>> {
  const states: Record<string, ServerState> = {};

  for (const [name, config] of Object.entries(registry.servers)) {
    if (!config.enabled) {
      states[name] = { config, status: "disconnected" };
      continue;
    }

    const target = config.url ?? config.command ?? "";

    // Build auth header for bearer tokens
    let authHeader: string | undefined;
    if (config.auth?.type === "bearer" && config.auth.envVar) {
      const token = process.env[config.auth.envVar];
      if (token) authHeader = `Authorization: Bearer ${token}`;
    }

    let connectResult = await client.connect(target, name, authHeader);

    // Auth error
    if (connectResult.code === 4) {
      states[name] = { config: { ...config, authPending: true }, status: "auth-pending" };
      continue;
    }

    // Network error — retry once
    if (connectResult.code === 3) {
      await delay(RETRY_DELAY_MS);
      connectResult = await client.connect(target, name, authHeader);
      if (connectResult.code !== 0) {
        states[name] = { config, status: "offline" };
        continue;
      }
    }

    if (connectResult.code !== 0) {
      states[name] = { config, status: "offline" };
      continue;
    }

    // Fetch tool catalog
    const toolsResult = await client.toolsList(name);
    const catalog = {
      serverName: name,
      tools: toolsResult.tools,
      fetchedAt: new Date().toISOString(),
    };

    states[name] = { config, status: "connected", catalog };
  }

  return states;
}

export async function shutdownMcpServers(
  sessionNames: string[],
  client: McpcClient,
  closeOnExit: boolean,
): Promise<void> {
  if (!closeOnExit) return;

  await Promise.allSettled(
    sessionNames.map((name) => client.close(name)),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
