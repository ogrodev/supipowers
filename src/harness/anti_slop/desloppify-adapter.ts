/**
 * Adapter that wraps the `desloppify` CLI. desloppify is a Python tool, so the adapter
 * verifies a usable Python interpreter is on PATH before any call. When Python is
 * unavailable we surface a structured `SlopBackendUnavailable` result with `not-installed`
 * so the Design phase can offer a fallback (fallow + supi-native).
 *
 * desloppify exposes `scan` (full multi-language scan), `next`/`resolve` (queue
 * management), and `update-skill` (agent-skill distribution). We bridge `next/resolve` to
 * our supi-native queue so the user-facing UX is the harness queue, regardless of backend.
 */

import type { Platform } from "../../platform/types.js";
import type { HarnessAntiSlopBackend } from "../../types.js";
import {
  type AuditOptions,
  type DeadCodeOptions,
  type DupesOptions,
  type FixOptions,
  type FixResult,
  type ScanOptions,
  type SlopBackend,
  type SlopBackendResult,
  type SlopFinding,
} from "./backend.js";

const DEFAULT_TIMEOUT_MS = 90_000;
const PYTHON_MIN_MAJOR = 3;
const PYTHON_MIN_MINOR = 11;

let availabilityCache:
  | { ok: true; cmd: string; baseArgs: string[] }
  | { ok: false; reason: "not-installed" | "version-too-old"; message: string }
  | null = null;

interface DesloppifyFinding {
  id?: string;
  kind?: string;
  file?: string;
  start_line?: number;
  end_line?: number;
  severity?: string;
  message?: string;
  remediation?: string;
  cluster?: string;
}

interface DesloppifyJsonOutput {
  findings?: DesloppifyFinding[];
  score?: { lenient?: number; strict?: number };
}

function mapKind(kind?: string): SlopFinding["kind"] {
  switch ((kind ?? "").toLowerCase()) {
    case "duplicate":
    case "near-duplicate":
      return "duplicate";
    case "dead-code":
    case "unused":
      return "dead-code";
    case "layer":
    case "layer-violation":
      return "layer-violation";
    case "naming":
      return "naming";
    case "complexity":
      return "complexity";
    case "circular":
      return "circular-dependency";
    case "file-too-large":
      return "file-too-large";
    default:
      return "other";
  }
}

function mapSeverity(severity?: string): SlopFinding["severity"] {
  switch ((severity ?? "").toLowerCase()) {
    case "blocker":
    case "error":
      return "blocker";
    case "warning":
      return "warning";
    case "info":
      return "info";
    default:
      return "warning";
  }
}

function parseFindings(raw: string): SlopFinding[] {
  if (!raw.trim()) return [];
  let parsed: DesloppifyJsonOutput;
  try {
    parsed = JSON.parse(raw) as DesloppifyJsonOutput;
  } catch {
    return [];
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  return findings.map<SlopFinding>((f) => ({
    kind: mapKind(f.kind),
    file: f.file ?? "",
    range:
      typeof f.start_line === "number"
        ? { startLine: f.start_line, endLine: f.end_line ?? f.start_line }
        : null,
    severity: mapSeverity(f.severity),
    source: "desloppify",
    message: f.message ?? "(no message)",
    remediation: f.remediation,
    details: { ...(f.id ? { desloppifyId: f.id } : {}) },
    clusterKey: f.cluster,
  }));
}

function isPythonAcceptable(versionLine: string): boolean {
  const match = versionLine.match(/Python\s+(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > PYTHON_MIN_MAJOR) return true;
  if (major < PYTHON_MIN_MAJOR) return false;
  return minor >= PYTHON_MIN_MINOR;
}

async function detectPython(platform: Platform): Promise<{ cmd: string; version: string } | null> {
  for (const cmd of ["python3", "python"]) {
    try {
      const probe = await platform.exec(cmd, ["--version"], { timeout: 3000 });
      if (probe.code !== 0) continue;
      // Python 2 prints --version to stderr; merge.
      const stdoutVersion = probe.stdout.trim();
      const stderrVersion = probe.stderr.trim();
      const version = stdoutVersion || stderrVersion;
      if (version && isPythonAcceptable(version)) {
        return { cmd, version };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function resolveInvocation(
  platform: Platform,
): Promise<
  | { ok: true; cmd: string; baseArgs: string[] }
  | { ok: false; reason: "not-installed" | "version-too-old"; message: string }
> {
  if (availabilityCache) return availabilityCache;

  // desloppify itself may be on PATH directly.
  try {
    const probe = await platform.exec("desloppify", ["--version"], { timeout: 5000 });
    if (probe.code === 0) {
      availabilityCache = { ok: true, cmd: "desloppify", baseArgs: [] };
      return availabilityCache;
    }
  } catch {
    // fallthrough to python -m
  }

  const python = await detectPython(platform);
  if (!python) {
    availabilityCache = {
      ok: false,
      reason: "not-installed",
      message: `Python ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}+ not found on PATH; install desloppify via \`pip install --upgrade "desloppify[full]"\` after upgrading Python`,
    };
    return availabilityCache;
  }

  // Try `python -m desloppify --version` to confirm the package is importable.
  try {
    const probe = await platform.exec(python.cmd, ["-m", "desloppify", "--version"], { timeout: 8000 });
    if (probe.code === 0) {
      availabilityCache = { ok: true, cmd: python.cmd, baseArgs: ["-m", "desloppify"] };
      return availabilityCache;
    }
  } catch {
    // fallthrough
  }

  availabilityCache = {
    ok: false,
    reason: "not-installed",
    message: `desloppify not installed under ${python.cmd}; run \`${python.cmd} -m pip install --upgrade "desloppify[full]"\``,
  };
  return availabilityCache;
}

async function runDesloppify(
  platform: Platform,
  subcommand: string,
  extraArgs: string[],
  opts: ScanOptions,
): Promise<SlopBackendResult> {
  const invocation = await resolveInvocation(platform);
  if (!invocation.ok) {
    return { ok: false, reason: invocation.reason, message: invocation.message };
  }
  const args = [
    ...invocation.baseArgs,
    subcommand,
    "--format",
    "json",
    ...extraArgs,
  ];
  if (opts.subtree) args.push("--path", opts.subtree);
  if (opts.changedSinceHead) args.push("--changed-since", "HEAD");

  const startedAt = Date.now();
  let result;
  try {
    result = await platform.exec(invocation.cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "execution-failed",
      message: error instanceof Error ? error.message : "desloppify execution threw",
    };
  }

  const durationMs = Date.now() - startedAt;
  if (result.killed) {
    return { ok: false, reason: "timeout", message: `desloppify ${subcommand} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` };
  }
  if (result.code >= 2) {
    return {
      ok: false,
      reason: "execution-failed",
      message: `desloppify ${subcommand} exited with code ${result.code}`,
      exitCode: result.code,
      stderr: result.stderr,
    };
  }
  return {
    ok: true,
    findings: parseFindings(result.stdout),
    durationMs,
    details: { exitCode: result.code },
  };
}

export class DesloppifyAdapter implements SlopBackend {
  readonly id: HarnessAntiSlopBackend = "desloppify";

  async isAvailable(platform: Platform): Promise<boolean> {
    const invocation = await resolveInvocation(platform);
    return invocation.ok;
  }

  async scan(platform: Platform, opts: ScanOptions): Promise<SlopBackendResult> {
    return runDesloppify(platform, "scan", [], opts);
  }

  async dupes(platform: Platform, opts: DupesOptions): Promise<SlopBackendResult> {
    const args: string[] = ["--only", "duplicate"];
    if (typeof opts.threshold === "number") args.push("--threshold", String(opts.threshold));
    return runDesloppify(platform, "scan", args, opts);
  }

  async deadCode(platform: Platform, opts: DeadCodeOptions): Promise<SlopBackendResult> {
    return runDesloppify(platform, "scan", ["--only", "dead-code"], opts);
  }

  async audit(platform: Platform, opts: AuditOptions): Promise<SlopBackendResult> {
    return runDesloppify(platform, "scan", [], opts);
  }

  async fix(platform: Platform, opts: FixOptions): Promise<FixResult> {
    const invocation = await resolveInvocation(platform);
    if (!invocation.ok) {
      return {
        ok: false,
        appliedIds: [],
        failedIds: (opts.entryIds ?? []).map((id) => ({ id, reason: invocation.message })),
      };
    }
    const args = [...invocation.baseArgs, "resolve"];
    for (const id of opts.entryIds ?? []) args.push("--id", id);
    if (!opts.apply) args.push("--dry-run");
    try {
      const result = await platform.exec(invocation.cmd, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        return {
          ok: false,
          appliedIds: [],
          failedIds: (opts.entryIds ?? []).map((id) => ({ id, reason: `desloppify resolve exited ${result.code}: ${result.stderr.trim()}` })),
        };
      }
      return {
        ok: true,
        appliedIds: opts.entryIds ?? [],
        failedIds: [],
        details: { stdout: result.stdout },
      };
    } catch (error) {
      return {
        ok: false,
        appliedIds: [],
        failedIds: (opts.entryIds ?? []).map((id) => ({
          id,
          reason: error instanceof Error ? error.message : "desloppify resolve threw",
        })),
      };
    }
  }
}

export function _resetDesloppifyAvailabilityCacheForTests(): void {
  availabilityCache = null;
}
