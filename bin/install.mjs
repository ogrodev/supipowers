#!/usr/bin/env node

import {
  intro,
  outro,
  confirm,
  select,
  multiselect,
  spinner,
  isCancel,
  cancel,
  note,
} from "@clack/prompts";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, extname, dirname, join } from "node:path";
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
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    server: "typescript-language-server",
    installCmd: "bun add -g typescript-language-server typescript",
  },
  {
    language: "Python",
    extensions: [".py"],
    server: "pyright",
    installCmd: "pip install pyright",
  },
  {
    language: "Rust",
    extensions: [".rs"],
    server: "rust-analyzer",
    installCmd: "rustup component add rust-analyzer",
  },
  {
    language: "Go",
    extensions: [".go"],
    server: "gopls",
    installCmd: "go install golang.org/x/tools/gopls@latest",
  },
];

function detectLanguages(dir) {
  const detected = new Set();
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        detected.add(extname(entry.name));
      } else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        // One level deep
        try {
          const subEntries = readdirSync(join(dir, entry.name), { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile()) detected.add(extname(sub.name));
          }
        } catch {
          // skip unreadable dirs
        }
      }
    }
  } catch {
    // skip
  }
  return detected;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  intro(`supipowers v${VERSION}`);

  // ── Step 1: OMP check ──────────────────────────────────────

  let omp = findOmpBinary();

  if (!omp) {
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
    note(`OMP ${ver}`, "OMP detected");
  }

  // ── Step 2: Install supipowers ─────────────────────────────

  const scope = await select({
    message: "Where should supipowers be installed?",
    options: [
      { value: "global", label: "Global", hint: "available in all projects" },
      { value: "local", label: "Project-local", hint: "only this directory" },
    ],
  });
  if (isCancel(scope)) bail("Cancelled.");

  const packageSpec = `npm:supipowers@${VERSION}`;
  const installArgs = ["install", packageSpec];
  if (scope === "local") installArgs.push("-l");

  const s = spinner();
  s.start(`Installing supipowers (${scope})...`);
  const result = run(omp, installArgs);
  if (result.status !== 0) {
    s.stop("Installation failed");
    bail(result.stderr?.trim() || "omp install failed.");
  }
  s.stop("supipowers installed");

  // ── Step 3: LSP setup (optional) ──────────────────────────

  const detectedExts = detectLanguages(process.cwd());
  const matchingServers = LSP_SERVERS.filter((srv) =>
    srv.extensions.some((ext) => detectedExts.has(ext))
  );

  if (matchingServers.length > 0) {
    const selected = await multiselect({
      message: "Detected project languages. Install LSP servers for better code intelligence?",
      options: matchingServers.map((srv) => ({
        value: srv,
        label: srv.language,
        hint: srv.server,
      })),
      required: false,
    });

    if (!isCancel(selected) && selected.length > 0) {
      for (const srv of selected) {
        const ls = spinner();
        ls.start(`Installing ${srv.server}...`);
        const [cmd, ...args] = srv.installCmd.split(" ");
        const r = run(cmd, args);
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
