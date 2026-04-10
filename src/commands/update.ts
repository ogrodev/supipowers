import type { Platform, PlatformContext } from "../platform/types.js";
import type { DependencyStatus, InstallResult } from "../deps/registry.js";
import { scanAll, installAll, formatReport } from "../deps/registry.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// ── Options builder ──────────────────────────────────────

export function buildUpdateOptions(missing: DependencyStatus[]): string[] {
  const installable = missing.filter((d) => d.installCmd !== null);
  const missingLabel =
    installable.length > 0
      ? `Update supipowers + install missing tools (${installable.length} missing)`
      : "Update supipowers + install missing tools (all installed)";

  return [
    "Update supipowers only",
    missingLabel,
    "Update supipowers + reinstall all tools (latest)",
    "Cancel",
  ];
}

// ── Core update logic (preserved from original) ─────────

interface UpdateSupipowersResult {
  updated: boolean;
  fromVersion: string;
  toVersion: string;
}

async function updateSupipowers(
  platform: Platform,
  ctx: PlatformContext,
): Promise<UpdateSupipowersResult | null> {
  const agentDir = platform.paths.agent();
  const extDir = join(agentDir, "extensions", "supipowers");
  const installedPkgPath = join(extDir, "package.json");

  // Get current installed version
  let currentVersion = "unknown";
  if (existsSync(installedPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(installedPkgPath, "utf8"));
      currentVersion = pkg.version;
    } catch {
      // corrupted — will update anyway
    }
  }

  ctx.ui.notify(`Current version: v${currentVersion}`, "info");

  // Check latest version on npm
  const checkResult = await platform.exec("npm", ["view", "supipowers", "version"], { cwd: tmpdir() });
  if (checkResult.code !== 0) {
    ctx.ui.notify("Failed to check for updates — npm view failed", "error");
    return null;
  }
  const latestVersion = checkResult.stdout.trim();

  if (latestVersion === currentVersion) {
    ctx.ui.notify(`supipowers v${currentVersion} is already up to date`, "info");
    return { updated: false, fromVersion: currentVersion, toVersion: currentVersion };
  }

  ctx.ui.notify(`Updating v${currentVersion} → v${latestVersion}...`, "info");

  // Download latest to a temp directory
  const tempDir = join(tmpdir(), `supipowers-update-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    const installResult = await platform.exec(
      "npm", ["install", "--prefix", tempDir, `supipowers@${latestVersion}`],
      { cwd: tempDir },
    );
    if (installResult.code !== 0) {
      ctx.ui.notify("Failed to download latest version", "error");
      return null;
    }

    const downloadedRoot = join(tempDir, "node_modules", "supipowers");
    if (!existsSync(downloadedRoot)) {
      ctx.ui.notify("Downloaded package not found", "error");
      return null;
    }

    // Clean previous installation
    if (existsSync(extDir)) {
      rmSync(extDir, { recursive: true });
    }

    // Copy extension files
    mkdirSync(extDir, { recursive: true });
    cpSync(join(downloadedRoot, "src"), join(extDir, "src"), { recursive: true });
    const binSource = join(downloadedRoot, "bin");
    if (existsSync(binSource)) {
      cpSync(binSource, join(extDir, "bin"), { recursive: true });
    }
    cpSync(join(downloadedRoot, "package.json"), join(extDir, "package.json"));

    // Copy skills
    const skillsSource = join(downloadedRoot, "skills");
    if (existsSync(skillsSource)) {
      const skillDirs = readdirSync(skillsSource, { withFileTypes: true });
      for (const entry of skillDirs) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(skillsSource, entry.name, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        const destDir = join(agentDir, "skills", entry.name);
        mkdirSync(destDir, { recursive: true });
        cpSync(skillFile, join(destDir, "SKILL.md"));
      }
    }

    // Clean up legacy MCP entries and re-register with current name
    cleanupLegacyMcp(agentDir);

    ctx.ui.notify(`supipowers updated to v${latestVersion}`, "info");
    return { updated: true, fromVersion: currentVersion, toVersion: latestVersion };
  } finally {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // best effort cleanup
    }
  }
}

// ── TUI handler ──────────────────────────────────────────

export function handleUpdate(platform: Platform, ctx: PlatformContext): void {
  void (async () => {
    const exec = (cmd: string, args: string[]) => platform.exec(cmd, args);

    // 1. Scan all dependencies
    const allStatuses = await scanAll(exec);
    const missing = allStatuses.filter((s) => !s.installed);

    // 2. Present mode selection
    const options = buildUpdateOptions(missing);
    const choice = await ctx.ui.select("Update supipowers", options);

    // 3. Cancel / Esc
    if (!choice || choice === "Cancel") return;

    // 4. Update supipowers files
    const updateResult = await updateSupipowers(platform, ctx);
    if (!updateResult) return;

    // 5. Based on mode, install tools
    let installResults: InstallResult[] | undefined;
    if (choice.startsWith("Update supipowers + install missing")) {
      const installable = missing.filter((d) => d.installCmd !== null);
      if (installable.length > 0) {
        ctx.ui.notify(`Installing ${installable.length} missing tool(s)...`, "info");
        installResults = await installAll(exec, installable);
      }
    } else if (choice.startsWith("Update supipowers + reinstall all")) {
      const allInstallable = allStatuses.filter((d) => d.installCmd !== null);
      ctx.ui.notify(`Reinstalling ${allInstallable.length} tool(s)...`, "info");
      installResults = await installAll(exec, allInstallable);
    }

    // 6. Re-scan and show report
    const finalStatuses = await scanAll(exec);
    const report = formatReport(finalStatuses, installResults);
    const supiLine = updateResult.updated
      ? `supipowers: v${updateResult.fromVersion} → v${updateResult.toVersion}`
      : `supipowers: v${updateResult.fromVersion} (already up to date)`;
    ctx.ui.notify(`${supiLine}\n${report}`, "info");

    if (updateResult.updated) {
      ctx.ui.notify(
        "Please restart your agent session for the update to take effect.",
        "warning",
      );
    }
  })();
}

// ── Legacy cleanup ───────────────────────────────────────

/**
 * Remove stale MCP artifacts from pre-v0.5.x installs and re-register
 * the supi-context-mode server under the correct name and path.
 *
 * Handles:
 *  1. Old "context-mode" key in agent/mcp.json (renamed to "supi-context-mode")
 *  2. Old settings/mcp.json file (wrong path — should be agent/mcp.json)
 *  3. Re-registration of supi-context-mode with the wrapper entry point
 */
function cleanupLegacyMcp(agentDir: string): void {
  const mcpConfigPath = join(agentDir, "mcp.json");

  // Re-register supi-context-mode and remove old "context-mode" key
  if (existsSync(mcpConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
      if (config.mcpServers) {
        delete config.mcpServers["context-mode"];

        // Re-register with wrapper if context-mode extension is installed
        const platformRoot = dirname(agentDir);
        const startMjs = join(platformRoot, "extensions", "context-mode", "start.mjs");
        if (existsSync(startMjs)) {
          const wrapperMjs = join(agentDir, "extensions", "supipowers", "bin", "ctx-mode-wrapper.mjs");
          const args = existsSync(wrapperMjs) ? [wrapperMjs, startMjs] : [startMjs];
          config.mcpServers["supi-context-mode"] = { command: "bun", args };
        }

        writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
      }
    } catch {
      // Corrupted mcp.json — leave it for the user
    }
  }

  // Remove old settings/mcp.json from pre-v0.5.x installs (wrong path)
  const platformRoot = dirname(agentDir);
  const oldMcpPath = join(platformRoot, "settings", "mcp.json");
  if (!existsSync(oldMcpPath)) return;

  try {
    const config = JSON.parse(readFileSync(oldMcpPath, "utf8"));
    delete config.mcpServers?.["context-mode"];
    delete config.mcpServers?.["supi-context-mode"];

    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
      rmSync(oldMcpPath);
    } else {
      writeFileSync(oldMcpPath, JSON.stringify(config, null, 2));
    }
  } catch {
    try { rmSync(oldMcpPath); } catch { /* best effort */ }
  }
}

// ── Command registration ─────────────────────────────────

export function registerUpdateCommand(platform: Platform): void {
  platform.registerCommand("supi:update", {
    description: "Update supipowers to the latest version",
    async handler(_args: string | undefined, ctx: any) {
      handleUpdate(platform, ctx);
    },
  });
}
