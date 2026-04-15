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
    // skills/ must live inside the extension dir — src/commands/agents.ts
    // uses a static `import from "../../skills/..."` resolved relative to src/.
    const skillsSrc = join(packageRoot, "skills");
    if (existsSync(skillsSrc)) {
      cpSync(skillsSrc, join(extDir, "skills"), { recursive: true });
    }
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
        // Runtime deps from the published package.json (handlebars, etc.)
        ...(sourcePkg.dependencies ?? {}),
        // Peer deps that OMP provides at its global level. On macOS Bun resolves
        // these from the global install, but on Windows the extension's own
        // node_modules must contain them or Bun's import fails.
        ...(sourcePkg.peerDependencies ?? {}),
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
 * Remove supi-context-mode / context-mode entries from the current agent/mcp.json
 * and from the legacy settings/mcp.json location.
 */
function cleanupContextModeMcp(platformDir: string): void {
  // Clean supi-context-mode from the current agent/mcp.json
  const agentMcpPath = join(homedir(), platformDir, "agent", "mcp.json");
  if (existsSync(agentMcpPath)) {
    try {
      const agentConfig = JSON.parse(readFileSync(agentMcpPath, "utf8"));
      let changed = false;
      if (agentConfig.mcpServers?.["context-mode"]) {
        delete agentConfig.mcpServers["context-mode"];
        changed = true;
      }
      if (agentConfig.mcpServers?.["supi-context-mode"]) {
        delete agentConfig.mcpServers["supi-context-mode"];
        changed = true;
      }
      if (changed) {
        writeFileSync(agentMcpPath, JSON.stringify(agentConfig, null, 2));
      }
    } catch {
      // Best effort — do not fail install on corrupt mcp.json
    }
  }
}

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

    // ── Step 3b: Clean up legacy context-mode MCP registrations ──
    cleanupContextModeMcp(target.dir);
    cleanupLegacyMcp(target.dir);
  }

  note(
    "Context-mode tools are now built into supipowers (no external MCP server needed).\n" +
    "You can manually remove any legacy installation at ~/<platformDir>/extensions/context-mode/",
    "Context Mode",
  );

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
