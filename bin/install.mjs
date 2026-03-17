#!/usr/bin/env node

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
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// ── Helpers ──────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf8")
);
const VERSION = pkg.version;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
    ...opts,
  });
}

function bail(msg) {
  cancel(msg);
  process.exit(1);
}

function findOmpBinary() {
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

// ── LSP Server Data ──────────────────────────────────────────

const LSP_SERVERS = [
  {
    language: "TypeScript / JavaScript",
    server: "typescript-language-server",
    installCmd: "bun add -g typescript-language-server typescript",
  },
  {
    language: "Python",
    server: "pyright",
    installCmd: "pip install pyright",
  },
  {
    language: "Rust",
    server: "rust-analyzer",
    installCmd: "rustup component add rust-analyzer",
  },
  {
    language: "Go",
    server: "gopls",
    installCmd: "go install golang.org/x/tools/gopls@latest",
  },
];

function isInstalled(binary) {
  const result = run("which", [binary]);
  return result.status === 0;
}

// ── CLI Flags ────────────────────────────────────────────────

const args = process.argv.slice(2);
const skipLsp = args.includes("--skip-lsp");

// ── Main ─────────────────────────────────────────────────────

async function main() {
  intro(`supipowers v${VERSION}`);

  // ── Step 1: OMP check ──────────────────────────────────────

  const ompSpinner = spinner();
  ompSpinner.start("Looking for OMP...");
  let omp = findOmpBinary();

  if (!omp) {
    ompSpinner.stop("OMP not found");
    note(
      "OMP (oh-my-pi) is an AI coding agent that supipowers extends.\n" +
        "It adds sub-agents, LSP integration, and plugin support to pi.\n" +
        "Learn more: https://github.com/can1357/oh-my-pi",
      "OMP not found"
    );

    const shouldInstall = await confirm({
      message: "Install OMP now?",
    });
    if (isCancel(shouldInstall) || !shouldInstall) {
      bail("Cannot continue without OMP.");
    }

    const s = spinner();
    s.start("Installing OMP via bun...");
    const result = run("bun", ["add", "-g", "@oh-my-pi/pi-coding-agent"]);
    if (result.status !== 0) {
      s.stop("OMP installation failed");
      bail(result.stderr?.trim() || "Unknown error during OMP install.");
    }
    s.stop("OMP installed successfully");

    // Re-detect after install
    omp = findOmpBinary();
    if (!omp) {
      bail("OMP was installed but the binary was not found in PATH. Try restarting your shell.");
    }
  } else {
    const version = run(omp, ["--version"]);
    const ver = version.stdout?.trim() || "unknown";
    ompSpinner.stop(`OMP ${ver} detected`);
  }

  // ── Step 2: Install / update supipowers into ~/.omp/agent/ ──

  const packageRoot = resolve(__dirname, "..");
  const ompAgent = join(homedir(), ".omp", "agent");
  const extDir = join(ompAgent, "extensions", "supipowers");
  const installedPkgPath = join(extDir, "package.json");

  // Check for existing installation
  let installedVersion = null;
  if (existsSync(installedPkgPath)) {
    try {
      const installed = JSON.parse(readFileSync(installedPkgPath, "utf8"));
      installedVersion = installed.version;
    } catch {
      // corrupted package.json — treat as not installed
    }
  }

  if (installedVersion === VERSION) {
    note(`supipowers v${VERSION} is already installed and up to date.`, "Up to date");
  } else {
    const action = installedVersion ? "Updating" : "Installing";
    if (installedVersion) {
      note(`v${installedVersion} → v${VERSION}`, "Updating supipowers");
    }

    const s = spinner();
    s.start(`${action} supipowers...`);

    try {
      // Clean previous installation to remove stale files
      if (existsSync(extDir)) {
        rmSync(extDir, { recursive: true });
      }

      // Copy extension (src/ + package.json) → ~/.omp/agent/extensions/supipowers/
      mkdirSync(extDir, { recursive: true });
      cpSync(join(packageRoot, "src"), join(extDir, "src"), { recursive: true });
      cpSync(join(packageRoot, "package.json"), join(extDir, "package.json"));

      // Copy skills → ~/.omp/agent/skills/<skillname>/SKILL.md
      const skillsSource = join(packageRoot, "skills");
      if (existsSync(skillsSource)) {
        const skillDirs = readdirSync(skillsSource, { withFileTypes: true });
        for (const entry of skillDirs) {
          if (!entry.isDirectory()) continue;
          const skillFile = join(skillsSource, entry.name, "SKILL.md");
          if (!existsSync(skillFile)) continue;
          const destDir = join(ompAgent, "skills", entry.name);
          mkdirSync(destDir, { recursive: true });
          cpSync(skillFile, join(destDir, "SKILL.md"));
        }
      }

      s.stop(installedVersion ? `supipowers updated to v${VERSION}` : `supipowers v${VERSION} installed`);
    } catch (err) {
      s.stop(`${action} failed`);
      bail(err.message || "Failed to copy files to ~/.omp/agent/");
    }
  }

  // ── Step 3: LSP setup (optional, skipped with --skip-lsp) ──

  if (skipLsp) {
    note("LSP setup skipped (--skip-lsp)", "LSP");
  } else {
    const lspSpinner = spinner();
    lspSpinner.start("Checking installed LSP servers...");
    const lspOptions = LSP_SERVERS.map((srv) => {
      const installed = isInstalled(srv.server);
      return {
        value: srv,
        label: srv.language,
        hint: installed ? `${srv.server} (installed)` : srv.server,
      };
    });
    const installedCount = lspOptions.filter((o) => o.hint.includes("(installed)")).length;
    lspSpinner.stop(`Found ${installedCount}/${LSP_SERVERS.length} LSP servers installed`);

    const selected = await multiselect({
      message: "Install LSP servers for better code intelligence?",
      options: lspOptions,
      required: false,
    });

    if (!isCancel(selected) && selected.length > 0) {
      for (const srv of selected) {
        if (isInstalled(srv.server)) {
          note(`${srv.server} is already installed, skipping.`, srv.language);
          continue;
        }
        const ls = spinner();
        ls.start(`Installing ${srv.server}...`);
        const [cmd, ...installArgs] = srv.installCmd.split(" ");
        const r = run(cmd, installArgs);
        if (r.status !== 0) {
          ls.stop(`Failed to install ${srv.server} — you can install manually: ${srv.installCmd}`);
        } else {
          ls.stop(`${srv.server} installed`);
        }
      }
    }
  }

  // ── Done ───────────────────────────────────────────────────

  outro("supipowers is ready! Run `omp` to start using it.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
