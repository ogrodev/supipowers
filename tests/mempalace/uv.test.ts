import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectUvPlatform, ensureUv, PINNED_UV_VERSION, uvTargetFor } from "../../src/mempalace/uv.js";

function sha256Hex(bytes: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function makeFetcher(map: Map<string, { status: number; bytes: ArrayBuffer }>) {
  const seen: string[] = [];
  const fetcher = mock(async (url: string) => {
    seen.push(url);
    const response = map.get(url);
    if (!response) throw new Error(`unexpected fetch: ${url}`);
    return response;
  });
  return { fetcher, seen };
}

describe("ensureUv", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-uv-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns the cached managed binary when version stamp matches", async () => {
    fs.writeFileSync(path.join(tmpDir, "uv"), "");
    fs.chmodSync(path.join(tmpDir, "uv"), 0o755);
    fs.writeFileSync(path.join(tmpDir, "uv.version"), `${PINNED_UV_VERSION}\n`);

    const fetcher = mock(async () => {
      throw new Error("should not fetch when cached");
    });
    const runner = mock(async () => ({ code: 0, stdout: "", stderr: "" }));

    const result = await ensureUv({
      managedBinDir: tmpDir,
      platform: "darwin-arm64",
      fetcher,
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.source).toBe("cached");
    expect(result.uvPath).toBe(path.join(tmpDir, "uv"));
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("fails before download when tar is unavailable", async () => {
    const fetcher = mock(async () => {
      throw new Error("should not fetch before tar preflight passes");
    });
    const runner = mock(async (command: string, args: string[]) => {
      expect(command).toBe("tar");
      expect(args).toEqual(["--version"]);
      return { code: 127, stdout: "", stderr: "command not found" };
    });

    const result = await ensureUv({
      managedBinDir: tmpDir,
      platform: "darwin-arm64",
      version: "0.5.30",
      fetcher,
      runner,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected tar preflight failure");
    expect(result.error.code).toBe("uv_extract_failed");
    expect(result.error.message).toContain("tar");
    expect(result.error.remediation).toContain("Git for Windows");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("downloads, verifies SHA256, extracts, and stamps version", async () => {
    const target = uvTargetFor("darwin-arm64");
    const archiveBytes = new TextEncoder().encode("FAKE_TAR_PAYLOAD").buffer.slice(0);
    const expectedSha = sha256Hex(archiveBytes);
    const archiveUrl = `https://github.com/astral-sh/uv/releases/download/0.5.30/${target.archive}`;
    const shaUrl = `${archiveUrl}.sha256`;

    const responses = new Map([
      [shaUrl, { status: 200, bytes: new TextEncoder().encode(`${expectedSha}  ${target.archive}\n`).buffer.slice(0) }],
      [archiveUrl, { status: 200, bytes: archiveBytes }],
    ]);
    const { fetcher, seen } = makeFetcher(responses);

    const runner = mock(async (command: string, args: string[]) => {
      expect(command).toBe("tar");
      if (args[0] === "--version") {
        return { code: 0, stdout: "tar 1.0", stderr: "" };
      }
      expect(args[0]).toBe("-xf");
      expect(args[1]).toBe(path.join(tmpDir, target.archive));
      // Simulate the tar extraction: place the binary at the expected nested path.
      const extractedBinary = path.join(tmpDir, target.archiveBinaryRelativePath);
      fs.mkdirSync(path.dirname(extractedBinary), { recursive: true });
      fs.writeFileSync(extractedBinary, "uv-binary");
      return { code: 0, stdout: "", stderr: "" };
    });

    const progress: string[] = [];
    const result = await ensureUv({
      managedBinDir: tmpDir,
      platform: "darwin-arm64",
      version: "0.5.30",
      fetcher,
      runner,
      onProgress: (m) => progress.push(m),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.source).toBe("downloaded");
    expect(result.uvPath).toBe(path.join(tmpDir, target.binary));
    expect(fs.existsSync(result.uvPath)).toBe(true);
    expect(fs.readFileSync(result.uvPath, "utf8")).toBe("uv-binary");
    expect(fs.readFileSync(path.join(tmpDir, "uv.version"), "utf8").trim()).toBe("0.5.30");
    expect(seen).toEqual([shaUrl, archiveUrl]);
    expect(progress.some((m) => m.includes("Downloading uv 0.5.30"))).toBe(true);
    expect(progress.some((m) => m.includes("Extracting uv 0.5.30"))).toBe(true);
    // archive + extracted dir cleaned up
    expect(fs.existsSync(path.join(tmpDir, target.archive))).toBe(false);
    expect(fs.existsSync(path.dirname(path.join(tmpDir, target.archiveBinaryRelativePath)))).toBe(false);
  });

  test("downloads Windows uv zip whose executable extracts at archive root", async () => {
    const target = uvTargetFor("win32-x64");
    const archiveBytes = new TextEncoder().encode("FAKE_ZIP_PAYLOAD").buffer.slice(0);
    const expectedSha = sha256Hex(archiveBytes);
    const archiveUrl = `https://github.com/astral-sh/uv/releases/download/0.5.30/${target.archive}`;
    const shaUrl = `${archiveUrl}.sha256`;

    expect(target.archiveBinaryRelativePath).toBe(target.binary);

    const responses = new Map([
      [shaUrl, { status: 200, bytes: new TextEncoder().encode(`${expectedSha}  ${target.archive}\n`).buffer.slice(0) }],
      [archiveUrl, { status: 200, bytes: archiveBytes }],
    ]);
    const { fetcher } = makeFetcher(responses);

    const runner = mock(async (command: string, args: string[]) => {
      expect(command).toBe("tar");
      if (args[0] === "--version") {
        return { code: 0, stdout: "tar 1.0", stderr: "" };
      }
      expect(args[0]).toBe("-xf");
      expect(args[1]).toBe(path.join(tmpDir, target.archive));
      const extractedBinary = path.join(tmpDir, target.archiveBinaryRelativePath);
      fs.mkdirSync(path.dirname(extractedBinary), { recursive: true });
      fs.writeFileSync(extractedBinary, "uv-windows-binary");
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await ensureUv({
      managedBinDir: tmpDir,
      platform: "win32-x64",
      version: "0.5.30",
      fetcher,
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.uvPath).toBe(path.join(tmpDir, target.binary));
    expect(fs.readFileSync(result.uvPath, "utf8")).toBe("uv-windows-binary");
    expect(fs.readFileSync(path.join(tmpDir, "uv.version"), "utf8").trim()).toBe("0.5.30");
    expect(fs.existsSync(path.join(tmpDir, target.archive))).toBe(false);
  });

  test("fails on SHA256 mismatch without writing the binary", async () => {
    const target = uvTargetFor("linux-x64");
    const archiveBytes = new TextEncoder().encode("REAL_BYTES").buffer.slice(0);
    const wrongSha = "0".repeat(64);
    const archiveUrl = `https://github.com/astral-sh/uv/releases/download/0.5.30/${target.archive}`;
    const shaUrl = `${archiveUrl}.sha256`;

    const responses = new Map([
      [shaUrl, { status: 200, bytes: new TextEncoder().encode(`${wrongSha}  ${target.archive}\n`).buffer.slice(0) }],
      [archiveUrl, { status: 200, bytes: archiveBytes }],
    ]);
    const { fetcher } = makeFetcher(responses);
    const runner = mock(async () => ({ code: 0, stdout: "", stderr: "" }));

    const result = await ensureUv({
      managedBinDir: tmpDir,
      platform: "linux-x64",
      version: "0.5.30",
      fetcher,
      runner,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("uv_checksum_mismatch");
    expect(fs.existsSync(path.join(tmpDir, target.binary))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "uv.version"))).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test("returns uv_unsupported_platform on unrecognized platform", async () => {
    const result = await ensureUv({
      managedBinDir: tmpDir,
      platform: null,
      runner: mock(async () => ({ code: 0, stdout: "", stderr: "" })),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unsupported platform");
    expect(result.error.code).toBe("uv_unsupported_platform");
  });

  test("detectUvPlatform returns expected triples", () => {
    expect(detectUvPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(detectUvPlatform("darwin", "x64")).toBe("darwin-x64");
    expect(detectUvPlatform("linux", "x64")).toBe("linux-x64");
    expect(detectUvPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(detectUvPlatform("win32", "x64")).toBe("win32-x64");
    expect(detectUvPlatform("freebsd", "x64")).toBeNull();
  });
});
