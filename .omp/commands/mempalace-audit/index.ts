/**
 * /mempalace-audit — Analyze the mempalace PyPI changelog for breaking
 * changes and opportunities since our pinned version.
 *
 * Reads `MEMPALACE_PACKAGE_VERSION` from src/mempalace/upstream-limits.ts,
 * queries PyPI for the latest release, fetches the upstream CHANGELOG.md
 * between the two, grep's the supipowers code for mempalace API usage,
 * and returns a prompt instructing the LLM to produce a structured audit.
 *
 * Config: .omp/mempalace-audit-config.json
 * Output: MEMPALACE_AUDIT.md (at repo root)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CustomCommandAPI, CustomCommand } from "@oh-my-pi/pi-coding-agent";

// ── Config ──────────────────────────────────────────────────────────────────

interface AuditConfig {
  lastAnalyzedVersion: string;
  supipowersVersionAtLastAudit: string;
  lastAuditDate: string;
  auditOutputFile: string;
}

const CONFIG_FILENAME = "mempalace-audit-config.json";
const DEFAULT_OUTPUT = "MEMPALACE_AUDIT.md";

/** GitHub raw CHANGELOG.md location for the official MemPalace package. */
const UPSTREAM_CHANGELOG_URL = "https://raw.githubusercontent.com/MemPalace/mempalace/main/CHANGELOG.md";

/** PyPI JSON API for release metadata. */
const PYPI_JSON_URL = "https://pypi.org/pypi/mempalace/json";

function configPath(cwd: string): string {
  return path.join(cwd, ".omp", CONFIG_FILENAME);
}

function readConfig(cwd: string): AuditConfig | null {
  const p = configPath(cwd);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as AuditConfig;
}

// ── Version detection ───────────────────────────────────────────────────────

/**
 * Read the pinned mempalace version from the canonical upstream-limits
 * module. Avoids importing TS at runtime: the file is small and the line
 * is stable (`export const MEMPALACE_PACKAGE_VERSION = "<version>";`).
 */
function readPinnedMempalaceVersion(cwd: string): string | null {
  const limitsPath = path.join(cwd, "src", "mempalace", "upstream-limits.ts");
  if (!fs.existsSync(limitsPath)) return null;
  const content = fs.readFileSync(limitsPath, "utf-8");
  const match = content.match(/MEMPALACE_PACKAGE_VERSION\s*=\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

function readSupipowersVersion(cwd: string): string {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return "unknown";
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return pkg.version ?? "unknown";
}

/**
 * Fetch the list of released mempalace versions from PyPI, newest last
 * (after sort). Returns null if the network is unavailable so the caller
 * can degrade gracefully.
 */
async function fetchPyPIReleases(): Promise<string[] | null> {
  try {
    const response = await fetch(PYPI_JSON_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { releases?: Record<string, unknown> };
    if (!payload.releases) return null;
    return Object.keys(payload.releases).sort(compareSemver);
  } catch {
    return null;
  }
}

async function fetchUpstreamChangelog(): Promise<string | null> {
  try {
    const response = await fetch(UPSTREAM_CHANGELOG_URL);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

// ── Changelog parsing ───────────────────────────────────────────────────────

/**
 * Match Keep-a-Changelog style version headers. MemPalace's CHANGELOG.md
 * uses `## [3.3.4] - 2026-04-15` style entries.
 */
const VERSION_HEADER = /^## \[([^\]]+)\]/;

function parseChangelog(content: string): Map<string, string> {
  const lines = content.split("\n");
  const entries = new Map<string, string>();

  let currentVersion: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(VERSION_HEADER);
    if (match) {
      if (currentVersion && currentLines.length > 0) {
        entries.set(currentVersion, currentLines.join("\n").trim());
      }
      currentVersion = match[1];
      currentLines = [line];
    } else if (currentVersion) {
      currentLines.push(line);
    }
  }
  if (currentVersion && currentLines.length > 0) {
    entries.set(currentVersion, currentLines.join("\n").trim());
  }

  return entries;
}

/** Compare two semver strings. Negative if a < b, positive if a > b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function extractChangelogRange(
  entries: Map<string, string>,
  fromVersion: string,
  toVersion: string,
): string {
  const relevant: string[] = [];
  for (const [version, content] of entries) {
    if (version.toLowerCase() === "unreleased") continue;
    if (compareSemver(version, fromVersion) > 0 && compareSemver(version, toVersion) <= 0) {
      relevant.push(content);
    }
  }
  // CHANGELOG entries are newest-first; preserve that ordering.
  return relevant.join("\n\n");
}

function countVersionsInRange(
  entries: Map<string, string>,
  fromVersion: string,
  toVersion: string,
): number {
  let n = 0;
  for (const [version] of entries) {
    if (version.toLowerCase() === "unreleased") continue;
    if (compareSemver(version, fromVersion) > 0 && compareSemver(version, toVersion) <= 0) {
      n++;
    }
  }
  return n;
}

// ── Codebase scanning ───────────────────────────────────────────────────────

/**
 * Grep for mempalace integration touchpoints. Patterns cover:
 * - Upstream API surface (tool_*, mempalace.layers/cli/mcp_server)
 * - Our pinned constants (MEMPALACE_MAX_*, MEMPALACE_PACKAGE_VERSION)
 * - Dispatch table actions in mempalace_bridge.py
 * - Configuration types and install paths
 */
async function scanCodebaseForMempalaceUsage(
  exec: CustomCommandAPI["exec"],
  cwd: string,
): Promise<string> {
  const patterns: Array<{ label: string; pattern: string; include: string }> = [
    { label: "Upstream MCP dispatch (tool_*)", pattern: "tool_(search|list_drawers|traverse_graph|kg_|diary_|add_drawer|update_drawer|delete_drawer|get_drawer|status|list_wings|list_rooms|get_taxonomy|check_duplicate|get_aaak_spec|find_tunnels|graph_stats|create_tunnel|list_tunnels|delete_tunnel|follow_tunnels|hook_settings|memories_filed_away|reconnect)", include: "*" },
    { label: "Python module imports", pattern: "mempalace\\.(mcp_server|layers|cli|config|searcher|palace_graph|query_sanitizer)", include: "*" },
    { label: "Pinned constants", pattern: "MEMPALACE_(PACKAGE_VERSION|MAX_RESULTS|MAX_QUERY_LENGTH|MAX_NAME_LENGTH|MAX_CONTENT_LENGTH|MAX_HOPS)", include: "*.ts" },
    { label: "PyPI install spec", pattern: "mempalace==", include: "*" },
    { label: "Action dispatch table", pattern: "MCP_TOOL_DISPATCH|CLI_DISPATCH", include: "*.py" },
    { label: "Tool action enum", pattern: "MEMPALACE_ACTIONS|MempalaceAction\\b", include: "*.ts" },
    { label: "Bridge entry point", pattern: "mempalace_bridge|resolveBridgeScriptPath", include: "*.ts" },
    { label: "MempalaceConfig type", pattern: "MempalaceConfig|ResolvedMempalaceConfig", include: "*.ts" },
    { label: "Sanitizer helpers", pattern: "sanitize_name|sanitize_kg_value|sanitize_content|sanitize_query", include: "*" },
    { label: "Collection name", pattern: "mempalace_drawers", include: "*" },
  ];

  const results: string[] = [];
  for (const { label, pattern, include } of patterns) {
    const result = await exec(
      "grep",
      ["-rnE", pattern, "src/", "tests/", `--include=${include}`, "-l"],
      { cwd },
    );
    if (result.code === 0 && result.stdout.trim()) {
      const files = Array.from(new Set(result.stdout.trim().split("\n"))).sort();
      results.push(`${label}\n  pattern: /${pattern}/\n  files:   ${files.join(", ")}`);
    }
  }

  return results.length > 0 ? results.join("\n\n") : "No mempalace usage patterns found.";
}

// ── Prompt construction ─────────────────────────────────────────────────────

function buildAuditPrompt(opts: {
  fromVersion: string;
  toVersion: string;
  latestPyPI: string | null;
  installedRange: string[];
  supipowersVersion: string;
  changelog: string;
  changelogSource: "github" | "missing";
  mempalaceUsage: string;
  outputFile: string;
  configPath: string;
  today: string;
}): string {
  const installedRangeText = opts.installedRange.length > 0
    ? opts.installedRange.join(", ")
    : "(unknown — PyPI unreachable)";
  const changelogBlock = opts.changelog
    ? opts.changelog
    : "(CHANGELOG fetch from upstream GitHub failed — analyze the upstream-limits.ts constants and bridge dispatch surface manually, then ask the user to re-run with network access.)";

  return `You are auditing the upstream \`mempalace\` PyPI package for impact on the supipowers extension.

## Context

- **Pinned mempalace version (this repo):** ${opts.fromVersion}  (source: \`src/mempalace/upstream-limits.ts\`)
- **Latest mempalace release on PyPI:** ${opts.latestPyPI ?? "(PyPI unreachable)"}
- **Audit range:** ${opts.fromVersion} → ${opts.toVersion}
- **Released versions in range:** ${installedRangeText}
- **supipowers version:** ${opts.supipowersVersion}
- **Date:** ${opts.today}

## Upstream CHANGELOG (${opts.fromVersion} → ${opts.toVersion})

Source: ${opts.changelogSource === "github" ? UPSTREAM_CHANGELOG_URL : "(unavailable)"}

${changelogBlock}

## supipowers mempalace integration surface

These are the files and patterns the supipowers integration uses today. Read each
referenced file before concluding that an upstream change is safe.

\`\`\`
${opts.mempalaceUsage}
\`\`\`

## Instructions

You are deciding whether bumping \`MEMPALACE_PACKAGE_VERSION\` in
\`src/mempalace/upstream-limits.ts\` from ${opts.fromVersion} to ${opts.toVersion}
is safe, and what would have to change. You MUST:

1. **Read every file** in the integration surface above before making claims
   about its current behavior. Do not guess from filenames.

2. **For each changelog entry**, classify it as:
   - **Breaking:** removes/renames a symbol, function, action, or constant we
     reference; changes a tool's parameter contract; alters a default we depend
     on. Trace it to a concrete file and line in our integration.
   - **Opportunity:** adds a capability that obsoletes a workaround we have,
     improves a budget we currently set defensively, or unlocks a feature we
     would adopt. Cite the workaround.
   - **No-impact:** doc-only, internal refactor, or touches an area we do not
     consume. State why.

3. **Re-verify the pinned MEMPALACE_MAX_* constants** in
   \`src/mempalace/upstream-limits.ts\` against the bumped upstream source. If
   any drifted, list the exact new value and the file/line in upstream that
   proves it. Use the cited source path inside each constant's JSDoc as the
   reference target.

4. **Verify the bridge dispatch table** in
   \`src/mempalace/python/mempalace_bridge.py\` (\`MCP_TOOL_DISPATCH\` and
   \`CLI_DISPATCH\`). If upstream renamed a \`tool_*\` function, dropped one,
   or changed kwargs, our dispatch will silently break. Each entry must still
   resolve in the bumped upstream.

5. **Group findings into clusters** and spawn sub-agents (one per cluster) to
   parallelize. Each sub-agent reads the actual source and cites file:line.

6. **Write the audit report** to \`${opts.outputFile}\` at the repo root with:
   - Header with version range, audit date, supipowers version
   - Executive summary (one paragraph + bullet list of verified non-impacts)
   - Breaking Changes section (one entry per breaking change, with evidence,
     impact on a specific file/line in our code, and recommendation)
   - Opportunities section (priority, effort estimate, implementation sketch)
   - Constants drift table (each MEMPALACE_MAX_* with current vs upstream value)
   - Bump plan: ordered checklist that, when followed, leaves \`bun ci\` green

7. **Update the audit config** at \`${opts.configPath}\` with:
   \`\`\`json
   {
     "lastAnalyzedVersion": "${opts.toVersion}",
     "supipowersVersionAtLastAudit": "${opts.supipowersVersion}",
     "lastAuditDate": "${opts.today}",
     "auditOutputFile": "${opts.outputFile}"
   }
   \`\`\`

Be thorough. A missed breaking change here means a silent regression in
production memory recall. Cite evidence for every claim.`;
}

// ── Command ─────────────────────────────────────────────────────────────────

export default function mempalaceAuditCommand(api: CustomCommandAPI): CustomCommand {
  return {
    name: "mempalace-audit",
    description: "Audit upstream mempalace releases for impact on the supipowers integration",
    async execute(args, ctx) {
      const cwd = api.cwd;
      const force = args.includes("--force");

      // 1. Read our pin
      const pinnedVersion = readPinnedMempalaceVersion(cwd);
      if (!pinnedVersion) {
        ctx.ui.notify(
          "Could not read MEMPALACE_PACKAGE_VERSION from src/mempalace/upstream-limits.ts.",
          "error",
        );
        return;
      }

      // 2. Query PyPI for the latest release (network — best effort)
      ctx.ui.notify("Querying PyPI for mempalace releases...", "info");
      const pypiVersions = await fetchPyPIReleases();
      const latestPyPI = pypiVersions ? pypiVersions[pypiVersions.length - 1] : null;

      // Audit target: the latest PyPI release (or the pin itself if PyPI is
      // unreachable — degenerates to "audit what's already on disk").
      const toVersion = latestPyPI ?? pinnedVersion;

      // 3. Read prior audit config
      const config = readConfig(cwd);
      const lastAnalyzed = config?.lastAnalyzedVersion ?? null;

      // The "from" version is whichever is newer: the prior audit baseline
      // or our current pin. We never re-audit ground already covered.
      const fromVersion = lastAnalyzed && compareSemver(lastAnalyzed, pinnedVersion) > 0
        ? lastAnalyzed
        : pinnedVersion;

      if (compareSemver(fromVersion, toVersion) >= 0 && !force) {
        ctx.ui.notify(
          `mempalace pin ${pinnedVersion} is already at-or-ahead of ${toVersion} (PyPI latest). Use --force to re-audit.`,
          "info",
        );
        return;
      }

      // 4. Fetch upstream CHANGELOG (network — best effort)
      ctx.ui.notify("Fetching upstream CHANGELOG from GitHub...", "info");
      const rawChangelog = await fetchUpstreamChangelog();
      const entries = rawChangelog ? parseChangelog(rawChangelog) : new Map<string, string>();
      const changelog = entries.size > 0 ? extractChangelogRange(entries, fromVersion, toVersion) : "";
      const versionsInRange = entries.size > 0 ? countVersionsInRange(entries, fromVersion, toVersion) : 0;
      const installedRange = pypiVersions
        ? pypiVersions.filter(
            (v) => compareSemver(v, fromVersion) > 0 && compareSemver(v, toVersion) <= 0,
          )
        : [];

      // 5. Confirm with the user (interactive only)
      if (!ctx.hasUI) {
        ctx.ui.notify("mempalace-audit requires interactive mode.", "warning");
        return;
      }

      const versionLabel = versionsInRange > 0
        ? `${versionsInRange} versions with changelog entries`
        : entries.size === 0
          ? "CHANGELOG unavailable"
          : "no changelog entries in range";
      const confirmLabel = lastAnalyzed
        ? `Audit mempalace: ${fromVersion} → ${toVersion} (${versionLabel})`
        : `First mempalace audit: pin ${pinnedVersion} vs latest ${toVersion} (${versionLabel})`;

      const confirmed = await ctx.ui.confirm("mempalace Audit", confirmLabel);
      if (!confirmed) return;

      // 6. Scan codebase
      ctx.ui.notify("Scanning supipowers for mempalace integration touchpoints...", "info");
      const mempalaceUsage = await scanCodebaseForMempalaceUsage(api.exec, cwd);

      // 7. Build prompt
      const supipowersVersion = readSupipowersVersion(cwd);
      const outputFile = config?.auditOutputFile ?? DEFAULT_OUTPUT;
      const today = new Date().toISOString().split("T")[0];

      ctx.ui.notify(
        `Auditing mempalace ${fromVersion} → ${toVersion}. The LLM will analyze and write ${outputFile}.`,
        "info",
      );

      return buildAuditPrompt({
        fromVersion,
        toVersion,
        latestPyPI,
        installedRange,
        supipowersVersion,
        changelog,
        changelogSource: entries.size > 0 ? "github" : "missing",
        mempalaceUsage,
        outputFile,
        configPath: `.omp/${CONFIG_FILENAME}`,
        today,
      });
    },
  };
}
