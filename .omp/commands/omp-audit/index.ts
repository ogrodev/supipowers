/**
 * /omp-audit — Analyze OMP runtime changelog for breaking changes and opportunities.
 *
 * Reads the installed OMP version, extracts changelog entries since the last audit,
 * scans the supipowers codebase for OMP API usage patterns, and returns a prompt
 * that instructs the LLM to produce a structured audit report.
 *
 * Config: .omp/omp-audit-config.json
 * Output: OMP_CHANGELOG_AUDIT.md (at repo root)
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

const CONFIG_FILENAME = "omp-audit-config.json";
const DEFAULT_OUTPUT = "OMP_CHANGELOG_AUDIT.md";

function configPath(cwd: string): string {
  return path.join(cwd, ".omp", CONFIG_FILENAME);
}

function readConfig(cwd: string): AuditConfig | null {
  const p = configPath(cwd);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as AuditConfig;
}

function writeConfig(cwd: string, config: AuditConfig): void {
  const p = configPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n");
}

// ── Version detection ───────────────────────────────────────────────────────

/**
 * Resolve the global OMP install directory by following the `omp` binary symlink.
 * Returns the pi-coding-agent package root, e.g.
 * ~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent
 */
function resolveOmpPackageDir(): string | null {
  try {
    const binPath = fs.realpathSync(path.join(
      path.dirname(process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, "bin", "omp") : "/usr/local/bin/omp"),
      "..",
    ));
    // realpathSync on `which omp` gives us the cli.ts entry point inside the package.
    // Walk up to find the package root.
    // Simpler: the binary is at <global>/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts
    // and the symlink lives at ~/.bun/bin/omp → that path. We can also just resolve
    // from the known global install layout.
  } catch {
    // fall through
  }

  // Direct resolution: follow the `omp` binary symlink to find the package root.
  const candidates = [
    process.env.BUN_INSTALL
      ? path.join(process.env.BUN_INSTALL, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent")
      : null,
    path.join(process.env.HOME ?? "", ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return null;
}

async function readOmpVersion(exec: CustomCommandAPI["exec"], cwd: string): Promise<string | null> {
  const result = await exec("omp", ["--version"], { cwd });
  if (result.code !== 0) return null;
  // Output format: "omp/14.1.2"
  const match = result.stdout.trim().match(/omp\/(.+)/);
  return match?.[1] ?? null;
}

function readSupipowersVersion(cwd: string): string {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return "unknown";
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return pkg.version ?? "unknown";
}

// ── Changelog parsing ───────────────────────────────────────────────────────

const VERSION_HEADER = /^## \[([^\]]+)\]/;

function parseChangelog(ompDir: string): Map<string, string> {
  const changelogPath = path.join(ompDir, "CHANGELOG.md")
  if (!fs.existsSync(changelogPath)) return new Map();

  const content = fs.readFileSync(changelogPath, "utf-8");
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
    if (version === "Unreleased") continue;
    // Include versions > fromVersion and <= toVersion
    if (compareSemver(version, fromVersion) > 0 && compareSemver(version, toVersion) <= 0) {
      relevant.push(content);
    }
  }

  // Changelog entries are in reverse chronological order (newest first). Keep that.
  return relevant.join("\n\n");
}

// ── Codebase scanning ───────────────────────────────────────────────────────

/** Grep for OMP API usage patterns in the supipowers src/ directory. */
async function scanCodebaseForOmpUsage(
  exec: CustomCommandAPI["exec"],
  cwd: string,
): Promise<string> {
  const patterns = [
    "createAgentSession",
    "sendMessage",
    "sendUserMessage",
    "registerCommand",
    "registerTool",
    "platform\\.on\\(",
    "platform\\.exec",
    "searchDb",
    "getActiveTools",
    "registerMessageRenderer",
    "deliverAs",
    "triggerTurn",
    "\\.capabilities",
    "createPaths",
  ];

  const results: string[] = [];

  for (const pattern of patterns) {
    const result = await exec("grep", ["-rn", pattern, "src/", "--include=*.ts", "-l"], {
      cwd,
    });
    if (result.code === 0 && result.stdout.trim()) {
      const files = result.stdout.trim().split("\n");
      results.push(`${pattern}: ${files.join(", ")}`);
    }
  }

  return results.length > 0 ? results.join("\n") : "No OMP API usage patterns found.";
}

// ── Prompt construction ─────────────────────────────────────────────────────

function buildAuditPrompt(opts: {
  fromVersion: string;
  toVersion: string;
  supipowersVersion: string;
  changelog: string;
  ompApiUsage: string;
  outputFile: string;
  configPath: string;
  today: string;
}): string {
  return `You are auditing the OMP (Oh My Pi) runtime changelog for the supipowers extension.

## Context

- **OMP version range:** ${opts.fromVersion} → ${opts.toVersion}
- **supipowers version:** ${opts.supipowersVersion}
- **Date:** ${opts.today}

## Changelog (${opts.fromVersion} → ${opts.toVersion})

${opts.changelog}

## supipowers OMP API usage

These are the OMP APIs our codebase currently uses (file paths where each pattern appears):

\`\`\`
${opts.ompApiUsage}
\`\`\`

## Instructions

Analyze the changelog above for impact on the supipowers extension. You MUST:

1. **Read the relevant source files** listed in the API usage section above to understand HOW we use each API. Do not guess from filenames alone.

2. **For each changelog entry**, determine:
   - Does it change an API we use? → Check the actual call sites.
   - Does it remove/rename something we depend on? → Check imports and references.
   - Does it add something we could benefit from? → Check if it solves a current pain point.

3. **Group findings into logical clusters** and use sub-agents (one for breaking changes, one for opportunities per cluster) to parallelize the analysis. Each sub-agent should read the actual source files and cite specific file paths and line numbers.

4. **Write the audit report** to \`${opts.outputFile}\` at the repo root with this structure:
   - Header with OMP version analyzed, audit date, supipowers version
   - Breaking Changes section (with evidence: file:line, impact, recommendation)
   - Opportunities section (with priority, effort, concrete implementation guidance)
   - Summary table

5. **Update the config file** at \`${opts.configPath}\` with:
   \`\`\`json
   {
     "lastAnalyzedVersion": "${opts.toVersion}",
     "supipowersVersionAtLastAudit": "${opts.supipowersVersion}",
     "lastAuditDate": "${opts.today}",
     "auditOutputFile": "${opts.outputFile}"
   }
   \`\`\`

Be thorough. False negatives (missed breaking changes) are worse than false positives. Cite evidence for every claim.`;
}

// ── Command ─────────────────────────────────────────────────────────────────

export default function ompAuditCommand(api: CustomCommandAPI): CustomCommand {
  return {
    name: "omp-audit",
    description: "Audit OMP runtime changelog for breaking changes and opportunities",
    async execute(args, ctx) {
      const cwd = api.cwd;
      const force = args.includes("--force");

      // 1. Get OMP version from the running binary
      const installedVersion = await readOmpVersion(api.exec, cwd);
      if (!installedVersion) {
        ctx.ui.notify("Could not determine OMP version. Is omp installed?", "error");
        return;
      }

      // 2. Resolve global OMP install for changelog access
      const ompDir = resolveOmpPackageDir();
      if (!ompDir) {
        ctx.ui.notify("Could not locate OMP global install. Expected ~/.bun/install/global/...", "error");
        return;
      }

      // 3. Read config
      const config = readConfig(cwd);
      const lastAnalyzed = config?.lastAnalyzedVersion ?? null;

      // 4. Check if already up to date
      if (lastAnalyzed === installedVersion && !force) {
        ctx.ui.notify(
          `Already audited OMP ${installedVersion}. Use /omp-audit --force to re-run.`,
          "info",
        );
        return;
      }

      // 5. Parse changelog and extract relevant range
      const entries = parseChangelog(ompDir);
      if (entries.size === 0) {
        ctx.ui.notify(`Could not find or parse CHANGELOG.md in ${ompDir}.`, "error");
        return;
      }

      const fromVersion = lastAnalyzed ?? "0.0.0";
      const changelog = extractChangelogRange(entries, fromVersion, installedVersion);

      if (!changelog && !force) {
        ctx.ui.notify(
          `No changelog entries found between ${fromVersion} and ${installedVersion}.`,
          "warning",
        );
        return;
      }

      // 5. Count versions in range
      let versionCount = 0;
      for (const [version] of entries) {
        if (version === "Unreleased") continue;
        if (
          compareSemver(version, fromVersion) > 0 &&
          compareSemver(version, installedVersion) <= 0
        ) {
          versionCount++;
        }
      }

      // 6. Confirm with user
      if (!ctx.hasUI) {
        ctx.ui.notify("omp-audit requires interactive mode.", "warning");
        return;
      }

      const label = lastAnalyzed
        ? `Audit OMP changelog: ${lastAnalyzed} → ${installedVersion} (${versionCount} versions)`
        : `First audit — analyzing OMP up to ${installedVersion} (${versionCount} versions)`;

      const confirmed = await ctx.ui.confirm("OMP Changelog Audit", label);
      if (!confirmed) return;

      // 7. Scan codebase for OMP API usage
      ctx.ui.notify("Scanning codebase for OMP API usage patterns...", "info");
      const ompApiUsage = await scanCodebaseForOmpUsage(api.exec, cwd);

      // 8. Build and return the prompt — triggers an LLM turn
      const supipowersVersion = readSupipowersVersion(cwd);
      const outputFile = config?.auditOutputFile ?? DEFAULT_OUTPUT;
      const today = new Date().toISOString().split("T")[0];

      ctx.ui.notify(
        `Auditing ${versionCount} OMP versions. The LLM will analyze and write ${outputFile}.`,
        "info",
      );

      return buildAuditPrompt({
        fromVersion,
        toVersion: installedVersion,
        supipowersVersion,
        changelog: changelog || "(No entries found — force run. Review the full changelog manually.)",
        ompApiUsage,
        outputFile,
        configPath: `.omp/${CONFIG_FILENAME}`,
        today,
      });
    },
  };
}
