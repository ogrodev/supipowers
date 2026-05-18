/**
 * Adapter that wraps the `fallow` CLI for TS/JS code-health scanning.
 *
 * Contract:
 *  - We invoke fallow with explicit JSON output flags so parsing is deterministic.
 *  - Exit code 0 = no findings; exit code 1 = findings present (NOT a process failure);
 *    exit code ≥2 = execution failure.
 *  - We never invoke `fallow watch` from the adapter — the harness owns its own scheduling
 *    via hooks.
 *  - Cross-platform binary detection: try `fallow` first, fall back to `npx --no-install
 *    fallow` when the native binary is missing on PATH (Windows installs without `bun
 *    install -g`).
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
import { execCli } from "../../utils/exec-cli.js";

const DEFAULT_TIMEOUT_MS = 60_000;

/** Cache availability per process so repeated probes don't re-run version checks. */
let availabilityCache: { ok: boolean; via: "binary" | "npx" } | null = null;

interface FallowFinding {
  kind?: string;
  rule?: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  severity?: string;
  message?: string;
  remediation?: string;
  partner?: { file: string; startLine: number; endLine: number };
}

interface FallowJsonOutput {
  version?: string;
  findings?: FallowFinding[];
}

function mapKind(kind?: string): SlopFinding["kind"] {
  switch ((kind ?? "").toLowerCase()) {
    case "duplicate":
    case "dupe":
    case "near-duplicate":
      return "duplicate";
    case "dead":
    case "dead-code":
    case "unused":
    case "unused-export":
      return "dead-code";
    case "layer":
    case "layer-violation":
    case "boundary":
      return "layer-violation";
    case "naming":
      return "naming";
    case "complexity":
      return "complexity";
    case "circular":
    case "circular-dependency":
      return "circular-dependency";
    case "file-too-large":
      return "file-too-large";
    default:
      return "other";
  }
}

function mapSeverity(severity?: string): SlopFinding["severity"] {
  switch ((severity ?? "").toLowerCase()) {
    case "error":
    case "blocker":
      return "blocker";
    case "warn":
    case "warning":
      return "warning";
    case "info":
    case "note":
      return "info";
    default:
      return "warning";
  }
}

function parseFindings(raw: string): SlopFinding[] {
  if (!raw.trim()) return [];
  let parsed: FallowJsonOutput;
  try {
    parsed = JSON.parse(raw) as FallowJsonOutput;
  } catch {
    return [];
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  return findings.map<SlopFinding>((f) => ({
    kind: mapKind(f.kind),
    file: f.file ?? "",
    range:
      typeof f.startLine === "number"
        ? { startLine: f.startLine, endLine: f.endLine ?? f.startLine }
        : null,
    severity: mapSeverity(f.severity),
    source: "fallow",
    message: f.message ?? "(no message)",
    remediation: f.remediation,
    details: {
      ...(f.rule ? { rule: f.rule } : {}),
      ...(f.partner ? { partner: f.partner } : {}),
    },
    clusterKey: f.partner ? `${f.file}:${f.startLine}-${f.partner.file}:${f.partner.startLine}` : undefined,
  }));
}

/**
 * Decide how to invoke fallow. Returns the command + args. Caches the choice between
 * calls so the cost of probing PATH is paid once per process.
 */
async function resolveInvocation(
  platform: Platform,
): Promise<{ ok: true; cmd: string; baseArgs: string[]; via: "binary" | "npx" } | { ok: false; reason: "not-installed"; message: string }> {
  if (availabilityCache?.ok) {
    return availabilityCache.via === "npx"
      ? { ok: true, cmd: "npx", baseArgs: ["--no-install", "fallow"], via: "npx" }
      : { ok: true, cmd: "fallow", baseArgs: [], via: "binary" };
  }
  if (availabilityCache?.ok === false) {
    return { ok: false, reason: "not-installed", message: "fallow CLI not on PATH and `npx fallow` unavailable" };
  }

  // Probe native binary first.
  try {
    const probe = await platform.exec("fallow", ["--version"], { timeout: 3000 });
    if (probe.code === 0) {
      availabilityCache = { ok: true, via: "binary" };
      return { ok: true, cmd: "fallow", baseArgs: [], via: "binary" };
    }
  } catch {
    // fallthrough to npx probe
  }

  try {
    const probe = await execCli((cmd, args, opts) => platform.exec(cmd, args, opts), "npx", ["--no-install", "fallow", "--version"], { timeout: 5000 });
    if (probe.code === 0) {
      availabilityCache = { ok: true, via: "npx" };
      return { ok: true, cmd: "npx", baseArgs: ["--no-install", "fallow"], via: "npx" };
    }
  } catch {
    // fallthrough
  }

  availabilityCache = { ok: false, via: "binary" };
  return { ok: false, reason: "not-installed", message: "fallow CLI not on PATH and `npx --no-install fallow` failed" };
}

async function runFallow(
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
    "--quiet",
    ...extraArgs,
  ];
  if (opts.changedSinceHead) args.push("--changed-since", "HEAD");
  if (opts.subtree) args.push("--path", opts.subtree);

  const startedAt = Date.now();
  let result;
  try {
    result = await execCli((cmd, args, opts) => platform.exec(cmd, args, opts), invocation.cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "execution-failed",
      message: error instanceof Error ? error.message : "fallow execution threw",
    };
  }

  const durationMs = Date.now() - startedAt;
  if (result.killed) {
    return { ok: false, reason: "timeout", message: `fallow ${subcommand} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` };
  }
  if (result.code >= 2) {
    return {
      ok: false,
      reason: "execution-failed",
      message: `fallow ${subcommand} exited with code ${result.code}`,
      exitCode: result.code,
      stderr: result.stderr,
    };
  }

  // 0 or 1 = clean run; 1 just means findings were reported.
  return {
    ok: true,
    findings: parseFindings(result.stdout),
    durationMs,
    details: { exitCode: result.code, via: invocation.via },
  };
}

export class FallowAdapter implements SlopBackend {
  readonly id: HarnessAntiSlopBackend = "fallow";

  async isAvailable(platform: Platform): Promise<boolean> {
    const invocation = await resolveInvocation(platform);
    return invocation.ok;
  }

  async scan(platform: Platform, opts: ScanOptions): Promise<SlopBackendResult> {
    return runFallow(platform, "audit", [], opts);
  }

  async dupes(platform: Platform, opts: DupesOptions): Promise<SlopBackendResult> {
    const args: string[] = [];
    if (typeof opts.threshold === "number") args.push("--threshold", String(opts.threshold));
    if (typeof opts.minTokenCount === "number") args.push("--min-tokens", String(opts.minTokenCount));
    return runFallow(platform, "dupes", args, opts);
  }

  async deadCode(platform: Platform, opts: DeadCodeOptions): Promise<SlopBackendResult> {
    return runFallow(platform, "dead-code", [], opts);
  }

  async audit(platform: Platform, opts: AuditOptions): Promise<SlopBackendResult> {
    return runFallow(platform, "audit", [], opts);
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
    const args = [
      ...invocation.baseArgs,
      "fix",
      "--format",
      "json",
    ];
    if (opts.apply) args.push("--yes");
    else args.push("--dry-run");
    if (opts.subtree) args.push("--path", opts.subtree);

    try {
      const result = await execCli((cmd, args, opts) => platform.exec(cmd, args, opts), invocation.cmd, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (result.code >= 2) {
        return {
          ok: false,
          appliedIds: [],
          failedIds: (opts.entryIds ?? []).map((id) => ({ id, reason: `fallow fix exited ${result.code}: ${result.stderr.trim()}` })),
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
          reason: error instanceof Error ? error.message : "fallow fix threw",
        })),
      };
    }
  }
}

/** Reset the in-process availability cache. Tests use this to re-probe without restarting. */
export function _resetFallowAvailabilityCacheForTests(): void {
  availabilityCache = null;
}
