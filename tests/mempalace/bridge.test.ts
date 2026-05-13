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
import { MEMPALACE_PACKAGE_VERSION } from "../../src/mempalace/upstream-limits.js";

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

  test("wake_up_and_search batches params and isolates half failures", async () => {
    const callsFile = path.join(os.tmpdir(), `supi-batch-test-${Date.now()}.jsonl`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-batch-"));
    try {
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "");
      fs.writeFileSync(path.join(packageDir, "layers.py"), `
class MemoryStack:
    def __init__(self, palace_path=None):
        self.palace_path = palace_path
    def wake_up(self, **kwargs):
        wing = kwargs.get("wing")
        if wing == "wake-fails":
            raise RuntimeError("wake exploded")
        return f"wake:{wing}:{self.palace_path}"
`);
      fs.writeFileSync(path.join(packageDir, "mcp_server.py"), `
import json, os
def tool_search(**kwargs):
    with open(os.environ["CALLS_FILE"], "a", encoding="utf-8") as fh:
        fh.write(json.dumps(kwargs, sort_keys=True) + "\\n")
    if kwargs.get("query") == "search-fails":
        raise RuntimeError("search exploded")
    if kwargs.get("query") == "domain-fails":
        return {"ok": False, "error": {"code": "bad_query", "message": "domain search failed"}}
    return {"query": kwargs.get("query"), "count": 1, "results": [{"id": "r1", "content": "hit"}]}
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

      const success = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: {
          action: "wake_up_and_search",
          params: { wing: "project", room: "notes", query: "auth", limit: 3 },
          options: { palacePath: "/tmp/palace" },
        },
        runner,
      });
      expect(success.ok).toBe(true);
      if (!success.ok) throw new Error(success.error.message);
      expect(success.response.ok).toBe(true);
      if (!success.response.ok) throw new Error(success.response.error.message);
      expect(success.response.result).toMatchObject({
        wake: { text: "wake:project:/tmp/palace" },
        search: { query: "auth", count: 1 },
      });

      const searchFailure = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: {
          action: "wake_up_and_search",
          params: { wing: "project", query: "search-fails", limit: 3 },
          options: { palacePath: "/tmp/palace" },
        },
        runner,
      });
      expect(searchFailure.ok).toBe(true);
      if (!searchFailure.ok) throw new Error(searchFailure.error.message);
      expect(searchFailure.response.ok).toBe(true);
      if (!searchFailure.response.ok) throw new Error(searchFailure.response.error.message);
      expect(searchFailure.response.result).toMatchObject({
        wake: { text: "wake:project:/tmp/palace" },
        search: null,
        // Composite search half must surface a partial error so callers can
        // distinguish "no query / no hits" from "tool_search blew up". Prior
        // behavior collapsed exceptions to `search: null` with `ok: true`.
        search_error: expect.stringContaining("search exploded"),
      });

      const searchDomainFailure = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: {
          action: "wake_up_and_search",
          params: { wing: "project", query: "domain-fails", limit: 3 },
          options: { palacePath: "/tmp/palace" },
        },
        runner,
      });
      expect(searchDomainFailure.ok).toBe(true);
      if (!searchDomainFailure.ok) throw new Error(searchDomainFailure.error.message);
      expect(searchDomainFailure.response.ok).toBe(true);
      if (!searchDomainFailure.response.ok) throw new Error(searchDomainFailure.response.error.message);
      expect(searchDomainFailure.response.result).toMatchObject({
        wake: { text: "wake:project:/tmp/palace" },
        search: null,
        search_error: expect.stringContaining("bad_query: domain search failed"),
      });

      const wakeFailure = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: {
          action: "wake_up_and_search",
          params: { wing: "wake-fails", query: "auth", limit: 3 },
          options: { palacePath: "/tmp/palace" },
        },
        runner,
      });
      expect(wakeFailure.ok).toBe(true);
      if (!wakeFailure.ok) throw new Error(wakeFailure.error.message);
      expect(wakeFailure.response.ok).toBe(true);
      if (!wakeFailure.response.ok) throw new Error(wakeFailure.response.error.message);
      expect(wakeFailure.response.result).toMatchObject({
        wake: null,
        wake_error: expect.stringContaining("wake exploded"),
        search: { query: "auth", count: 1 },
      });

      const calls = fs.readFileSync(callsFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls[0]).toEqual({ limit: 3, query: "auth", room: "notes", wing: "project" });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      try { fs.unlinkSync(callsFile); } catch { /* best-effort */ }
    }
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
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "print('chromadb telemetry banner')\nprint('initializing mempalace')\n");
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
def tool_kg_add(**kw): return _record("tool_kg_add", kw)
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
      const kgAdd = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 5000,
        request: {
          action: "kg_add",
          params: {
            subject: "Kai",
            predicate: "uses",
            object: "MemPalace",
            valid_from: "2026-05-13",
            valid_to: "2026-05-13T12:30:45Z",
            source_file: "knowledge.md",
            source_drawer_id: "drawer-123",
          },
          options: {},
        },
        runner,
      });
      expect(kgAdd.ok).toBe(true);
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
      expect(calls.find((c) => c.action === "tool_kg_add").kwargs).toEqual({
        subject: "Kai",
        predicate: "uses",
        object: "MemPalace",
        valid_from: "2026-05-13",
        valid_to: "2026-05-13T12:30:45Z",
        source_file: "knowledge.md",
        source_drawer_id: "drawer-123",
      });
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
        ["mine", { dir: "src", limit: 5, include_ignored: true, dry_run: true }, ["mine", "src", "--limit", "5", "--include-ignored", "--dry-run"]],
        ["split", { source_file: "transcript.md", mode: "conversation" }, ["split", "transcript.md", "--mode", "conversation"]],
        ["repair", { yes: true, dry_run: true }, ["repair", "--yes", "--dry-run"]],
        [
          "repair",
          { mode: "from-sqlite", source: "/tmp/palace.sqlite", archive_existing: true },
          ["repair", "--mode", "from-sqlite", "--source", "/tmp/palace.sqlite", "--archive-existing"],
        ],
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
  test("wake_up_and_search: batches wake_up + search in one process; exception-isolates each half", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-wuas-"));
    try {
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "");
      fs.writeFileSync(path.join(packageDir, "layers.py"), `
class MemoryStack:
    def __init__(self, palace_path=None, **_):
        self.palace_path = palace_path
    def wake_up(self, wing=None, **_):
        return f"wake for wing={wing}"
`);
      fs.writeFileSync(path.join(packageDir, "mcp_server.py"), `
import argparse
argparse.ArgumentParser().parse_known_args()
def tool_search(query=None, wing=None, limit=None, **_):
    return {"query": query, "count": 1, "results": [{"id": "d1", "similarity": 0.9, "text": "found: " + str(query)}]}
`);
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir });
      const python = await discoverPython({ candidates: ["python3", "python"], runner });
      if (!python.ok) return;
      const bridge = resolveBridgeScriptPath();
      if (!bridge.ok) throw new Error(bridge.error.message);

      // Full payload: both halves succeed.
      const full = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 8000,
        request: { action: "wake_up_and_search", params: { wing: "project", query: "auth", limit: 3 }, options: {} },
        runner,
      });
      expect(full.ok).toBe(true);
      if (!full.ok) throw new Error(full.error.message);
      expect(full.response.ok).toBe(true);
      if (!full.response.ok) throw new Error(full.response.error.message);
      expect((full.response.result as any).wake).toMatchObject({ text: "wake for wing=project" });
      expect((full.response.result as any).search).toMatchObject({ query: "auth", count: 1 });
      expect((full.response.result as any).search.results[0].text).toContain("found: auth");

      // No-query: search skipped, wake still returned.
      const noQuery = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 8000,
        request: { action: "wake_up_and_search", params: { wing: "project" }, options: {} },
        runner,
      });
      expect(noQuery.ok).toBe(true);
      if (!noQuery.ok) throw new Error(noQuery.error.message);
      expect(noQuery.response.ok).toBe(true);
      if (!noQuery.response.ok) throw new Error(noQuery.response.error.message);
      expect((noQuery.response.result as any).wake).toMatchObject({ text: "wake for wing=project" });
      expect((noQuery.response.result as any).search).toBeNull();

      // Wake failure: partial result with wake_error, search still returned.
      fs.writeFileSync(path.join(packageDir, "layers.py"), `
class MemoryStack:
    def __init__(self, palace_path=None, **_): pass
    def wake_up(self, **_):
        raise RuntimeError("simulated wake failure")
`);
      const wakeFailure = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 8000,
        request: { action: "wake_up_and_search", params: { query: "auth" }, options: {} },
        runner,
      });
      expect(wakeFailure.ok).toBe(true);
      if (!wakeFailure.ok) throw new Error(wakeFailure.error.message);
      expect(wakeFailure.response.ok).toBe(true);
      if (!wakeFailure.response.ok) throw new Error(wakeFailure.response.error.message);
      expect((wakeFailure.response.result as any).wake).toBeNull();
      expect(typeof (wakeFailure.response.result as any).wake_error).toBe("string");
      expect((wakeFailure.response.result as any).search).toMatchObject({ query: "auth" });
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
          response: { ok: true, result: { ready: true }, diagnostics: { mempalaceVersion: MEMPALACE_PACKAGE_VERSION } },
          stderr: "warning\n",
          durationMs: 42,
        }),
      },
    });

    const result = await bridge.execute({ action: "status" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.result).toEqual({ ready: true });
    expect(result.diagnostics).toMatchObject({ mempalaceVersion: MEMPALACE_PACKAGE_VERSION, stderr: "warning\n", durationMs: 42 });
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

describe("mempalace bridge write serialization and retry", () => {
  const config = resolveMempalaceConfig(DEFAULT_CONFIG, process.cwd(), createPaths(".omp"));
  const palace = "/tmp/test-palace";
  const otherPalace = "/tmp/other-palace";

  test("concurrent add_drawer calls to the same palace are serialized", async () => {
    const callOrder: string[] = [];
    let resolveFirst!: () => void;
    // Signal fired by the mock when the first call has actually started.
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((res) => { resolveFirstStarted = res; });

    let callCount = 0;
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async () => {
          const idx = callCount++;
          callOrder.push(`start-${idx}`);
          if (idx === 0) {
            // Signal to the test that the first call has started, then block.
            resolveFirstStarted();
            await new Promise<void>((res) => { resolveFirst = res; });
          }
          callOrder.push(`end-${idx}`);
          return {
            ok: true,
            response: { ok: true, result: { done: true } },
            stderr: "",
            durationMs: 1,
          };
        },
      },
    });

    // Fire both concurrently; second must not start until first finishes.
    const p1 = bridge.execute({ action: "add_drawer", palace: palace, wing: "w", room: "r", content: "c1" });
    const p2 = bridge.execute({ action: "add_drawer", palace: palace, wing: "w", room: "r", content: "c2" });

    // Wait until the first dispatch has actually started, THEN unblock it.
    await firstStarted;
    resolveFirst();
    await Promise.all([p1, p2]);

    expect(callOrder).toEqual(["start-0", "end-0", "start-1", "end-1"]);
  });

  test("CLI write actions (init, mine, repair) are serialized against add_drawer on the same palace", async () => {
    // Per-action classification must cover every mutation, not just MCP-tool
    // writes. init/mine/repair all touch the palace on disk (chroma sqlite,
    // drawer files, index rebuilds) and previously slipped through the
    // default read path, racing concurrent writers from add_drawer or
    // diary_write.
    for (const writeAction of ["init", "mine", "repair"] as const) {
      const callOrder: string[] = [];
      let resolveFirst!: () => void;
      let resolveFirstStarted!: () => void;
      const firstStarted = new Promise<void>((res) => { resolveFirstStarted = res; });

      let callCount = 0;
      const bridge = createMempalaceBridge({
        cwd: process.cwd(),
        config,
        runtime: {
          resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
          runBridgeRequest: async () => {
            const idx = callCount++;
            callOrder.push(`start-${idx}`);
            if (idx === 0) {
              resolveFirstStarted();
              await new Promise<void>((res) => { resolveFirst = res; });
            }
            callOrder.push(`end-${idx}`);
            return { ok: true, response: { ok: true, result: { done: true } }, stderr: "", durationMs: 1 };
          },
        },
      });

      const writeParams: { action: typeof writeAction; palace: string; dir?: string } = { action: writeAction, palace };
      if (writeAction === "init" || writeAction === "mine") writeParams.dir = "/tmp/test-palace";
      const p1 = bridge.execute(writeParams);
      const p2 = bridge.execute({ action: "add_drawer", palace, wing: "w", room: "r", content: "c" });

      await firstStarted;
      resolveFirst();
      await Promise.all([p1, p2]);

      expect(callOrder).toEqual(["start-0", "end-0", "start-1", "end-1"]);
    }
  });

  test("concurrent add_drawer calls to different palaces run in parallel", async () => {
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const waitFor = (tag: string) =>
      new Promise<void>((res) => {
        resolvers.push(res);
        started.push(tag);
      });

    let callCount = 0;
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async (_opts) => {
          const tag = `call-${callCount++}`;
          await waitFor(tag);
          return {
            ok: true,
            response: { ok: true, result: {} },
            stderr: "",
            durationMs: 1,
          };
        },
      },
    });

    const p1 = bridge.execute({ action: "add_drawer", palace: palace, wing: "w", room: "r", content: "A" });
    const p2 = bridge.execute({ action: "add_drawer", palace: otherPalace, wing: "w", room: "r", content: "B" });

    // Both calls should have started before we unblock either.
    await new Promise<void>((res) => setTimeout(res, 10));
    expect(started.length).toBe(2); // both started — not serialized across palaces

    for (const res of resolvers) res();
    await Promise.all([p1, p2]);
  });

  test("concurrent writers with `~`-prefixed vs canonical palace paths share the same lock", async () => {
    // The mutex must lock by canonical filesystem path, not by raw caller
    // input. `~/x` and the home-expanded absolute path point at the same
    // sqlite file; without normalization they would hit different mutex
    // entries and the lock would not apply.
    const callOrder: string[] = [];
    let resolveFirst!: () => void;
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((res) => { resolveFirstStarted = res; });

    let callCount = 0;
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async () => {
          const idx = callCount++;
          callOrder.push(`start-${idx}`);
          if (idx === 0) {
            resolveFirstStarted();
            await new Promise<void>((res) => { resolveFirst = res; });
          }
          callOrder.push(`end-${idx}`);
          return { ok: true, response: { ok: true, result: { done: true } }, stderr: "", durationMs: 1 };
        },
      },
    });

    const tildePath = "~/supi-mutex-canon-test";
    const expandedPath = path.join(os.homedir(), "supi-mutex-canon-test");

    const p1 = bridge.execute({ action: "add_drawer", palace: tildePath, wing: "w", room: "r", content: "c1" });
    const p2 = bridge.execute({ action: "add_drawer", palace: expandedPath, wing: "w", room: "r", content: "c2" });

    await firstStarted;
    resolveFirst();
    await Promise.all([p1, p2]);

    // If the mutex key were not canonicalized, both would start in parallel
    // and `start-1` would appear before `end-0`. Strict ordering here proves
    // the canonicalization applies.
    expect(callOrder).toEqual(["start-0", "end-0", "start-1", "end-1"]);
  });

  test("bridge_timeout on add_drawer triggers zero retries; previous writer may still be alive", async () => {
    // When the TS-side timeout fires we SIGKILL the python child, but the OS
    // may not have reaped it yet. Retrying after a short sleep can race a
    // still-live writer on the same sqlite file (especially for write-once
    // payloads like diary_write). The retry policy intentionally excludes
    // bridge_timeout from TRANSIENT_ERROR_CODES — bridge_process_failed
    // remains retryable because it only fires after child `close`.
    let callCount = 0;
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async () => {
          callCount++;
          return {
            ok: false,
            error: { code: "bridge_timeout", message: "timed out" },
            stdoutPreview: "",
            stderrTail: "",
            durationMs: 5000,
          };
        },
      },
    });

    const result = await bridge.execute({ action: "add_drawer", palace: palace, wing: "w", room: "r", content: "c" });

    expect(callCount).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("bridge_timeout");
    expect(result.diagnostics.retries).toBe(0);
  });

  test("keeps same-palace writer queued until timed-out child completion settles", async () => {
    const callOrder: string[] = [];
    let resolveFirstStarted!: () => void;
    let releaseTimedOutWriter!: () => void;
    const firstStarted = new Promise<void>((res) => { resolveFirstStarted = res; });
    const timedOutWriterReleased = new Promise<void>((res) => {
      releaseTimedOutWriter = () => {
        callOrder.push("release-0");
        res();
      };
    });

    let callCount = 0;
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async () => {
          const idx = callCount++;
          callOrder.push(`start-${idx}`);
          if (idx === 0) {
            resolveFirstStarted();
            return {
              ok: false,
              error: { code: "bridge_timeout", message: "timed out" },
              stdoutPreview: "",
              stderrTail: "",
              durationMs: 5000,
              completion: timedOutWriterReleased,
            };
          }
          callOrder.push(`end-${idx}`);
          return { ok: true, response: { ok: true, result: {} }, stderr: "", durationMs: 1 };
        },
      },
    });

    const p1 = bridge.execute({ action: "add_drawer", palace, wing: "w", room: "r", content: "c1" });
    await firstStarted;
    const first = await p1;
    expect(first.ok).toBe(false);
    expect(callOrder).toEqual(["start-0"]);

    const p2 = bridge.execute({ action: "add_drawer", palace, wing: "w", room: "r", content: "c2" });
    await new Promise<void>((res) => setTimeout(res, 10));
    expect(callOrder).toEqual(["start-0"]);

    releaseTimedOutWriter();
    await p2;
    expect(callOrder).toEqual(["start-0", "release-0", "start-1", "end-1"]);
  });

  test("bridge_process_failed on add_drawer still triggers one retry (child has exited)", async () => {
    // bridge_process_failed only fires after child `close`, so we know the
    // previous writer is gone — retrying is safe and meaningfully improves
    // durability for write-once payloads.
    let callCount = 0;
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              ok: false,
              error: { code: "bridge_process_failed", message: "child died" },
              stdoutPreview: "",
              stderrTail: "",
              durationMs: 50,
            };
          }
          return {
            ok: true,
            response: { ok: true, result: { done: true } },
            stderr: "",
            durationMs: 10,
          };
        },
      },
    });

    const result = await bridge.execute({ action: "add_drawer", palace: palace, wing: "w", room: "r", content: "c" });

    expect(callCount).toBe(2);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.diagnostics.retries).toBe(1);
  });

  test("bridge_timeout on search triggers zero retries", async () => {
    let callCount = 0;
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async () => {
          callCount++;
          return {
            ok: false,
            error: { code: "bridge_timeout", message: "timed out" },
            stdoutPreview: "",
            stderrTail: "",
            durationMs: 5000,
          };
        },
      },
    });

    const result = await bridge.execute({ action: "search", query: "test" });

    expect(callCount).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("bridge_timeout");
    // retries field is 0 for non-retryable actions
    expect(result.diagnostics.retries).toBe(0);
  });

  test("invalid_params on add_drawer triggers zero retries", async () => {
    let callCount = 0;
    const bridge = createMempalaceBridge({
      cwd: process.cwd(),
      config,
      runtime: {
        resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
        runBridgeRequest: async () => {
          callCount++;
          return {
            ok: true,
            response: {
              ok: false,
              error: { code: "invalid_params", message: "bad params" },
              diagnostics: {},
            },
            stderr: "",
            durationMs: 5,
          };
        },
      },
    });

    const result = await bridge.execute({ action: "add_drawer", palace: palace, wing: "w", room: "r", content: "c" });

    expect(callCount).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("invalid_params");
    expect(result.diagnostics.retries).toBe(0);
  });

  test("diary_write with source_file embeds prefix in entry via Python bridge shim", async () => {
    const callsFile = path.join(os.tmpdir(), `supi-diary-test-${Date.now()}.jsonl`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-diary-shim-"));
    try {
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "");
      fs.writeFileSync(
        path.join(packageDir, "mcp_server.py"),
        `import json, os\n` +
        `def tool_diary_write(**kw):\n` +
        `    with open(os.environ["CALLS_FILE"], "a", encoding="utf-8") as fh:\n` +
        `        fh.write(json.dumps(kw, sort_keys=True) + "\\n")\n` +
        `    return {"success": True, "entry_id": "test-id"}\n`,
      );
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir, CALLS_FILE: callsFile });
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
        request: {
          action: "diary_write",
          params: {
            agent_name: "omp",
            entry: "Session summary body",
            topic: "shutdown",
            wing: "supipowers",
            source_file: "omp-session:sess-1:shutdown:2026-05-13T00:00:00.000Z",
          },
          options: { palacePath: "/tmp/palace" },
        },
        runner,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.response.ok).toBe(true);
      if (!result.response.ok) throw new Error(result.response.error.message);

      const calls = fs.readFileSync(callsFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      expect(calls).toHaveLength(1);
      const call = calls[0];
      // source_file must be embedded as the first line of the entry text
      expect(call.entry).toContain("[source: omp-session:sess-1:shutdown:2026-05-13T00:00:00.000Z]");
      expect(call.entry).toContain("Session summary body");
      expect(call.entry.indexOf("[source:")).toBe(0); // prefix is first
      // source_file must NOT be passed as a kwarg to tool_diary_write
      expect(Object.keys(call)).not.toContain("source_file");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      try { fs.unlinkSync(callsFile); } catch { /* best-effort */ }
    }
  });

  test("diary_write truncates entry tail when source_file prefix would exceed MAX_CONTENT_LENGTH", async () => {
    // Upstream tool_diary_write calls sanitize_content(entry), which raises
    // ValueError beyond 100_000 chars. Adding the deterministic `[source:
    // …]\n` prefix to a TS-valid 100_000-char entry would previously push
    // the payload past the limit and fail the request. The bridge now
    // reserves the prefix budget by clipping the entry tail.
    const callsFile = path.join(os.tmpdir(), `supi-diary-trunc-${Date.now()}.jsonl`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-diary-trunc-"));
    try {
      const packageDir = path.join(tmpDir, "mempalace");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "");
      fs.writeFileSync(
        path.join(packageDir, "mcp_server.py"),
        `import json, os\n` +
        `def tool_diary_write(**kw):\n` +
        `    if len(kw.get("entry", "")) > 100000:\n` +
        `        return {"success": False, "error": "content exceeds maximum length of 100000 characters"}\n` +
        `    with open(os.environ["CALLS_FILE"], "a", encoding="utf-8") as fh:\n` +
        `        fh.write(json.dumps({"entry_len": len(kw["entry"]), "starts_with": kw["entry"][:64]}) + "\\n")\n` +
        `    return {"success": True, "entry_id": "id-1"}\n`,
      );
      const runner = bunProcessRunner({ ...process.env, PYTHONPATH: tmpDir, CALLS_FILE: callsFile });
      const python = await discoverPython({ candidates: ["python3", "python"], runner });
      if (!python.ok) {
        expect(python.error.code).toBe("python_missing");
        return;
      }
      const bridge = resolveBridgeScriptPath();
      if (!bridge.ok) throw new Error(bridge.error.message);

      const sourceFile = "omp-session:sess-1:shutdown:2026-05-13T00:00:00.000Z";
      // Hand python a TS-valid entry that exactly equals MAX_CONTENT_LENGTH.
      // After prefixing, the result must still be ≤ MAX_CONTENT_LENGTH.
      const entry = "x".repeat(100_000);

      const result = await runBridgeRequest({
        pythonPath: python.pythonPath,
        bridgeScriptPath: bridge.path,
        timeoutMs: 8000,
        request: {
          action: "diary_write",
          params: { agent_name: "omp", entry, topic: "shutdown", wing: "supipowers", source_file: sourceFile },
          options: { palacePath: "/tmp/palace" },
        },
        runner,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.response.ok).toBe(true);
      if (!result.response.ok) throw new Error(result.response.error.message);

      const calls = fs.readFileSync(callsFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      expect(calls).toHaveLength(1);
      expect(calls[0].entry_len).toBeLessThanOrEqual(100_000);
      expect(calls[0].starts_with.startsWith(`[source: ${sourceFile}]\n`)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      try { fs.unlinkSync(callsFile); } catch { /* best-effort */ }
    }
  });
});
