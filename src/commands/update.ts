import type { Platform, PlatformContext } from "../platform/types.js";
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function handleUpdate(platform: Platform, ctx: PlatformContext): void {
  void (async () => {
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
      return;
    }
    const latestVersion = checkResult.stdout.trim();

    if (latestVersion === currentVersion) {
      ctx.ui.notify(`supipowers v${currentVersion} is already up to date`, "info");
      return;
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
        return;
      }

      const downloadedRoot = join(tempDir, "node_modules", "supipowers");
      if (!existsSync(downloadedRoot)) {
        ctx.ui.notify("Downloaded package not found", "error");
        return;
      }

      // Clean previous installation
      if (existsSync(extDir)) {
        rmSync(extDir, { recursive: true });
      }

      // Copy extension files
      mkdirSync(extDir, { recursive: true });
      cpSync(join(downloadedRoot, "src"), join(extDir, "src"), { recursive: true });
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

      ctx.ui.notify(`supipowers updated to v${latestVersion}`, "info");
    } finally {
      // Clean up temp directory
      try {
        rmSync(tempDir, { recursive: true });
      } catch {
        // best effort cleanup
      }
    }
  })();
}

export function registerUpdateCommand(platform: Platform): void {
  platform.registerCommand("supi:update", {
    description: "Update supipowers to the latest version",
    async handler(_args, ctx) {
      handleUpdate(platform, ctx);
    },
  });
}
