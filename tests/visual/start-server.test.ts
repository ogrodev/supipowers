import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startVisualServer } from "../../src/visual/start-server.js";

describe("startVisualServer", () => {
  let tmpDir: string;
  let originalSpawn: typeof Bun.spawn;
  let originalKill: typeof process.kill;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-start-server-"));
    originalSpawn = Bun.spawn;
    originalKill = process.kill;
  });

  afterEach(() => {
    (Bun as any).spawn = originalSpawn;
    (process as any).kill = originalKill;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("starts the visual server with derived localhost URL host", async () => {
    const unref = mock();
    const spawn = mock((_cmd: string[], options: any) => {
      const sessionDir = options.env.SUPI_VISUAL_DIR as string;
      fs.writeFileSync(
        path.join(sessionDir, ".server-info"),
        JSON.stringify({
          port: 7777,
          host: options.env.SUPI_VISUAL_HOST,
          url: `http://${options.env.SUPI_VISUAL_URL_HOST}:7777`,
          screen_dir: sessionDir,
        }) + "\n",
      );

      return {
        pid: 4242,
        unref,
      };
    });

    (Bun as any).spawn = spawn;
    (process as any).kill = mock((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === 4242 && signal === 0) return true;
      return true;
    });

    const result = await startVisualServer({ sessionDir: tmpDir });

    expect(result).toEqual({
      port: 7777,
      host: "127.0.0.1",
      url: "http://localhost:7777",
      screenDir: tmpDir,
    });
    expect(fs.readFileSync(path.join(tmpDir, ".server.pid"), "utf-8").trim()).toBe("4242");
    expect(unref).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);

    const [cmd, options] = spawn.mock.calls[0] as [string[], any];
    expect(cmd).toEqual(["node", "index.js"]);
    expect(options.cwd).toContain(path.join("visual", "scripts"));
    expect(options.detached).toBe(true);
    expect(options.stdin).toBe("ignore");
    expect(options.stdout).toBe("ignore");
    expect(options.stderr).toBe("ignore");
    expect(options.env.SUPI_VISUAL_DIR).toBe(tmpDir);
    expect(options.env.SUPI_VISUAL_HOST).toBe("127.0.0.1");
    expect(options.env.SUPI_VISUAL_URL_HOST).toBe("localhost");
  });

  test("returns null and cleans startup artifacts when the server never becomes ready", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".server-info"),
      JSON.stringify({ port: 1, host: "stale", url: "http://stale", screen_dir: tmpDir }) + "\n",
    );

    (Bun as any).spawn = mock(() => ({
      pid: 5151,
      unref: mock(),
    }));
    (process as any).kill = mock((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === 5151 && signal === 0) {
        throw new Error("dead");
      }
      throw new Error("dead");
    });

    const result = await startVisualServer({ sessionDir: tmpDir });

    expect(result).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, ".server.pid"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".server-info"))).toBe(false);
  });
});
