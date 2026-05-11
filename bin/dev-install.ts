#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatReport, installAll, scanAll } from "../src/deps/registry.js";
import type { ExecResult } from "../src/platform/types.js";

const isWindows = process.platform === "win32";
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  version?: string;
};

interface RunResult {
  stdout: string | null;
  stderr: string | null;
  status: number | null;
  error?: Error;
}

interface InstallTarget {
  name: string;
  dir: ".omp" | ".pi";
  binary: string;
  version: string;
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

function runRequired(cmd: string, args: string[], label: string, opts: Record<string, unknown> = {}): void {
  process.stdout.write(`-> ${label}...\n`);
  const result = run(cmd, args, opts);
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`${label} failed${details ? `:\n${details}` : ""}`);
  }
}

async function exec(cmd: string, args: string[]): Promise<ExecResult> {
  const result = run(cmd, args);
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    code: result.status ?? 1,
  };
}

function findBinary(binary: "omp" | "pi"): string | null {
  const pathCheck = run(binary, ["--version"]);
  if (!pathCheck.error && pathCheck.status === 0) return binary;

  const candidates: string[] = [];
  if (isWindows) {
    candidates.push(join(homedir(), ".bun", "bin", `${binary}.exe`));
    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(join(appData, "npm", `${binary}.cmd`));
      candidates.push(join(appData, "npm", binary));
    }
  } else {
    candidates.push(
      join(homedir(), ".bun", "bin", binary),
      join(homedir(), ".npm-global", "bin", binary),
      `/usr/local/bin/${binary}`,
      `/opt/homebrew/bin/${binary}`,
    );
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const check = run(candidate, ["--version"]);
    if (!check.error && check.status === 0) return candidate;
  }

  return null;
}

function getVersion(binary: string): string {
  return run(binary, ["--version"]).stdout?.trim() || "unknown";
}

function detectTargets(): InstallTarget[] {
  const targets: InstallTarget[] = [];
  const ompBinary = findBinary("omp");
  if (ompBinary) {
    targets.push({ name: "OMP", dir: ".omp", binary: ompBinary, version: getVersion(ompBinary) });
  }

  const piBinary = findBinary("pi");
  if (piBinary) {
    targets.push({ name: "Pi", dir: ".pi", binary: piBinary, version: getVersion(piBinary) });
  }

  return targets;
}

function ensureAgentInstalled(): InstallTarget[] {
  const detected = detectTargets();
  if (detected.length > 0) return detected;

  runRequired("npm", ["install", "-g", "@mariozechner/pi-coding-agent"], "Installing Pi via npm");
  const piBinary = findBinary("pi");
  if (!piBinary) {
    throw new Error("Pi installed, but the `pi` binary was not found. Restart your shell and retry.");
  }
  return [{ name: "Pi", dir: ".pi", binary: piBinary, version: getVersion(piBinary) }];
}

function linkExtension(target: InstallTarget): void {
  const agentDir = join(homedir(), target.dir, "agent");
  const extensionsDir = join(agentDir, "extensions");
  const extDir = join(extensionsDir, "supipowers");

  mkdirSync(extensionsDir, { recursive: true });
  if (existsSync(extDir)) {
    rmSync(extDir, { recursive: true, force: true });
  }
  symlinkSync(packageRoot, extDir, isWindows ? "junction" : "dir");

  const skillsSource = join(packageRoot, "skills");
  if (!existsSync(skillsSource)) return;

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

async function installToolingDeps(): Promise<void> {
  process.stdout.write("-> Scanning supipowers tool dependencies...\n");
  const before = await scanAll(exec);
  const missingInstallable = before.filter((dep) => !dep.installed && dep.installCmd !== null);

  if (missingInstallable.length > 0) {
    process.stdout.write(`-> Installing ${missingInstallable.length} missing installable dependencies...\n`);
    const installResults = await installAll(exec, missingInstallable);
    const failed = installResults.filter((result) => !result.success);
    for (const result of failed) {
      process.stdout.write(
        `   ! ${result.name}: ${result.error ?? "install command failed"}\n`,
      );
    }
  }

  const after = await scanAll(exec);
  const missingRequired = after.filter((dep) => !dep.installed && dep.required);
  if (missingRequired.length > 0) {
    throw new Error(`Required dependencies are still missing:\n${formatReport(after)}`);
  }

  const stillMissing = after.filter((dep) => !dep.installed);
  if (stillMissing.length > 0) {
    process.stdout.write(`${formatReport(after)}\n`);
  }
}

async function main(): Promise<void> {
  process.stdout.write(`supipowers dev install${pkg.version ? ` v${pkg.version}` : ""}\n`);
  process.stdout.write(`repo: ${packageRoot}\n`);

  const frozenInstall = run("bun", ["install", "--frozen-lockfile"], { cwd: packageRoot });
  if (frozenInstall.status !== 0) {
    runRequired("bun", ["install"], "Installing repository dependencies", { cwd: packageRoot });
  } else {
    process.stdout.write("-> Repository dependencies are current.\n");
  }

  runRequired("bun", ["run", "build"], "Building supipowers", { cwd: packageRoot });
  runRequired("bun", ["link"], "Linking supipowers CLI globally", { cwd: packageRoot });

  const targets = ensureAgentInstalled();
  for (const target of targets) {
    process.stdout.write(`-> Linking extension into ~/${target.dir}/agent for ${target.name} (${target.version})...\n`);
    linkExtension(target);
  }

  await installToolingDeps();

  process.stdout.write("\nDone. Restart OMP/Pi; /supi commands will load from this repository.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
