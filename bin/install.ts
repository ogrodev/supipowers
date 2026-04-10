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
  appendFileSync,
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

const isWindows = process.platform === "win32";

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
    shell: isWindows,
    ...opts,
  }) as unknown as RunResult;
}

function bail(msg: string): never {
  cancel(msg);
  process.exit(1);
}

function findOmpBinary(): string | null {
  // Check PATH first (shell: true in run() resolves .cmd shims on Windows)
  const check = run("omp", ["--version"]);
  if (!check.error && check.status === 0) return "omp";

  // Fallback: check common global locations
  const candidates = [
    join(homedir(), ".bun", "bin", "omp"),
  ];
  if (isWindows) {
    // Bun on Windows installs .exe binaries
    candidates.push(join(homedir(), ".bun", "bin", "omp.exe"));
    // npm globals on Windows
    const appData = process.env.APPDATA;
    if (appData) candidates.push(join(appData, "npm", "omp.cmd"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const fallback = run(candidate, ["--version"]);
      if (!fallback.error && fallback.status === 0) return candidate;
    }
  }

  return null;
}

function findPiBinary(): string | null {
  // Check PATH first (shell: true in run() resolves .cmd shims on Windows)
  const check = run("pi", ["--version"]);
  if (!check.error && check.status === 0) return "pi";

  // Fallback: check common global locations
  const candidates: string[] = [];
  if (isWindows) {
    candidates.push(join(homedir(), ".bun", "bin", "pi.exe"));
    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(join(appData, "npm", "pi.cmd"));
      candidates.push(join(appData, "npm", "pi"));
    }
  } else {
    candidates.push(
      join(homedir(), ".bun", "bin", "pi"),
      join(homedir(), ".npm-global", "bin", "pi"),
      "/usr/local/bin/pi",
      "/opt/homebrew/bin/pi",
    );
  }
  for (const candidate of candidates) {
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

// ── CLI Flags ────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);
const skipDeps = cliArgs.includes("--skip-deps");
const FORCE = cliArgs.includes("--force");
const DEBUG = cliArgs.includes("--debug");

// ── Debug logging ────────────────────────────────────────────────

const LOG_FILE = resolve(process.cwd(), "supipowers-install.log");

function log(msg: string): void {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFileSync(LOG_FILE, line);
}

if (DEBUG) {
  // Start fresh log
  writeFileSync(LOG_FILE, `supipowers installer debug log\n`);
  log(`platform: ${process.platform}`);
  log(`arch: ${process.arch}`);
  log(`bun: ${process.versions?.bun ?? "N/A"}`);
  log(`node: ${process.version}`);
  log(`cwd: ${process.cwd()}`);
  log(`homedir: ${homedir()}`);
  log(`argv: ${JSON.stringify(process.argv)}`);
  log(`__dirname: ${__dirname}`);
  log(`packageRoot will be: ${resolve(__dirname, "..")}`);
  log(`isWindows: ${isWindows}`);
}

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

  log(`installToPlatform(platformDir=${platformDir}, packageRoot=${packageRoot})`);
  log(`  agentDir: ${agentDir}`);
  log(`  extDir:   ${extDir}`);

  // Check for existing installation
  let installedVersion: string | null = null;
  if (existsSync(installedPkgPath)) {
    try {
      const installed = JSON.parse(readFileSync(installedPkgPath, "utf8"));
      installedVersion = installed.version;
      log(`  existing version: ${installedVersion}`);
    } catch {
      log(`  existing package.json corrupted, treating as fresh install`);
    }
  } else {
    log(`  no existing installation found`);
  }

  const hasNodeModules = existsSync(join(extDir, "node_modules"));
  log(`  node_modules present: ${hasNodeModules}`);

  if (installedVersion === VERSION && hasNodeModules && !FORCE) {
    log(`  already up to date with deps, skipping`);
    note(
      `supipowers v${VERSION} is already installed and up to date.`,
      `Up to date (${platformDir})`,
    );
    return extDir;
  }

  if (installedVersion === VERSION && !hasNodeModules) {
    log(`  same version but node_modules missing — reinstalling deps`);
  }
  if (FORCE) {
    log(`  --force flag set, reinstalling`);
  }

  const action = installedVersion ? "Updating" : "Installing";
  if (installedVersion) {
    note(`v${installedVersion} \u2192 v${VERSION}`, `Updating supipowers (${platformDir})`);
  }

  const s = spinner();
  s.start(`${action} supipowers to ~/${platformDir}/agent/...`);

  try {
    // Clean previous installation to remove stale files
    if (existsSync(extDir)) {
      log(`  removing old extDir`);
      rmSync(extDir, { recursive: true });
    }

    // Copy extension (src/ + bin/ + package.json) \u2192 ~/<platform>/agent/extensions/supipowers/
    log(`  creating extDir and copying files`);
    mkdirSync(extDir, { recursive: true });
    cpSync(join(packageRoot, "src"), join(extDir, "src"), { recursive: true });
    cpSync(join(packageRoot, "bin"), join(extDir, "bin"), { recursive: true });
    cpSync(join(packageRoot, "package.json"), join(extDir, "package.json"));
    log(`  files copied to ${extDir}`);

    // Rewrite package.json for the installed extension.
    // The npm-published package.json has bin, scripts, prepare, devDeps —
    // all of which cause problems during `bun install` in the extension dir.
    // We keep only what OMP needs (omp.extensions) and the runtime dependencies.
    const sourcePkg = JSON.parse(readFileSync(join(extDir, "package.json"), "utf8"));
    const runtimePkg = {
      name: sourcePkg.name,
      version: sourcePkg.version,
      type: sourcePkg.type,
      omp: sourcePkg.omp,
      dependencies: {
        // Only packages imported at runtime by src/ code:
        // - config/schema.ts → @sinclair/typebox
        // - commands/model.ts, model-picker.ts → @oh-my-pi/pi-ai
        // - commands/model-picker.ts → @oh-my-pi/pi-tui
        "@sinclair/typebox": "*",
        "@oh-my-pi/pi-ai": "*",
        "@oh-my-pi/pi-tui": "*",
      },
    };
    writeFileSync(join(extDir, "package.json"), JSON.stringify(runtimePkg, null, 2));
    log(`  rewrote package.json: ${JSON.stringify(runtimePkg, null, 2)}`);

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

    // Install runtime dependencies so the extension's imports resolve.
    // Without node_modules/, external imports (@sinclair/typebox, @oh-my-pi/*)
    // fail on systems where these packages aren't in Bun's global install.
    log(`  running: bun install (cwd=${extDir})`);
    s.message("Installing extension dependencies...");
    const install = run("bun", ["install"], { cwd: extDir });
    log(`  bun install exit code: ${install.status}`);
    log(`  bun install stdout: ${install.stdout ?? "(null)"}`);
    log(`  bun install stderr: ${install.stderr ?? "(null)"}`);
    if (install.error) log(`  bun install error: ${install.error.message}`);
    if (install.status !== 0) {
      // Non-fatal: the extension may still work if OMP provides the deps
      // via its own module resolution (e.g. Bun global install on macOS).
      note(
        "Could not install extension dependencies.\n" +
          "If /supi commands don't appear in OMP, run:\n" +
          `  cd ~/${platformDir}/agent/extensions/supipowers && bun install`,
        "Warning",
      );
    }

    // Verify node_modules was created
    const nmExists = existsSync(join(extDir, "node_modules"));
    log(`  node_modules exists after install: ${nmExists}`);
    if (nmExists) {
      try {
        const nmContents = readdirSync(join(extDir, "node_modules"));
        log(`  node_modules top-level: ${nmContents.join(", ")}`);
      } catch { /* ignore */ }
    }

    s.stop(
      installedVersion
        ? `supipowers updated to v${VERSION} (${platformDir})`
        : `supipowers v${VERSION} installed (${platformDir})`,
    );
  } catch (err: unknown) {
    log(`  installToPlatform FAILED: ${err instanceof Error ? err.stack : String(err)}`);
    s.stop(`${action} failed (${platformDir})`);
    const message = err instanceof Error ? err.message : `Failed to copy files to ~/${platformDir}/agent/`;
    bail(message);
  }

  return extDir;
}

/**
 * Install supi-context-mode as a platform extension and register MCP server.
 *
 * Per upstream docs (Pi Coding Agent):
 *   1. git clone → ~/<platformDir>/extensions/context-mode
 *   2. npm install && npm run build
 *   3. Register MCP in ~/<platformDir>/agent/mcp.json
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
    message: `Install supi-context-mode extension for context window protection? (${platformDir})`,
  });
  if (isCancel(shouldInstall) || !shouldInstall) {
    note(
      `Skipped. You can install later:\n` +
        `  git clone https://github.com/mksglu/context-mode.git ~/${platformDir}/extensions/context-mode\n` +
        `  cd ~/${platformDir}/extensions/context-mode && npm install && npm run build`,
      `supi-context-mode (${platformDir})`,
    );
    return;
  }

  // Check Node.js 18+ (required for build: tsc, esbuild, node -e in build script)
  const nodeCheck = run("node", ["--version"]);
  if (nodeCheck.error || nodeCheck.status !== 0) {
    note(
      "Node.js 18+ is required to build supi-context-mode.\n" +
        "Install from https://nodejs.org then re-run the installer.",
      "supi-context-mode requires Node.js",
    );
    return;
  }
  const nodeVersion = parseInt((nodeCheck.stdout ?? "").replace(/^v/, ""), 10);
  if (nodeVersion < 18) {
    note(
      `Found Node.js v${nodeCheck.stdout?.trim()} but supi-context-mode requires v18+.\n` +
        "Update Node.js from https://nodejs.org then re-run the installer.",
      "supi-context-mode requires Node.js 18+",
    );
    return;
  }

  const s = spinner();
  s.start(`Cloning supi-context-mode to ~/${platformDir}/extensions/context-mode...`);

  // Clone
  const cloneResult = run("git", [
    "clone",
    "https://github.com/mksglu/context-mode.git",
    extDir,
  ]);
  if (cloneResult.status !== 0) {
    s.stop(`Failed to clone supi-context-mode`);
    note(
      cloneResult.stderr?.trim() || "Unknown git clone error",
      "supi-context-mode install failed",
    );
    return;
  }

  // npm install (builds better-sqlite3 native bindings for Node.js fallback;
  // at runtime under Bun, bun:sqlite is used instead via auto-detection)
  s.message("Installing supi-context-mode dependencies...");
  const npmInstall = run("npm", ["install"], { cwd: extDir });
  if (npmInstall.status !== 0) {
    s.stop(`Failed to install supi-context-mode dependencies`);
    note(
      npmInstall.stderr?.trim() || "Unknown npm install error",
      "supi-context-mode install failed",
    );
    return;
  }

  // npm run build (requires tsc + esbuild from devDeps, runs under Node.js)
  s.message("Building supi-context-mode...");
  const npmBuild = run("npm", ["run", "build"], { cwd: extDir });
  if (npmBuild.status !== 0) {
    s.stop(`Failed to build supi-context-mode`);
    note(
      npmBuild.stderr?.trim() || "Unknown build error",
      "supi-context-mode install failed",
    );
    return;
  }

  s.stop(`supi-context-mode installed to ~/${platformDir}/extensions/context-mode`);

  // Register MCP server
  registerContextModeMcp(platformDir, startMjs);
}

/**
 * Register supi-context-mode MCP entry in the platform's agent/mcp.json.
 *
 * Uses "bun" as the command so context-mode auto-detects Bun runtime
 * and uses bun:sqlite — no better-sqlite3 native bindings needed at runtime.
 *
 * When the supipowers wrapper is available, uses it as entry point to preserve
 * the project directory and write routing rules to .omp/APPEND_SYSTEM.md.
 */
function registerContextModeMcp(platformDir: string, startMjs: string): void {
  const mcpConfigPath = join(homedir(), platformDir, "agent", "mcp.json");
  let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  if (existsSync(mcpConfigPath)) {
    try {
      mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } catch {
      mcpConfig = { mcpServers: {} };
    }
  }

  // Use the wrapper to preserve project directory and inject routing rules;
  // fall back to direct start.mjs if supipowers was removed but supi-context-mode remains
  const wrapperMjs = join(
    homedir(), platformDir, "agent", "extensions", "supipowers", "bin", "ctx-mode-wrapper.mjs",
  );
  const args = existsSync(wrapperMjs) ? [wrapperMjs, startMjs] : [startMjs];

  // Remove legacy "context-mode" entry (renamed to "supi-context-mode" in v0.5.x)
  delete mcpConfig.mcpServers["context-mode"];

  mcpConfig.mcpServers["supi-context-mode"] = {
    command: "bun",
    args,
  };

  mkdirSync(dirname(mcpConfigPath), { recursive: true });
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  note(
    `Registered in ~/${platformDir}/agent/mcp.json`,
    `supi-context-mode (${platformDir})`,
  );

  cleanupLegacyMcp(platformDir);
}

/**
 * Remove stale MCP artifacts from pre-v0.5.x installs.
 *
 * Before the path fix, the installer wrote to ~/<platformDir>/settings/mcp.json
 * instead of ~/<platformDir>/agent/mcp.json. Clean up both the old file and any
 * leftover "context-mode" key (now "supi-context-mode").
 */
function cleanupLegacyMcp(platformDir: string): void {
  const oldMcpPath = join(homedir(), platformDir, "settings", "mcp.json");
  if (!existsSync(oldMcpPath)) return;

  try {
    const config = JSON.parse(readFileSync(oldMcpPath, "utf8"));
    delete config.mcpServers?.["context-mode"];
    delete config.mcpServers?.["supi-context-mode"];

    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
      rmSync(oldMcpPath);
    } else {
      // Other servers exist — keep the file, just remove our entries
      writeFileSync(oldMcpPath, JSON.stringify(config, null, 2));
    }
  } catch {
    // Corrupted — remove it
    try { rmSync(oldMcpPath); } catch { /* best effort */ }
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  intro(`supipowers v${VERSION}`);

  // ── Step 1: Detect platforms ───────────────────────────────

  const detectSpinner = spinner();
  detectSpinner.start("Looking for Pi and OMP...");
  const piBin = findPiBinary();
  const ompBin = findOmpBinary();

  log(`findPiBinary() => ${piBin ?? "null"}`);
  log(`findOmpBinary() => ${ompBin ?? "null"}`);

  const piVer = piBin ? run(piBin, ["--version"]).stdout?.trim() || "unknown" : null;
  const ompVer = ompBin ? run(ompBin, ["--version"]).stdout?.trim() || "unknown" : null;

  log(`piVer: ${piVer ?? "N/A"}, ompVer: ${ompVer ?? "N/A"}`);

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
  log(`packageRoot: ${packageRoot}`);
  log(`targets: ${JSON.stringify(targets)}`);

  for (const target of targets) {
    installToPlatform(target.dir, packageRoot);

    // ── Step 3b: Install supi-context-mode extension + register MCP ──
    await installContextMode(target.dir);
  }

  if (DEBUG) {
    note(`Debug log written to:\n${LOG_FILE}`, "Debug");
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
  note(
    "Restart OMP for the extension to take effect.\n" +
      `Run \`${targetNames}\` in a new session to confirm /supi commands appear.`,
    "Action required"
  );
  outro(`supipowers is ready!`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
