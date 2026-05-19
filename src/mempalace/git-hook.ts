import fs from "node:fs";
import path from "node:path";

import type { Platform, PlatformPaths } from "../platform/types.js";
import type { SupipowersConfig } from "../types.js";
import { resolveMempalaceConfig } from "./config.js";
import { snapshotMempalaceInstall, type MempalaceInstallSnapshot } from "./installer-helper.js";

export const MEM_PALACE_POST_COMMIT_HOOK_MARKER = "supipowers-mempalace-post-commit v1";
const POST_COMMIT_HOOK_NAME = "post-commit";
const USER_POST_COMMIT_HOOK_NAME = "post-commit.user";
const REINDEX_RUNNER_NAME = "supi-mempalace-reindex.py";
const REINDEX_RUNNER_MARKER = "supipowers-mempalace-reindex-runner v1";
const DEFAULT_REINDEX_TIMEOUT_SECONDS = 30;

type ExecFn = Platform["exec"];

export interface MempalaceGitHookContext {
  repoRoot: string;
  hooksDir: string;
  hookPath: string;
  userHookPath: string;
  coreHooksPath: string | null;
}

type MempalaceGitHookContextFailure = { ok: false; code: "not_git_repo" | "git_failed"; message: string };

export interface MempalacePostCommitHookStatus extends MempalaceGitHookContext {
  ok: true;
  installed: boolean;
  managed: boolean;
  userHookPresent: boolean;
  runnerPath: string;
  runnerPresent: boolean;
}

export type MempalacePostCommitHookStatusResult =
  | MempalacePostCommitHookStatus
  | { ok: false; code: "not_git_repo" | "git_failed"; message: string };

type MempalacePostCommitHookInstallAction = "installed" | "already-installed" | "upgraded" | "chained-user-hook";
type MempalacePostCommitHookUninstallAction = "uninstalled" | "restored-user-hook" | "already-uninstalled";

export type MempalacePostCommitHookInstallResult =
  | (MempalacePostCommitHookStatus & { action: MempalacePostCommitHookInstallAction })
  | { ok: false; code: "mempalace_disabled" | "mempalace_not_ready" | "not_git_repo" | "user_hook_conflict" | "git_failed"; message: string };

export type MempalacePostCommitHookUninstallResult =
  | (MempalacePostCommitHookStatus & { action: MempalacePostCommitHookUninstallAction })
  | { ok: false; code: "not_git_repo" | "not_managed" | "git_failed"; message: string };

interface BaseHookOptions {
  paths: PlatformPaths;
  cwd: string;
  config: SupipowersConfig;
  exec: ExecFn;
}

export interface InstallMempalacePostCommitHookOptions extends BaseHookOptions {
  snapshot?: MempalaceInstallSnapshot;
}

function trimStdout(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}

function resolveMaybeRelative(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

async function gitValue(exec: ExecFn, cwd: string, args: string[]): Promise<{ ok: true; value: string } | { ok: false; message: string; code: number }> {
  try {
    const result = await exec("git", args, { cwd });
    if (result.code !== 0) {
      const detail = trimStdout(result.stderr || result.stdout) || `git ${args.join(" ")} exited ${result.code}`;
      return { ok: false, message: detail, code: result.code };
    }
    return { ok: true, value: trimStdout(result.stdout) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), code: -1 };
  }
}

async function resolveHookContext(exec: ExecFn, cwd: string): Promise<MempalaceGitHookContext | MempalaceGitHookContextFailure> {
  const repoRootResult = await gitValue(exec, cwd, ["rev-parse", "--show-toplevel"]);
  if (!repoRootResult.ok || repoRootResult.value.length === 0) {
    return { ok: false, code: "not_git_repo", message: repoRootResult.ok ? "Not inside a git repository." : repoRootResult.message };
  }

  const repoRoot = path.resolve(repoRootResult.value);
  const commonDirResult = await gitValue(exec, repoRoot, ["rev-parse", "--git-common-dir"]);
  if (!commonDirResult.ok || commonDirResult.value.length === 0) {
    return { ok: false, code: "git_failed", message: commonDirResult.ok ? "git rev-parse --git-common-dir returned an empty path." : commonDirResult.message };
  }

  const coreHooksPathResult = await gitValue(exec, repoRoot, ["config", "--get", "core.hooksPath"]);
  const coreHooksPath = coreHooksPathResult.ok && coreHooksPathResult.value.length > 0
    ? coreHooksPathResult.value
    : null;
  const hooksDir = coreHooksPath !== null
    ? resolveMaybeRelative(repoRoot, coreHooksPath)
    : path.join(resolveMaybeRelative(repoRoot, commonDirResult.value), "hooks");

  return {
    repoRoot,
    hooksDir,
    hookPath: path.join(hooksDir, POST_COMMIT_HOOK_NAME),
    userHookPath: path.join(hooksDir, USER_POST_COMMIT_HOOK_NAME),
    coreHooksPath,
  };
}

function isHookContextFailure(value: MempalaceGitHookContext | MempalaceGitHookContextFailure): value is MempalaceGitHookContextFailure {
  return "ok" in value && value.ok === false;
}

function readTextIfPresent(filePath: string): string | null {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function isManagedHook(content: string | null): boolean {
  return content !== null && content.includes(MEM_PALACE_POST_COMMIT_HOOK_MARKER);
}

function writeExecutableFile(filePath: string, content: string): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = readTextIfPresent(filePath);
  if (existing === content) {
    chmodExecutableBestEffort(filePath);
    return false;
  }
  fs.writeFileSync(filePath, content, "utf-8");
  chmodExecutableBestEffort(filePath);
  return true;
}

function chmodExecutableBestEffort(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

export function toHookShellPath(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? value.replace(/\\/g, "/") : value;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildPostCommitHookScript(snapshot: MempalaceInstallSnapshot, runnerPath: string, palacePath: string, agentName: string): string {
  const python = shQuote(toHookShellPath(snapshot.venvPython));
  const runner = shQuote(toHookShellPath(runnerPath));
  const bridge = shQuote(toHookShellPath(snapshot.bridgePath));
  const palace = shQuote(toHookShellPath(palacePath));
  const agent = shQuote(agentName);
  return `#!/bin/sh
# ${MEM_PALACE_POST_COMMIT_HOOK_MARKER}
# Managed by /supi:memory git-hook install. Chains ${USER_POST_COMMIT_HOOK_NAME} when present.

USER_HOOK="$(dirname "$0")/${USER_POST_COMMIT_HOOK_NAME}"
USER_STATUS=0
if [ -f "$USER_HOOK" ]; then
  if [ -x "$USER_HOOK" ]; then
    "$USER_HOOK" "$@"
  else
    sh "$USER_HOOK" "$@"
  fi
  USER_STATUS=$?
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit "$USER_STATUS"
HEAD_COMMIT=$(git rev-parse HEAD 2>/dev/null) || exit "$USER_STATUS"
PYTHON=${python}
RUNNER=${runner}
BRIDGE=${bridge}
PALACE=${palace}
AGENT=${agent}

[ -f "$PYTHON" ] || exit "$USER_STATUS"
[ -f "$RUNNER" ] || exit "$USER_STATUS"
[ -f "$BRIDGE" ] || exit "$USER_STATUS"

LOG_DIR="$REPO_ROOT/.omp/supipowers/mempalace"
LOG="$LOG_DIR/post-commit.log"
mkdir -p "$LOG_DIR" 2>/dev/null || exit "$USER_STATUS"
(
  "$PYTHON" "$RUNNER" \
    --cwd "$REPO_ROOT" \
    --commit "$HEAD_COMMIT" \
    --bridge "$BRIDGE" \
    --palace "$PALACE" \
    --agent "$AGENT" \
    --timeout-seconds ${DEFAULT_REINDEX_TIMEOUT_SECONDS} \
    >> "$LOG" 2>&1
) &
exit "$USER_STATUS"
`;
}

function buildReindexRunnerScript(): string {
  return `#!/usr/bin/env python3
# ${REINDEX_RUNNER_MARKER}
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Iterable


def _decode_paths(raw: bytes) -> list[str]:
    return [part.decode("utf-8", "surrogateescape") for part in raw.split(b"\\0") if part]


def _changed_files(cwd: str, commit: str, timeout_seconds: int) -> list[str]:
    proc = subprocess.run(
        [
            "git",
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-z",
            "--diff-filter=ACMRT",
            commit,
        ],
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout_seconds,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", "replace").strip()
        print(f"[supi-mempalace] git diff-tree failed: {stderr}", file=sys.stderr)
        return []
    return _decode_paths(proc.stdout)


def _safe_existing_files(cwd: str, paths: Iterable[str]) -> list[str]:
    root = os.path.abspath(cwd)
    selected: list[str] = []
    for rel in paths:
        abs_path = os.path.abspath(os.path.join(root, rel))
        try:
            if os.path.commonpath([root, abs_path]) != root:
                print(f"[supi-mempalace] skip outside repo: {rel}")
                continue
        except ValueError:
            print(f"[supi-mempalace] skip outside repo: {rel}")
            continue
        if os.path.isfile(abs_path):
            selected.append(rel)
    return selected


def _run_split(args: argparse.Namespace, source_file: str) -> bool:
    request = {
        "action": "split",
        "params": {"source_file": source_file},
        "options": {
            "cwd": args.cwd,
            "palacePath": args.palace,
            "agentName": args.agent,
        },
    }
    try:
        proc = subprocess.run(
            [sys.executable, args.bridge],
            cwd=args.cwd,
            input=json.dumps(request),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=args.timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        print(f"[supi-mempalace] split timed out: {source_file}", file=sys.stderr)
        return False

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        print(f"[supi-mempalace] bridge failed for {source_file}: {detail}", file=sys.stderr)
        return False

    try:
        payload = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        print(f"[supi-mempalace] bridge returned non-json for {source_file}: {proc.stdout[:300]}", file=sys.stderr)
        return False

    if payload.get("ok") is True:
        print(f"[supi-mempalace] indexed {source_file}")
        return True

    error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    code = error.get("code", "unknown_error")
    message = error.get("message", "MemPalace split failed")
    print(f"[supi-mempalace] split failed for {source_file}: {code}: {message}", file=sys.stderr)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Reindex MemPalace drawers for files changed by one git commit.")
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--bridge", required=True)
    parser.add_argument("--palace", required=True)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=30)
    args = parser.parse_args()

    if not os.path.isfile(args.bridge):
        print(f"[supi-mempalace] bridge missing: {args.bridge}", file=sys.stderr)
        return 0

    timeout_seconds = max(1, args.timeout_seconds)
    args.timeout_seconds = timeout_seconds
    changed = _changed_files(args.cwd, args.commit, timeout_seconds)
    files = _safe_existing_files(args.cwd, changed)
    if not files:
        print(f"[supi-mempalace] commit {args.commit}: no indexable changed files")
        return 0

    ok = 0
    for source_file in files:
        if _run_split(args, source_file):
            ok += 1
    print(f"[supi-mempalace] commit {args.commit}: indexed {ok}/{len(files)} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
}

function buildStatus(context: MempalaceGitHookContext, runnerPath: string): MempalacePostCommitHookStatus {
  const hookContent = readTextIfPresent(context.hookPath);
  return {
    ok: true,
    ...context,
    installed: hookContent !== null,
    managed: isManagedHook(hookContent),
    userHookPresent: fs.existsSync(context.userHookPath),
    runnerPath,
    runnerPresent: fs.existsSync(runnerPath),
  };
}

export async function getMempalacePostCommitHookStatus(options: BaseHookOptions): Promise<MempalacePostCommitHookStatusResult> {
  const context = await resolveHookContext(options.exec, options.cwd);
  if (isHookContextFailure(context)) return context;
  return buildStatus(context, options.paths.global("bin", REINDEX_RUNNER_NAME));
}

export async function installMempalacePostCommitHook(options: InstallMempalacePostCommitHookOptions): Promise<MempalacePostCommitHookInstallResult> {
  if (!options.config.mempalace.enabled) {
    return { ok: false, code: "mempalace_disabled", message: "MemPalace integration is disabled in config." };
  }

  const snapshot = options.snapshot ?? snapshotMempalaceInstall(options.paths, options.cwd, options.config);
  if (!snapshot.ready) {
    return { ok: false, code: "mempalace_not_ready", message: "MemPalace runtime is not ready. Run /supi:memory setup before installing the git hook." };
  }

  const context = await resolveHookContext(options.exec, options.cwd);
  if (isHookContextFailure(context)) return context;

  const resolved = resolveMempalaceConfig(options.config, context.repoRoot, options.paths);
  const runnerPath = options.paths.global("bin", REINDEX_RUNNER_NAME);
  writeExecutableFile(runnerPath, buildReindexRunnerScript());

  const desiredHook = buildPostCommitHookScript(snapshot, runnerPath, resolved.palacePath, resolved.defaultAgentName);
  const existingHook = readTextIfPresent(context.hookPath);
  let action: MempalacePostCommitHookInstallAction = "installed";

  if (existingHook === desiredHook) {
    return { ...buildStatus(context, runnerPath), action: "already-installed" };
  }

  fs.mkdirSync(context.hooksDir, { recursive: true });
  if (existingHook !== null && !isManagedHook(existingHook)) {
    if (fs.existsSync(context.userHookPath)) {
      return {
        ok: false,
        code: "user_hook_conflict",
        message: `Cannot install MemPalace post-commit hook because both ${context.hookPath} and ${context.userHookPath} already exist and the active hook is not managed by supipowers.`,
      };
    }
    fs.renameSync(context.hookPath, context.userHookPath);
    action = "chained-user-hook";
  } else if (existingHook !== null) {
    action = "upgraded";
  }

  writeExecutableFile(context.hookPath, desiredHook);
  return { ...buildStatus(context, runnerPath), action };
}

export async function uninstallMempalacePostCommitHook(options: BaseHookOptions): Promise<MempalacePostCommitHookUninstallResult> {
  const context = await resolveHookContext(options.exec, options.cwd);
  if (isHookContextFailure(context)) return context;

  const runnerPath = options.paths.global("bin", REINDEX_RUNNER_NAME);
  const existingHook = readTextIfPresent(context.hookPath);
  if (existingHook !== null && !isManagedHook(existingHook)) {
    return { ok: false, code: "not_managed", message: `${context.hookPath} is not managed by supipowers; refusing to remove it.` };
  }

  if (existingHook !== null) {
    fs.rmSync(context.hookPath, { force: true });
  }

  let action: MempalacePostCommitHookUninstallAction = existingHook === null ? "already-uninstalled" : "uninstalled";
  if (fs.existsSync(context.userHookPath) && !fs.existsSync(context.hookPath)) {
    fs.renameSync(context.userHookPath, context.hookPath);
    chmodExecutableBestEffort(context.hookPath);
    action = "restored-user-hook";
  }

  return { ...buildStatus(context, runnerPath), action };
}
