import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedMempalaceConfig } from "./config.js";
import type { MempalaceAction, MempalaceParams } from "./schema.js";

export interface MempalaceRuntimeError {
  code: string;
  message: string;
  remediation?: string;
  [key: string]: unknown;
}

export type BridgePathResult =
  | { ok: true; path: string }
  | { ok: false; path: string; error: MempalaceRuntimeError };

export interface BridgePathOptions {
  moduleUrl?: string;
}

export interface ProcessRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; input?: string },
) => Promise<ProcessRunResult>;

export type MempalaceRuntimePlatform = "posix" | "win32";

export interface ManagedVenvPaths {
  root: string;
  python: string;
  pip: string;
}

export type DiscoverPythonResult =
  | { ok: true; pythonPath: string; version: string }
  | { ok: false; error: MempalaceRuntimeError };

export interface DiscoverPythonOptions {
  configuredPython?: string | null;
  candidates?: string[];
  runner: ProcessRunner;
}

export interface MempalaceBridgeRequest {
  action: string;
  params: Record<string, unknown>;
  options: Record<string, unknown>;
}

export type MempalaceBridgeJsonResponse =
  | { ok: true; result?: unknown; diagnostics?: Record<string, unknown> }
  | { ok: false; error: MempalaceRuntimeError; diagnostics?: Record<string, unknown> };

export type RunBridgeRequestResult =
  | {
      ok: true;
      response: MempalaceBridgeJsonResponse;
      stderr: string;
      durationMs: number;
    }
  | {
      ok: false;
      error: MempalaceRuntimeError;
      stdoutPreview: string;
      stderrTail: string;
      durationMs: number;
    };

export interface RunBridgeRequestOptions {
  pythonPath: string;
  bridgeScriptPath: string;
  request: MempalaceBridgeRequest;
  timeoutMs: number;
  runner?: ProcessRunner;
}

export type SetupMempalaceRuntimeResult =
  | {
      ok: true;
      details: {
        uvPath: string;
        uvVersion: string;
        managedPython: string;
        venvPath: string;
        venvPython: string;
        packageVersion: string;
        version: unknown;
        status: unknown;
      };
    }
  | {
      ok: false;
      error: MempalaceRuntimeError;
      stderrTail?: string;
      details?: Record<string, unknown>;
    };

export interface SetupMempalaceRuntimeOptions {
  cwd: string;
  config: ResolvedMempalaceConfig;
  bridgeScriptPath: string;
  managedBinDir: string;
  managedPythonVersion?: string;
  runner?: ProcessRunner;
  fetcher?: import("./uv.js").UvFetcher;
  uvVersion?: string;
  onProgress?: (message: string) => void;
}




export function resolveBridgeScriptPath(options: BridgePathOptions = {}): BridgePathResult {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const runtimePath = fileURLToPath(moduleUrl);
  const bridgePath = path.join(path.dirname(runtimePath), "python", "mempalace_bridge.py");

  if (!fs.existsSync(bridgePath)) {
    return {
      ok: false,
      path: bridgePath,
      error: {
        code: "bridge_not_found",
        message: `Bundled MemPalace bridge not found at ${bridgePath}`,
        remediation: "Reinstall supipowers or verify the package includes src/mempalace/python/mempalace_bridge.py.",
      },
    };
  }

  return { ok: true, path: bridgePath };
}

export function resolveManagedVenvPaths(
  venvPath: string,
  platform: MempalaceRuntimePlatform = process.platform === "win32" ? "win32" : "posix",
): ManagedVenvPaths {
  if (platform === "win32") {
    return {
      root: venvPath,
      python: path.win32.join(venvPath, "Scripts", "python.exe"),
      pip: path.win32.join(venvPath, "Scripts", "pip.exe"),
    };
  }

  return {
    root: venvPath,
    python: path.join(venvPath, "bin", "python"),
    pip: path.join(venvPath, "bin", "pip"),
  };
}

function parsePythonVersion(output: string): string | null {
  const match = /Python\s+(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function isSupportedPythonVersion(version: string): boolean {
  const [majorRaw, minorRaw] = version.split(".");
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  return major > 3 || (major === 3 && minor >= 9);
}

function unsupportedPython(version: string): DiscoverPythonResult {
  return {
    ok: false,
    error: {
      code: "python_version_unsupported",
      message: `MemPalace requires Python 3.9+, found Python ${version}.`,
      remediation: "Install Python 3.9+ and configure mempalace.pythonPath or ensure python3 is on PATH.",
    },
  };
}

export async function discoverPython(options: DiscoverPythonOptions): Promise<DiscoverPythonResult> {
  const candidates = options.configuredPython
    ? [options.configuredPython]
    : options.candidates ?? ["python3", "python"];
  let unsupported: string | null = null;

  for (const candidate of candidates) {
    try {
      const result = await options.runner(candidate, ["--version"]);
      if (result.code !== 0) continue;
      const version = parsePythonVersion(`${result.stdout}\n${result.stderr}`);
      if (!version) continue;
      if (isSupportedPythonVersion(version)) {
        return { ok: true, pythonPath: candidate, version };
      }
      unsupported ??= version;
      if (options.configuredPython) return unsupportedPython(version);
    } catch {
      continue;
    }
  }

  if (unsupported) return unsupportedPython(unsupported);

  return {
    ok: false,
    error: {
      code: "python_missing",
      message: "Unable to find a Python executable for MemPalace.",
      remediation: "Install Python 3.9+ from python.org or your OS package manager, then run mempalace setup again.",
    },
  };
}

function preview(value: string, maxChars = 1000): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function tail(value: string, maxChars = 4000): string {
  return value.length <= maxChars ? value : `…${value.slice(-maxChars)}`;
}

function isBridgeResponse(value: unknown): value is MempalaceBridgeJsonResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return true;
  if (record.ok !== false) return false;
  const error = record.error;
  return typeof error === "object" && error !== null && !Array.isArray(error)
    && typeof (error as Record<string, unknown>).code === "string"
    && typeof (error as Record<string, unknown>).message === "string";
}

async function defaultProcessRunner(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; input?: string } = {},
): Promise<ProcessRunResult> {
  return await new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        child.kill("SIGKILL");
      }, options.timeoutMs)
      : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export async function runBridgeRequest(options: RunBridgeRequestOptions): Promise<RunBridgeRequestResult> {
  const started = Date.now();
  const input = JSON.stringify(options.request);
  const runner = options.runner ?? defaultProcessRunner;

  const timeout = new Promise<ProcessRunResult>((resolve) => {
    setTimeout(() => resolve({
      code: -1,
      stdout: "",
      stderr: "",
    }), options.timeoutMs);
  });

  let runResult: ProcessRunResult;
  try {
    runResult = await Promise.race([
      runner(options.pythonPath, [options.bridgeScriptPath], { input, timeoutMs: options.timeoutMs }),
      timeout,
    ]);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "bridge_process_failed",
        message: error instanceof Error ? error.message : "Failed to launch MemPalace bridge.",
        remediation: "Run mempalace setup and verify the managed Python environment is usable.",
      },
      stdoutPreview: "",
      stderrTail: "",
      durationMs: Date.now() - started,
    };
  }

  const durationMs = Date.now() - started;
  if (runResult.code === -1 && runResult.stdout.length === 0 && runResult.stderr.length === 0 && durationMs >= options.timeoutMs) {
    return {
      ok: false,
      error: {
        code: "bridge_timeout",
        message: `MemPalace bridge timed out after ${options.timeoutMs}ms.`,
        remediation: "Retry with a narrower request or run mempalace(action=\"repair\") if the palace appears stuck.",
      },
      stdoutPreview: "",
      stderrTail: "",
      durationMs,
    };
  }

  if (runResult.code !== 0) {
    return {
      ok: false,
      error: {
        code: "bridge_process_failed",
        message: `MemPalace bridge exited with code ${runResult.code}.`,
        remediation: "Run mempalace(action=\"setup\") to verify the managed Python environment.",
      },
      stdoutPreview: preview(runResult.stdout),
      stderrTail: tail(runResult.stderr),
      durationMs,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(runResult.stdout.trim());
  } catch {
    return {
      ok: false,
      error: {
        code: "bridge_protocol_error",
        message: "MemPalace bridge returned malformed JSON on stdout.",
        remediation: "Run mempalace(action=\"setup\") to verify the bundled bridge and package version.",
      },
      stdoutPreview: preview(runResult.stdout),
      stderrTail: tail(runResult.stderr),
      durationMs,
    };
  }

  if (!isBridgeResponse(parsed)) {
    return {
      ok: false,
      error: {
        code: "bridge_protocol_error",
        message: "MemPalace bridge JSON did not match the expected response protocol.",
        remediation: "Run mempalace(action=\"setup\") to verify the bundled bridge and package version.",
      },
      stdoutPreview: preview(runResult.stdout),
      stderrTail: tail(runResult.stderr),
      durationMs,
    };
  }

  return {
    ok: true,
    response: parsed,
    stderr: runResult.stderr,
    durationMs,
  };
}

const SETUP_REMEDIATION = "Run `/supi:memory setup` again, or check the displayed stderr for upstream details. The official MemPalace package is on PyPI as `mempalace`; uv (from astral-sh/uv on GitHub) is used solely to provision Python.";

function setupFailed(message: string, stderrTail?: string): SetupMempalaceRuntimeResult {
  const fullMessage = stderrTail
    ? `${message}\n\n${stderrTail}`
    : message;
  return {
    ok: false,
    error: {
      code: "setup_failed",
      message: fullMessage,
      remediation: SETUP_REMEDIATION,
    },
    stderrTail,
  };
}

async function runSetupCommand(
  runner: ProcessRunner,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<ProcessRunResult> {
  return await runner(command, args, { timeoutMs });
}

export async function setupMempalaceRuntime(
  options: SetupMempalaceRuntimeOptions,
): Promise<SetupMempalaceRuntimeResult> {
  const progress = (message: string) => options.onProgress?.(message);
  const setupTimeout = options.config.timeouts.setupMs;
  const packageSpec = `mempalace==${options.config.packageVersion}`;
  const managedPythonVersion = options.managedPythonVersion ?? "3.12";
  const runner = options.runner ?? defaultProcessRunner;

  // 1. Ensure uv is available (download + verify if needed).
  const { ensureUv } = await import("./uv.js");
  const uv = await ensureUv({
    managedBinDir: options.managedBinDir,
    runner,
    fetcher: options.fetcher,
    version: options.uvVersion,
    onProgress: progress,
  });
  if (!uv.ok) return { ok: false, error: uv.error };

  // 2. Have uv install the managed Python interpreter (no-op if already installed).
  progress(`Provisioning managed Python ${managedPythonVersion} via uv`);
  const pythonInstall = await runSetupCommand(
    runner,
    uv.uvPath,
    ["python", "install", managedPythonVersion],
    setupTimeout,
  );
  if (pythonInstall.code !== 0) {
    return setupFailed(
      `uv failed to install Python ${managedPythonVersion}.`,
      tail(pythonInstall.stderr || pythonInstall.stdout),
    );
  }

  // 3. Create (or recreate) the managed virtual environment.
  if (fs.existsSync(options.config.managedVenvPath)) {
    fs.rmSync(options.config.managedVenvPath, { recursive: true, force: true });
  }
  progress("Creating managed MemPalace virtual environment");
  const createVenv = await runSetupCommand(
    runner,
    uv.uvPath,
    ["venv", options.config.managedVenvPath, "--python", managedPythonVersion],
    setupTimeout,
  );
  if (createVenv.code !== 0) {
    return setupFailed(
      "Failed to create the managed MemPalace virtual environment.",
      tail(createVenv.stderr || createVenv.stdout),
    );
  }

  const venv = resolveManagedVenvPaths(options.config.managedVenvPath);

  // 4. Install MemPalace from PyPI into the managed venv.
  progress(`Installing ${packageSpec} from PyPI`);
  const installPackage = await runSetupCommand(
    runner,
    uv.uvPath,
    ["pip", "install", "--python", venv.python, packageSpec],
    setupTimeout,
  );
  if (installPackage.code !== 0) {
    return setupFailed(
      `Failed to install ${packageSpec} from PyPI.`,
      tail(installPackage.stderr || installPackage.stdout),
    );
  }

  // 5. Verify the bridge can import MemPalace and inspect the palace.
  progress("Verifying MemPalace bridge");
  const version = await runBridgeRequest({
    pythonPath: venv.python,
    bridgeScriptPath: options.bridgeScriptPath,
    timeoutMs: options.config.timeouts.bridgeMs,
    request: {
      action: "version",
      params: {},
      options: {
        cwd: options.cwd,
        palacePath: options.config.palacePath,
        agentName: options.config.defaultAgentName,
      },
    },
    runner,
  });
  if (!version.ok) return { ok: false, error: version.error, stderrTail: version.stderrTail };

  progress("Checking MemPalace palace status");
  const status = await runBridgeRequest({
    pythonPath: venv.python,
    bridgeScriptPath: options.bridgeScriptPath,
    timeoutMs: options.config.timeouts.bridgeMs,
    request: {
      action: "status",
      params: {},
      options: {
        cwd: options.cwd,
        palacePath: options.config.palacePath,
        agentName: options.config.defaultAgentName,
      },
    },
    runner,
  });
  if (!status.ok) return { ok: false, error: status.error, stderrTail: status.stderrTail };

  return {
    ok: true,
    details: {
      uvPath: uv.uvPath,
      uvVersion: uv.version,
      managedPython: managedPythonVersion,
      venvPath: venv.root,
      venvPython: venv.python,
      packageVersion: options.config.packageVersion,
      version: version.response.ok ? version.response.result : version.response.error,
      status: status.response.ok ? status.response.result : status.response.error,
    },
  };
}

export function buildMempalaceCliArgs(
  action: Extract<MempalaceAction, "init" | "mine" | "split" | "repair">,
  params: Partial<MempalaceParams>,
): string[] {
  const args: string[] = [action];
  if (action === "split") {
    if (params.source_file) args.push(params.source_file);
  } else if (params.dir) {
    args.push(params.dir);
  }

  if (typeof params.limit === "number") args.push("--limit", String(params.limit));
  if (params.mode) args.push("--mode", params.mode);
  if (params.extract) args.push("--extract");
  if (params.dry_run) args.push("--dry-run");
  if (params.include_ignored) args.push("--include-ignored");
  if (params.no_gitignore) args.push("--no-gitignore");
  if (params.yes) args.push("--yes");
  return args;
}
