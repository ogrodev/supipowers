#!/usr/bin/env bun

import {
  intro,
  outro,
  confirm,
  multiselect,
  spinner,
  isCancel,
  cancel,
  note,
} from "@clack/prompts";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { scanAll, installDep, formatReport } from "../src/deps/registry.js";
import type { ExecResult } from "../src/platform/types.js";

// ── Helpers ──────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
);
const VERSION: string = pkg.version;

interface RunResult {
  stdout: string | null;
  stderr: string | null;
  status: number | null;
  error?: Error;
}

function run(cmd: string, args: string[], opts: Record<string, unknown> = {}): RunResult {
  return spawnSync(cmd, args, {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
    ...opts,
  }) as unknown as RunResult;
}

function bail(msg: string): never {
  cancel(msg);
  process.exit(1);
}

function findOmpBinary(): string | null {
  // Check PATH first
  const check = run("omp", ["--version"]);
  if (!check.error && check.status === 0) return "omp";

  // Fallback: check common bun global location
  const bunPath = join(homedir(), ".bun", "bin", "omp");
  if (existsSync(bunPath)) {
    const fallback = run(bunPath, ["--version"]);
    if (!fallback.error && fallback.status === 0) return bunPath;
  }

  return null;
}

function findPiBinary(): string | null {
  // Check PATH first
  const check = run("pi", ["--version"]);
  if (!check.error && check.status === 0) return "pi";

  // Fallback: check common npm/bun global locations
  for (const candidate of [
    join(homedir(), ".bun", "bin", "pi"),
    join(homedir(), ".npm-global", "bin", "pi"),
    "/usr/local/bin/pi",
    "/opt/homebrew/bin/pi",
  ]) {
    if (existsSync(candidate)) {
      const fallback = run(candidate, ["--version"]);
      if (!fallback.error && fallback.status === 0) return candidate;
    }
  }

  return null;
}

// ── Exec adapter for registry ────────────────────────────────

async function exec(cmd: string, args: string[]): Promise<ExecResult> {
  const r = run(cmd, args);
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

// ── CLI Flags ────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);
const skipDeps = cliArgs.includes("--skip-deps");

// ── Install to platform ──────────────────────────────────────

interface InstallTarget {
  name: string;
  dir: string;
}

/**
 * Install supipowers to a given platform directory (.pi or .omp).
 */
function installToPlatform(platformDir: string, packageRoot: string): string {
  const agentDir = join(homedir(), platformDir, "agent");
  const extDir = join(agentDir, "extensions", "supipowers");
  const installedPkgPath = join(extDir, "package.json");

  // Check for existing installation
  let installedVersion: string | null = null;
  if (existsSync(installedPkgPath)) {
    try {
      const installed = JSON.parse(readFileSync(installedPkgPath, "utf8"));
      installedVersion = installed.version;
    } catch {
      // corrupted package.json — treat as not installed
    }
  }

  if (installedVersion === VERSION) {
    note(
      `supipowers v${VERSION} is already installed and up to date.`,
      `Up to date (${platformDir})`,
    );
    return extDir;
  }

  const action = installedVersion ? "Updating" : "Installing";
  if (installedVersion) {
    note(`v${installedVersion} → v${VERSION}`, `Updating supipowers (${platformDir})`);
  }

  const s = spinner();
  s.start(`${action} supipowers to ~/${platformDir}/agent/...`);

  try {
    // Clean previous installation to remove stale files
    if (existsSync(extDir)) {
      rmSync(extDir, { recursive: true });
    }

    // Copy extension (src/ + bin/ + package.json) → ~/<platform>/agent/extensions/supipowers/
    mkdirSync(extDir, { recursive: true });
    cpSync(join(packageRoot, "src"), join(extDir, "src"), { recursive: true });
    cpSync(join(packageRoot, "bin"), join(extDir, "bin"), { recursive: true });
    cpSync(join(packageRoot, "package.json"), join(extDir, "package.json"));

    // Copy skills → ~/<platform>/agent/skills/<skillname>/SKILL.md
    const skillsSource = join(packageRoot, "skills");
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

    s.stop(
      installedVersion
        ? `supipowers updated to v${VERSION} (${platformDir})`
        : `supipowers v${VERSION} installed (${platformDir})`,
    );
  } catch (err: unknown) {
    s.stop(`${action} failed (${platformDir})`);
    const message = err instanceof Error ? err.message : `Failed to copy files to ~/${platformDir}/agent/`;
    bail(message);
  }

  return extDir;
}

/**
 * Install context-mode as a platform extension and register MCP server.
 *
 * Per upstream docs (Pi Coding Agent):
 *   1. git clone → ~/<platformDir>/extensions/context-mode
 *   2. npm install && npm run build
 *   3. Register MCP in ~/<platformDir>/settings/mcp.json
 *
 * Build requires Node.js 18+ (tsc, esbuild, node -e in build script).
 * Runtime uses bun to leverage bun:sqlite — context-mode auto-detects
 * Bun and skips better-sqlite3 entirely.
 */
async function installContextMode(platformDir: string): Promise<void> {
  const extDir = join(homedir(), platformDir, "extensions", "context-mode");
  const startMjs = join(extDir, "start.mjs");

  // Check if already installed and built
  if (existsSync(startMjs)) {
    // Already installed — just ensure MCP registration is up to date
    registerContextModeMcp(platformDir, startMjs);
    return;
  }

  const shouldInstall = await confirm({
    message: `Install context-mode extension for context window protection? (${platformDir})`,
  });
  if (isCancel(shouldInstall) || !shouldInstall) {
    note(
      `Skipped. You can install later:\n` +
        `  git clone https://github.com/mksglu/context-mode.git ~/${platformDir}/extensions/context-mode\n` +
        `  cd ~/${platformDir}/extensions/context-mode && npm install && npm run build`,
      `context-mode (${platformDir})`,
    );
    return;
  }

  // Check Node.js 18+ (required for build: tsc, esbuild, node -e in build script)
  const nodeCheck = run("node", ["--version"]);
  if (nodeCheck.error || nodeCheck.status !== 0) {
    note(
      "Node.js 18+ is required to build context-mode.\n" +
        "Install from https://nodejs.org then re-run the installer.",
      "context-mode requires Node.js",
    );
    return;
  }
  const nodeVersion = parseInt((nodeCheck.stdout ?? "").replace(/^v/, ""), 10);
  if (nodeVersion < 18) {
    note(
      `Found Node.js v${nodeCheck.stdout?.trim()} but context-mode requires v18+.\n` +
        "Update Node.js from https://nodejs.org then re-run the installer.",
      "context-mode requires Node.js 18+",
    );
    return;
  }

  const s = spinner();
  s.start(`Cloning context-mode to ~/${platformDir}/extensions/context-mode...`);

  // Clone
  const cloneResult = run("git", [
    "clone",
    "https://github.com/mksglu/context-mode.git",
    extDir,
  ]);
  if (cloneResult.status !== 0) {
    s.stop(`Failed to clone context-mode`);
    note(
      cloneResult.stderr?.trim() || "Unknown git clone error",
      "context-mode install failed",
    );
    return;
  }

  // npm install (builds better-sqlite3 native bindings for Node.js fallback;
  // at runtime under Bun, bun:sqlite is used instead via auto-detection)
  s.message("Installing context-mode dependencies...");
  const npmInstall = run("npm", ["install"], { cwd: extDir });
  if (npmInstall.status !== 0) {
    s.stop(`Failed to install context-mode dependencies`);
    note(
      npmInstall.stderr?.trim() || "Unknown npm install error",
      "context-mode install failed",
    );
    return;
  }

  // npm run build (requires tsc + esbuild from devDeps, runs under Node.js)
  s.message("Building context-mode...");
  const npmBuild = run("npm", ["run", "build"], { cwd: extDir });
  if (npmBuild.status !== 0) {
    s.stop(`Failed to build context-mode`);
    note(
      npmBuild.stderr?.trim() || "Unknown build error",
      "context-mode install failed",
    );
    return;
  }

  s.stop(`context-mode installed to ~/${platformDir}/extensions/context-mode`);

  // Register MCP server
  registerContextModeMcp(platformDir, startMjs);
}

/**
 * Register context-mode MCP entry in the platform's settings/mcp.json.
 *
 * Uses "bun" as the command so context-mode auto-detects Bun runtime
 * and uses bun:sqlite — no better-sqlite3 native bindings needed at runtime.
 */
function registerContextModeMcp(platformDir: string, startMjs: string): void {
  const mcpConfigPath = join(homedir(), platformDir, "settings", "mcp.json");
  let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  if (existsSync(mcpConfigPath)) {
    try {
      mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } catch {
      mcpConfig = { mcpServers: {} };
    }
  }

  mcpConfig.mcpServers["context-mode"] = {
    command: "bun",
    args: [startMjs],
  };

  mkdirSync(dirname(mcpConfigPath), { recursive: true });
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  note(
    `Registered in ~/${platformDir}/settings/mcp.json`,
    `context-mode (${platformDir})`,
  );
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  intro(`supipowers v${VERSION}`);

  // ── Step 1: Detect platforms ───────────────────────────────

  const detectSpinner = spinner();
  detectSpinner.start("Looking for Pi and OMP...");
  const piBin = findPiBinary();
  const ompBin = findOmpBinary();

  const piVer = piBin ? run(piBin, ["--version"]).stdout?.trim() || "unknown" : null;
  const ompVer = ompBin ? run(ompBin, ["--version"]).stdout?.trim() || "unknown" : null;

  const detected: string[] = [];
  if (piBin) detected.push(`Pi ${piVer}`);
  if (ompBin) detected.push(`OMP ${ompVer}`);
  detectSpinner.stop(
    detected.length ? `Detected: ${detected.join(", ")}` : "No agents found",
  );

  // ── Step 2: Determine install targets ─────────────────────

  let targets: InstallTarget[] = [];

  if (piBin && ompBin) {
    // Both found — let user pick
    const chosen = await multiselect({
      message: "Both Pi and OMP detected. Install supipowers to which?",
      options: [
        { value: { name: "Pi", dir: ".pi" }, label: `Pi (${piVer})`, hint: piBin },
        { value: { name: "OMP", dir: ".omp" }, label: `OMP (${ompVer})`, hint: ompBin },
      ],
      required: true,
    });
    if (isCancel(chosen)) bail("Installation cancelled.");
    targets = chosen as InstallTarget[];
  } else if (piBin) {
    // Only Pi found
    const ok = await confirm({ message: `Install supipowers to Pi (${piVer})?` });
    if (isCancel(ok) || !ok) bail("Installation cancelled.");
    targets = [{ name: "Pi", dir: ".pi" }];
  } else if (ompBin) {
    // Only OMP found
    const ok = await confirm({ message: `Install supipowers to OMP (${ompVer})?` });
    if (isCancel(ok) || !ok) bail("Installation cancelled.");
    targets = [{ name: "OMP", dir: ".omp" }];
  } else {
    // Neither found — offer to install Pi
    note(
      "Pi is an AI coding agent that supipowers extends.\n" +
        "It adds sub-agents, LSP integration, and plugin support.\n" +
        "Learn more: https://github.com/mariozechner/pi-coding-agent",
      "No agent found",
    );

    const shouldInstall = await confirm({ message: "Install Pi now via npm?" });
    if (isCancel(shouldInstall) || !shouldInstall) {
      bail("Cannot continue without Pi or OMP.");
    }

    const s = spinner();
    s.start("Installing Pi via npm...");
    const result = run("npm", ["install", "-g", "@mariozechner/pi-coding-agent"]);
    if (result.status !== 0) {
      s.stop("Pi installation failed");
      bail(result.stderr?.trim() || "Unknown error during Pi install.");
    }
    s.stop("Pi installed successfully");

    const newPiBin = findPiBinary();
    if (!newPiBin) {
      bail(
        "Pi was installed but the binary was not found in PATH. Try restarting your shell.",
      );
    }
    targets = [{ name: "Pi", dir: ".pi" }];
  }

  // ── Step 3: Install supipowers to each chosen target ──────

  const packageRoot = resolve(__dirname, "..");

  for (const target of targets) {
    installToPlatform(target.dir, packageRoot);

    // ── Step 3b: Install context-mode extension + register MCP ──
    await installContextMode(target.dir);
  }

  // ── Step 4: Unified dependency check (--skip-deps to skip) ──

  if (skipDeps) {
    note("Dependency check skipped (--skip-deps)", "Dependencies");
  } else {
    const depSpinner = spinner();
    depSpinner.start("Scanning dependencies...");

    const statuses = await scanAll(exec);

    const installedCount = statuses.filter((s) => s.installed).length;
    depSpinner.stop(
      `Found ${installedCount}/${statuses.length} dependencies installed`,
    );

    // Show required deps that are missing prominently
    const missingRequired = statuses.filter((s) => !s.installed && s.required);
    if (missingRequired.length > 0) {
      const requiredList = missingRequired
        .map((s) => `  ✗ ${s.name} — ${s.description} (${s.url})`)
        .join("\n");
      note(
        `The following required dependencies are missing:\n${requiredList}\n\nPlease install them manually before using supipowers.`,
        "Required dependencies missing",
      );
    }

    // Offer to install missing deps — let user choose which ones
    const installable = statuses.filter(
      (s) => !s.installed && s.installCmd !== null,
    );

    if (installable.length > 0) {
      const categoryLabels: Record<string, string> = {
        core: "Core",
        mcp: "MCP",
        lsp: "Language Server",
      };

      const selected = await multiselect({
        message: "Select tools to install (space to toggle, enter to confirm):",
        options: installable.map((s) => ({
          value: s.name,
          label: s.name,
          hint: `${categoryLabels[s.category] ?? s.category} — ${s.description}`,
        })),
        required: false,
      });

      if (!isCancel(selected) && (selected as string[]).length > 0) {
        const toInstall = installable.filter((s) =>
          (selected as string[]).includes(s.name),
        );
        for (const dep of toInstall) {
          const s = spinner();
          s.start(`Installing ${dep.name}...`);
          const result = await installDep(exec, dep.name);
          if (result.success) {
            s.stop(`${dep.name} installed`);
            // Update status in-place for the final report
            const statusEntry = statuses.find((st) => st.name === dep.name);
            if (statusEntry) statusEntry.installed = true;
          } else {
            s.stop(
              `Failed to install ${dep.name} — install manually: ${dep.installCmd}`,
            );
          }
        }
      }
    }

    // Final report for anything still missing
    const stillMissing = statuses.filter((s) => !s.installed);
    if (stillMissing.length > 0) {
      note(formatReport(statuses), "Dependency Status");
    }
  }

  // ── Done ───────────────────────────────────────────────────

  const targetNames = targets.map((t) => t.name.toLowerCase()).join(" or ");
  outro(`supipowers is ready! Run \`${targetNames}\` to start using it.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
