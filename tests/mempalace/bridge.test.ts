import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverPython,
  resolveBridgeScriptPath,
  runBridgeRequest,
  type ProcessRunner,
} from "../../src/mempalace/runtime.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { createMempalaceBridge } from "../../src/mempalace/bridge.js";
import { resolveMempalaceConfig } from "../../src/mempalace/config.js";
import { createPaths } from "../../src/platform/types.js";

function bunProcessRunner(env: Record<string, string | undefined> = process.env): ProcessRunner {
  return async (command, args, options) => {
    const proc = Bun.spawn([command, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    if (options?.input !== undefined) {
      proc.stdin.write(options.input);
    }
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };
}

describe("mempalace Python bridge skeleton", () => {
  test("resolves the bundled bridge script", () => {
    const resolved = resolveBridgeScriptPath();
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.path.endsWith(path.join("src", "mempalace", "python", "mempalace_bridge.py"))).toBe(true);
  });

  const bridgeSmokeTimeoutMs = process.platform === "win32" ? 15_000 : 5_000;

  test("reports version without importing heavy MemPalace modules", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-pythonpath-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "mempalace"));
      fs.writeFileSync(path.join(tmpDir, "mempalace", "__init__.py"), "raise RuntimeError('heavy import should not run')\n");
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir });
      const python = await discoverPython({ candidates: ["python3", "python"], runner });
      if (!python.ok) {
        expect(python.error.code).toBe("python_missing");
        return;
      }
      const bridge = resolveBridgeScriptPath();
      expect(bridge.ok).toBe(true);
      if (!bridge.ok) throw new Error(bridge.error.message);

      const result = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: bridgeSmokeTimeoutMs,
        request: { action: "version", params: {}, options: { palacePath: "/tmp/palace" } },
        runner,
      });

      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      expect(result.response.ok).toBe(true);
      if (!result.response.ok) throw new Error(result.response.error.message);
      expect(result.response.result).toMatchObject({ bridgeVersion: expect.any(String) });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects unknown actions deny-by-default", async () => {
    const runner = bunProcessRunner();
    const python = await discoverPython({ candidates: ["python3", "python"], runner });
    if (!python.ok) {
      expect(python.error.code).toBe("python_missing");
      return;
    }
    const bridge = resolveBridgeScriptPath();
    expect(bridge.ok).toBe(true);
    if (!bridge.ok) throw new Error(bridge.error.message);

    const result = await runBridgeRequest({
      pythonPath: python.pythonPath,
      bridgeScriptPath: bridge.path,
      timeoutMs: 5000,
      request: { action: "unknown_action", params: {}, options: {} },
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.response.ok).toBe(false);
    if (result.response.ok) throw new Error("expected domain error");
    expect(result.response.error.code).toBe("unknown_action");
  });
});

describe("mempalace Python bridge stdout isolation", () => {
  test("import-time prints from MemPalace go to stderr, never corrupting JSON stdout", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-stdout-"));
    try {
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      // Loud import-time prints — exactly the failure mode that broke the user's
      // bridge with `bridge_protocol_error` (chromadb telemetry banners etc.).
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "print('chromadb telemetry banner')\nprint('initializing mempalace 3.3.4')\n");
      fs.writeFileSync(path.join(packageDir, "mcp_server.py"), `
print('imported mcp_server')
def tool_status(**kw):
    print('inside tool_status')
    return {"ready": True, "wings": []}
`);
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir });
      const python = await discoverPython({ candidates: ["python3", "python"], runner });
      if (!python.ok) {
        expect(python.error.code).toBe("python_missing");
        return;
      }
      const bridge = resolveBridgeScriptPath();
      expect(bridge.ok).toBe(true);
      if (!bridge.ok) throw new Error(bridge.error.message);

      const result = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: { action: "status", params: {}, options: {} },
        runner,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.response.ok).toBe(true);
      if (!result.response.ok) throw new Error(result.response.error.message);
      expect(result.response.result).toMatchObject({ ready: true, wings: [] });
      // The captured prints land on stderr.
      expect(result.stderr).toContain("chromadb telemetry banner");
      expect(result.stderr).toContain("inside tool_status");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("mempalace Python bridge MCP-equivalent actions", () => {
  test("dispatches read/search/check actions to mempalace.mcp_server.tool_*", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-mcp-"));
    const callsFile = path.join(tmpDir, "calls.jsonl");
    try {
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "");
      // Real MemPalace's mcp_server.py exports tool_<action>(**kwargs); the
      // bridge calls them as such. The shim records the action + kwargs.
      fs.writeFileSync(path.join(packageDir, "mcp_server.py"), `
import json
import os

def _record(action, kwargs):
    with open(os.environ["CALLS_FILE"], "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"action": action, "kwargs": kwargs}, sort_keys=True) + "\\n")
    return {"action": action, "kwargs": kwargs, "ok_from_shim": True}

def tool_status(**kw): return _record("tool_status", kw)
def tool_list_wings(**kw): return _record("tool_list_wings", kw)
def tool_list_rooms(**kw): return _record("tool_list_rooms", kw)
def tool_get_taxonomy(**kw): return _record("tool_get_taxonomy", kw)
def tool_search(**kw): return _record("tool_search", kw)
def tool_check_duplicate(**kw): return _record("tool_check_duplicate", kw)
def tool_get_aaak_spec(**kw): return _record("tool_get_aaak_spec", kw)
def tool_get_drawer(**kw): return _record("tool_get_drawer", kw)
def tool_list_drawers(**kw): return _record("tool_list_drawers", kw)
`);
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir, CALLS_FILE: callsFile });
      const python = await discoverPython({ candidates: ["python3", "python"], runner });
      if (!python.ok) {
        expect(python.error.code).toBe("python_missing");
        return;
      }
      const bridge = resolveBridgeScriptPath();
      expect(bridge.ok).toBe(true);
      if (!bridge.ok) throw new Error(bridge.error.message);

      const requests = [
        ["status", {}, "tool_status", {}],
        ["list_wings", {}, "tool_list_wings", {}],
        ["list_rooms", { wing: "supipowers" }, "tool_list_rooms", { wing: "supipowers" }],
        ["get_taxonomy", {}, "tool_get_taxonomy", {}],
        ["search", { query: "auth", limit: 3, wing: "supipowers" }, "tool_search", { query: "auth", limit: 3, wing: "supipowers" }],
        ["check_duplicate", { content: "remember me" }, "tool_check_duplicate", { content: "remember me" }],
        ["get_aaak_spec", {}, "tool_get_aaak_spec", {}],
        ["get_drawer", { drawer_id: "d1" }, "tool_get_drawer", { drawer_id: "d1" }],
        ["list_drawers", { wing: "supipowers", room: "auth", limit: 10, offset: 0 }, "tool_list_drawers", { wing: "supipowers", room: "auth", limit: 10, offset: 0 }],
      ] as const;

      for (const [action, params, expectedFunc, expectedKwargs] of requests) {
        const result = await runBridgeRequest({
          pythonPath: python.pythonPath,
          bridgeScriptPath: bridge.path,
          timeoutMs: 5000,
          request: { action, params, options: { palacePath: "/tmp/palace" } },
          runner,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        expect(result.response.ok).toBe(true);
        if (!result.response.ok) throw new Error(result.response.error.message);
        expect(result.response.result).toMatchObject({ action: expectedFunc, kwargs: expectedKwargs, ok_from_shim: true });
      }

      const calls = fs.readFileSync(callsFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.map((call) => call.action)).toEqual(requests.map(([_a, _b, fn]) => fn));
      // palacePath option propagates via env var, not kwargs — but our search call
      // should have kept its model-facing kwargs intact.
      const searchCall = calls.find((c) => c.action === "tool_search");
      expect(searchCall.kwargs).toEqual({ query: "auth", limit: 3, wing: "supipowers" });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("renames params to MemPalace argument names for kg, traverse, find_tunnels, follow_tunnels", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-rename-"));
    const callsFile = path.join(tmpDir, "calls.jsonl");
    try {
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "");
      fs.writeFileSync(path.join(packageDir, "mcp_server.py"), `
import json
import os

def _record(action, kwargs):
    with open(os.environ["CALLS_FILE"], "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"action": action, "kwargs": kwargs}, sort_keys=True) + "\\n")
    return {"action": action, "kwargs": kwargs}

def tool_kg_query(**kw): return _record("tool_kg_query", kw)
def tool_kg_timeline(**kw): return _record("tool_kg_timeline", kw)
def tool_traverse_graph(**kw): return _record("tool_traverse_graph", kw)
def tool_find_tunnels(**kw): return _record("tool_find_tunnels", kw)
def tool_follow_tunnels(**kw): return _record("tool_follow_tunnels", kw)
`);
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir, CALLS_FILE: callsFile });
      const python = await discoverPython({ candidates: ["python3", "python"], runner });
      if (!python.ok) return;
      const bridge = resolveBridgeScriptPath();
      if (!bridge.ok) throw new Error(bridge.error.message);

      // kg_query: subject -> entity
      const kgQuery = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: { action: "kg_query", params: { subject: "Kai", direction: "both" }, options: {} },
        runner,
      });
      expect(kgQuery.ok).toBe(true);
      // kg_timeline: subject -> entity_name (per public API; bridge maps subject -> entity)
      const kgTimeline = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: { action: "kg_timeline", params: { subject: "Orion" }, options: {} },
        runner,
      });
      expect(kgTimeline.ok).toBe(true);
      // traverse uses tool_traverse_graph
      const traverse = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: { action: "traverse", params: { start_room: "auth", max_hops: 3 }, options: {} },
        runner,
      });
      expect(traverse.ok).toBe(true);
      // find_tunnels: source_wing/target_wing -> wing_a/wing_b
      const findTunnels = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: { action: "find_tunnels", params: { source_wing: "code", target_wing: "team" }, options: {} },
        runner,
      });
      expect(findTunnels.ok).toBe(true);
      // follow_tunnels: source_wing/source_room -> wing/room
      const followTunnels = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: { action: "follow_tunnels", params: { source_wing: "code", source_room: "auth" }, options: {} },
        runner,
      });
      expect(followTunnels.ok).toBe(true);

      const calls = fs.readFileSync(callsFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.find((c) => c.action === "tool_kg_query").kwargs).toEqual({ entity: "Kai", direction: "both" });
      expect(calls.find((c) => c.action === "tool_kg_timeline").kwargs).toEqual({ entity: "Orion" });
      expect(calls.find((c) => c.action === "tool_traverse_graph").kwargs).toEqual({ start_room: "auth", max_hops: 3 });
      expect(calls.find((c) => c.action === "tool_find_tunnels").kwargs).toEqual({ wing_a: "code", wing_b: "team" });
      expect(calls.find((c) => c.action === "tool_follow_tunnels").kwargs).toEqual({ wing: "code", room: "auth" });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("preserves MemPalace domain errors returned as { ok: false, error }", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-domain-"));
    try {
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "");
      fs.writeFileSync(path.join(packageDir, "mcp_server.py"), `
def tool_kg_stats(**kw):
    return {"ok": False, "error": {"code": "kg_unavailable", "message": "KG locked", "detail": {"reason": "writer-busy"}}}
`);
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir });
      const python = await discoverPython({ candidates: ["python3", "python"], runner });
      if (!python.ok) return;
      const bridge = resolveBridgeScriptPath();
      if (!bridge.ok) throw new Error(bridge.error.message);

      const result = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: { action: "kg_stats", params: {}, options: { palacePath: "/tmp/palace" } },
        runner,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.response.ok).toBe(false);
      if (result.response.ok) throw new Error("expected domain error");
      expect(result.response.error).toMatchObject({ code: "kg_unavailable", detail: { reason: "writer-busy" } });
      expect(result.response.diagnostics?.palacePath).toBe("/tmp/palace");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns mempalace_missing when mcp_server module is absent", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-missing-"));
    try {
      // Create a mempalace package WITHOUT mcp_server so importlib raises ModuleNotFoundError.
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "");
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir });
      const python = await discoverPython({ candidates: ["python3", "python"], runner });
      if (!python.ok) return;
      const bridge = resolveBridgeScriptPath();
      if (!bridge.ok) throw new Error(bridge.error.message);

      const result = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: { action: "status", params: {}, options: {} },
        runner,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.response.ok).toBe(false);
      if (result.response.ok) throw new Error("expected error");
      expect(result.response.error.code).toBe("mempalace_missing");
      expect(result.response.error.message).toContain("mempalace.mcp_server");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("mempalace Python bridge wake_up + native CLI actions", () => {
  test("wake_up dispatches to mempalace.layers.MemoryStack", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-wake-"));
    try {
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "");
      fs.writeFileSync(path.join(packageDir, "layers.py"), `
class MemoryStack:
    def __init__(self, palace_path=None, **_):
        self.palace_path = palace_path
    def wake_up(self, wing=None, **_):
        return f"L0+L1 for wing={wing} palace={self.palace_path}"
`);
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir });
      const python = await discoverPython({ candidates: ["python3", "python"], runner });
      if (!python.ok) return;
      const bridge = resolveBridgeScriptPath();
      if (!bridge.ok) throw new Error(bridge.error.message);

      const result = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: { action: "wake_up", params: { wing: "supipowers" }, options: { palacePath: "/tmp/palace" } },
        runner,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.response.ok).toBe(true);
      if (!result.response.ok) throw new Error(result.response.error.message);
      expect(result.response.result).toEqual({ text: "L0+L1 for wing=supipowers palace=/tmp/palace" });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("init/mine/split/repair invoke `python -m mempalace.cli` with the right argv", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-cli-"));
    const argvFile = path.join(tmpDir, "argv.jsonl");
    try {
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "");
      // python -m mempalace.cli runs cli.py as __main__, so capture sys.argv
      // and print a recognizable line to stdout (which the bridge passes
      // through verbatim in result.stdout).
      fs.writeFileSync(path.join(packageDir, "cli.py"), `
import json
import os
import sys
with open(os.environ["ARGV_FILE"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\\n")
print(f"mempalace shim ran: {' '.join(sys.argv[1:])}")
`);
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir, ARGV_FILE: argvFile });
      const python = await discoverPython({ candidates: ["python3", "python"], runner });
      if (!python.ok) return;
      const bridge = resolveBridgeScriptPath();
      if (!bridge.ok) throw new Error(bridge.error.message);

      const requests = [
        ["init", { dir: ".", yes: true }, ["init", ".", "--yes"]],
        ["mine", { dir: "src", limit: 5, include_ignored: true }, ["mine", "src", "--limit", "5", "--include-ignored"]],
        ["split", { source_file: "transcript.md", mode: "conversation" }, ["split", "transcript.md", "--mode", "conversation"]],
        ["repair", { yes: true, dry_run: true }, ["repair", "--yes", "--dry-run"]],
      ] as const;
      for (const [action, params, expectedArgv] of requests) {
        const result = await runBridgeRequest({
          pythonPath: python.pythonPath,
          bridgeScriptPath: bridge.path,
          timeoutMs: 10000,
          request: { action, params, options: { cwd: tmpDir } },
          runner,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        expect(result.response.ok).toBe(true);
        if (!result.response.ok) throw new Error(result.response.error.message);
        expect((result.response.result as any).argv).toEqual([...expectedArgv]);
        expect((result.response.result as any).stdout).toContain("mempalace shim ran");
      }

      const argvLines = fs.readFileSync(argvFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      expect(argvLines).toEqual(requests.map(([_a, _b, argv]) => [...argv]));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("CLI failure exits non-zero and surfaces stderr", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-cli-fail-"));
    try {
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "");
      fs.writeFileSync(path.join(packageDir, "cli.py"), `
import sys
print("simulated failure: missing dir entries", file=sys.stderr)
sys.exit(2)
`);
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir });
      const python = await discoverPython({ candidates: ["python3", "python"], runner });
      if (!python.ok) return;
      const bridge = resolveBridgeScriptPath();
      if (!bridge.ok) throw new Error(bridge.error.message);

      const result = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: { action: "init", params: { dir: ".", yes: true }, options: {} },
        runner,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.response.ok).toBe(false);
      if (result.response.ok) throw new Error("expected error");
      expect(result.response.error.code).toBe("mempalace_cli_failed");
      expect((result.response.error as any).stderr).toContain("simulated failure");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("mempalace TypeScript bridge facade", () => {
  const config = resolveMempalaceConfig(DEFAULT_CONFIG, process.cwd(), createPaths(".omp"));

  test("normalizes successful runtime responses with diagnostics and timing", async () => {
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async () => ({
          ok: true,
          response: { ok: true, result: { ready: true }, diagnostics: { mempalaceVersion: "3.3.4" } },
          stderr: "warning\n",
          durationMs: 42,
        }),
      },
    });

    const result = await bridge.execute({ action: "status" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.result).toEqual({ ready: true });
    expect(result.diagnostics).toMatchObject({ mempalaceVersion: "3.3.4", stderr: "warning\n", durationMs: 42 });
  });

  test("treats tool timeout values as seconds", async () => {
    const calls: Array<{ timeoutMs: number }> = [];
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async (options) => {
          calls.push({ timeoutMs: options.timeoutMs });
          return {
            ok: true,
            response: { ok: true, result: { ready: true } },
            stderr: "",
            durationMs: 1,
          };
        },
      },
    });

    await bridge.execute({ action: "status", timeout: 10 });

    expect(calls).toEqual([{ timeoutMs: 10_000 }]);
  });

  test("caps tool timeout at the configured bridge timeout", async () => {
    const calls: Array<{ timeoutMs: number }> = [];
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async (options) => {
          calls.push({ timeoutMs: options.timeoutMs });
          return {
            ok: true,
            response: { ok: true, result: { ready: true } },
            stderr: "",
            durationMs: 1,
          };
        },
      },
    });

    await bridge.execute({ action: "status", timeout: 30000 });

    expect(calls).toEqual([{ timeoutMs: config.timeouts.bridgeMs }]);
  });

  test("normalizes MemPalace domain errors without throwing", async () => {
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async () => ({
          ok: true,
          response: { ok: false, error: { code: "palace_missing", message: "No palace" }, diagnostics: { palacePath: "/tmp/palace" } },
          stderr: "",
          durationMs: 7,
        }),
      },
    });

    const result = await bridge.execute({ action: "search", query: "x" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toMatchObject({ code: "palace_missing", message: "No palace" });
    expect(result.diagnostics).toMatchObject({ palacePath: "/tmp/palace", durationMs: 7 });
  });

  test("returns missing runtime diagnostics before dispatch", async () => {
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({
          ok: false,
          path: "/missing.py",
          error: { code: "bridge_not_found", message: "Missing bridge" },
        }),
        runBridgeRequest: async () => {
          throw new Error("should not run");
        },
      },
    });

    const result = await bridge.execute({ action: "status" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("bridge_not_found");
    expect(result.diagnostics.bridgeScriptPath).toBe("/missing.py");
  });

  test("adds setup remediation for missing MemPalace runtime failures", async () => {
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async () => ({
          ok: false,
          error: { code: "mempalace_missing", message: "MemPalace missing" },
          stdoutPreview: "",
          stderrTail: "No module named mempalace",
          durationMs: 3,
        }),
      },
    });

    const result = await bridge.execute({ action: "status" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("mempalace_missing");
    expect(result.error.remediation).toContain("mempalace(action=\"setup\")");
    expect(result.diagnostics).toMatchObject({ stderrTail: "No module named mempalace", durationMs: 3 });
  });
});
