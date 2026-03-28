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
 * Register context-mode MCP server in the given platform's mcp.json.
 */
function registerContextMode(platformDir: string, extDir: string): void {
  const ctxSpinner = spinner();
  ctxSpinner.start(`Checking for context-mode (${platformDir})...`);

  // Find context-mode installation (Claude Code plugin cache)
  const ctxCacheBase = join(
    homedir(),
    ".claude",
    "plugins",
    "cache",
    "context-mode",
    "context-mode",
  );
  let ctxInstallPath: string | null = null;
  if (existsSync(ctxCacheBase)) {
    const versions = readdirSync(ctxCacheBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    if (versions.length > 0) {
      const candidate = join(ctxCacheBase, versions[0], "start.mjs");
      if (existsSync(candidate)) {
        ctxInstallPath = join(ctxCacheBase, versions[0]);
      }
    }
  }

  if (ctxInstallPath) {
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

    const startMjs = join(ctxInstallPath, "start.mjs");
    // Use our wrapper script that captures cwd as CLAUDE_PROJECT_DIR
    // before context-mode's start.mjs clobbers it with process.chdir(__dirname)
    const wrapperMjs = join(extDir, "bin", "ctx-mode-wrapper.mjs");
    mcpConfig.mcpServers["context-mode"] = {
      command: "node",
      args: [wrapperMjs, startMjs],
    };

    mkdirSync(join(homedir(), platformDir, "agent"), { recursive: true });
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    ctxSpinner.stop(`context-mode registered in ~/${platformDir}/agent/mcp.json`);
  } else {
    ctxSpinner.stop(
      `context-mode not found — install it as a Claude Code plugin for context window protection (${platformDir})`,
    );
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
    const extDir = installToPlatform(target.dir, packageRoot);

    // ── Step 3b: Register context-mode MCP server ───────────
    registerContextMode(target.dir, extDir);
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

    // Offer to install missing deps that have an installCmd
    const installable = statuses.filter(
      (s) => !s.installed && s.installCmd !== null,
    );

    if (installable.length > 0) {
      const depList = installable
        .map((s) => `  • ${s.name} (${s.installCmd})`)
        .join("\n");
      const shouldInstall = await confirm({
        message: `Install ${installable.length} missing tool(s)?\n${depList}`,
      });

      if (!isCancel(shouldInstall) && shouldInstall) {
        for (const dep of installable) {
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
