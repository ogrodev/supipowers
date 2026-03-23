// src/mcp/registry.ts — MCP server registry lookup via registry.modelcontextprotocol.io

type ExecFn = (cmd: string, args: string[], opts?: any) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface RegistryServer {
  name: string;
  title: string;
  description: string;
  url: string;
  transport: "http" | "stdio";
  authRequired: boolean;
  repoUrl?: string;
  docsUrl?: string;
}

interface RegistryRemote {
  type: string;
  url: string;
  headers?: Array<{ name: string; isRequired?: boolean }>;
}

interface RegistryEntry {
  server: {
    name: string;
    title?: string;
    description?: string;
    repository?: { url?: string };
    websiteUrl?: string;
    remotes?: RegistryRemote[];
  };
}

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io";

/**
 * Look up MCP servers by name from the official MCP registry.
 * Uses curl via exec — no web tools or Python needed.
 */
export async function lookupMcpServer(
  exec: ExecFn,
  query: string,
): Promise<RegistryServer[]> {
  const url = `${REGISTRY_BASE}/v0/servers?search=${encodeURIComponent(query)}&version=latest&limit=10`;

  const result = await exec("curl", ["-sf", "--max-time", "10", url]);
  if (result.code !== 0) return [];

  try {
    const data = JSON.parse(result.stdout);
    const entries: RegistryEntry[] = data.servers ?? data ?? [];
    return entries
      .filter((e) => e.server?.remotes?.length)
      .map((e) => parseRegistryEntry(e));
  } catch {
    return [];
  }
}

function parseRegistryEntry(entry: RegistryEntry): RegistryServer {
  const s = entry.server;
  const remote = s.remotes![0];
  const transport = remote.type === "stdio" ? "stdio" as const : "http" as const;
  const authRequired = remote.headers?.some((h) => h.isRequired) ?? false;

  return {
    name: s.name,
    title: s.title ?? s.name,
    description: s.description ?? "",
    url: remote.url,
    transport,
    authRequired,
    repoUrl: s.repository?.url,
    docsUrl: s.websiteUrl ?? s.repository?.url,
  };
}

/**
 * Find the best match for a given name from registry results.
 * Prefers exact name matches, then title matches, then substring.
 */
export function pickBestMatch(results: RegistryServer[], query: string): RegistryServer | undefined {
  const q = query.toLowerCase();

  // Exact name segment match (e.g., "figma" matches "com.figma.mcp/mcp")
  const exact = results.find((r) =>
    r.name.toLowerCase().split(/[./]/).some((seg) => seg === q)
  );
  if (exact) return exact;

  // Title contains query
  const titleMatch = results.find((r) =>
    r.title.toLowerCase().includes(q)
  );
  if (titleMatch) return titleMatch;

  // Any name contains query
  return results.find((r) => r.name.toLowerCase().includes(q));
}
