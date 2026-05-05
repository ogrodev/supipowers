import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MempalaceRuntimeError, ProcessRunner } from "./runtime.js";

/**
 * Pinned uv release version. Updating this constant is the only way to bump uv.
 * Astral's release URLs and per-asset SHA256 files are stable, but the SHA256 is
 * verified per-download so a tampered mirror cannot inject a different binary.
 */
export const PINNED_UV_VERSION = "0.5.30";

const UV_BASE_URL = "https://github.com/astral-sh/uv/releases/download";

export type UvPlatform =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-arm64"
  | "win32-x64";

export interface UvTarget {
  triple: string;
  archive: string;
  binary: string;
  archiveBinaryRelativePath: string;
}

export function detectUvPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): UvPlatform | null {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return null;
}

export function uvTargetFor(uvPlatform: UvPlatform): UvTarget {
  switch (uvPlatform) {
    case "darwin-arm64":
      return target("aarch64-apple-darwin", ".tar.gz", "uv");
    case "darwin-x64":
      return target("x86_64-apple-darwin", ".tar.gz", "uv");
    case "linux-x64":
      return target("x86_64-unknown-linux-gnu", ".tar.gz", "uv");
    case "linux-arm64":
      return target("aarch64-unknown-linux-gnu", ".tar.gz", "uv");
    case "win32-x64":
      return target("x86_64-pc-windows-msvc", ".zip", "uv.exe");
  }
}

function target(triple: string, archiveSuffix: string, binary: string): UvTarget {
  const archive = `uv-${triple}${archiveSuffix}`;
  return {
    triple,
    archive,
    binary,
    archiveBinaryRelativePath: path.join(`uv-${triple}`, binary),
  };
}

export interface UvFetchResponse {
  status: number;
  bytes: ArrayBuffer;
}

export type UvFetcher = (url: string) => Promise<UvFetchResponse>;

async function defaultFetcher(url: string): Promise<UvFetchResponse> {
  const response = await fetch(url);
  return { status: response.status, bytes: await response.arrayBuffer() };
}

export interface EnsureUvOptions {
  managedBinDir: string;
  version?: string;
  platform?: UvPlatform | null;
  fetcher?: UvFetcher;
  runner: ProcessRunner;
  onProgress?: (message: string) => void;
}

export type EnsureUvResult =
  | { ok: true; uvPath: string; version: string; source: "cached" | "downloaded" }
  | { ok: false; error: MempalaceRuntimeError };

function sha256(bytes: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function parseShaFile(text: string): string | null {
  const match = /\b([0-9a-f]{64})\b/i.exec(text);
  return match ? match[1].toLowerCase() : null;
}

function versionStampPath(managedBinDir: string): string {
  return path.join(managedBinDir, "uv.version");
}

function readVersionStamp(managedBinDir: string): string | null {
  try {
    return fs.readFileSync(versionStampPath(managedBinDir), "utf8").trim();
  } catch {
    return null;
  }
}

function writeVersionStamp(managedBinDir: string, version: string): void {
  fs.writeFileSync(versionStampPath(managedBinDir), `${version}\n`, "utf8");
}

export async function ensureUv(options: EnsureUvOptions): Promise<EnsureUvResult> {
  const version = options.version ?? PINNED_UV_VERSION;
  const uvPlatform = options.platform === undefined ? detectUvPlatform() : options.platform;
  if (!uvPlatform) {
    return {
      ok: false,
      error: {
        code: "uv_unsupported_platform",
        message: `MemPalace setup does not yet support ${process.platform}/${process.arch}.`,
        remediation: "File an issue with supipowers, or set MEMPALACE_PYTHON to a Python 3.9+ on PATH.",
      },
    };
  }

  const targetSpec = uvTargetFor(uvPlatform);
  const managedPath = path.join(options.managedBinDir, targetSpec.binary);

  if (fs.existsSync(managedPath) && readVersionStamp(options.managedBinDir) === version) {
    return { ok: true, uvPath: managedPath, version, source: "cached" };
  }

  const fetcher = options.fetcher ?? defaultFetcher;
  options.onProgress?.(`Downloading uv ${version} for ${targetSpec.triple}`);

  const archiveUrl = `${UV_BASE_URL}/${version}/${targetSpec.archive}`;
  const shaUrl = `${archiveUrl}.sha256`;

  let shaResponse: UvFetchResponse;
  try {
    shaResponse = await fetcher(shaUrl);
  } catch (error) {
    return uvNetworkError(`fetch checksum at ${shaUrl}`, error);
  }
  if (shaResponse.status !== 200) {
    return {
      ok: false,
      error: {
        code: "uv_download_failed",
        message: `Failed to fetch uv checksum (HTTP ${shaResponse.status}) at ${shaUrl}.`,
        remediation: "Verify network access to github.com and retry `/supi:memory setup`.",
      },
    };
  }
  const expectedSha = parseShaFile(new TextDecoder().decode(shaResponse.bytes));
  if (!expectedSha) {
    return {
      ok: false,
      error: {
        code: "uv_checksum_invalid",
        message: `uv checksum file at ${shaUrl} did not contain a valid SHA256.`,
        remediation: "Retry. If this persists, the upstream uv release manifest may be malformed.",
      },
    };
  }

  let archiveResponse: UvFetchResponse;
  try {
    archiveResponse = await fetcher(archiveUrl);
  } catch (error) {
    return uvNetworkError(`fetch archive at ${archiveUrl}`, error);
  }
  if (archiveResponse.status !== 200) {
    return {
      ok: false,
      error: {
        code: "uv_download_failed",
        message: `Failed to fetch uv archive (HTTP ${archiveResponse.status}) at ${archiveUrl}.`,
        remediation: "Verify network access to github.com and retry `/supi:memory setup`.",
      },
    };
  }
  const actualSha = sha256(archiveResponse.bytes);
  if (actualSha !== expectedSha) {
    return {
      ok: false,
      error: {
        code: "uv_checksum_mismatch",
        message: `uv archive SHA256 mismatch (expected ${expectedSha}, got ${actualSha}).`,
        remediation: "Retry; if it persists, the network path to github.com may be tampered with.",
      },
    };
  }

  fs.mkdirSync(options.managedBinDir, { recursive: true });
  const archivePath = path.join(options.managedBinDir, targetSpec.archive);
  fs.writeFileSync(archivePath, Buffer.from(archiveResponse.bytes));

  options.onProgress?.(`Extracting uv ${version}`);
  const extract = await options.runner("tar", ["-xf", archivePath, "-C", options.managedBinDir]);
  if (extract.code !== 0) {
    return {
      ok: false,
      error: {
        code: "uv_extract_failed",
        message: `tar failed to extract uv archive (code ${extract.code}): ${
          extract.stderr.trim() || extract.stdout.trim() || "no output"
        }`,
        remediation: "Ensure tar is on PATH (built-in on macOS, Linux, and Windows 10+).",
      },
    };
  }

  const extractedBinary = path.join(options.managedBinDir, targetSpec.archiveBinaryRelativePath);
  if (!fs.existsSync(extractedBinary)) {
    return {
      ok: false,
      error: {
        code: "uv_extract_failed",
        message: `uv binary not found at ${extractedBinary} after tar extraction.`,
      },
    };
  }

  // Replace any pre-existing managed binary atomically-ish.
  if (fs.existsSync(managedPath)) {
    try { fs.unlinkSync(managedPath); } catch { /* best effort */ }
  }
  fs.renameSync(extractedBinary, managedPath);
  if (process.platform !== "win32") {
    fs.chmodSync(managedPath, 0o755);
  }

  // Cleanup the extracted directory and downloaded archive.
  try { fs.rmSync(path.join(options.managedBinDir, `uv-${targetSpec.triple}`), { recursive: true, force: true }); } catch { /* */ }
  try { fs.unlinkSync(archivePath); } catch { /* */ }

  writeVersionStamp(options.managedBinDir, version);

  return { ok: true, uvPath: managedPath, version, source: "downloaded" };
}

function uvNetworkError(action: string, error: unknown): EnsureUvResult {
  return {
    ok: false,
    error: {
      code: "uv_download_failed",
      message: `Network error trying to ${action}: ${(error as Error).message}`,
      remediation: "Check internet connectivity and retry `/supi:memory setup`.",
    },
  };
}
