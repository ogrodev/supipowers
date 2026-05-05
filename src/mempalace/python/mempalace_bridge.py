#!/usr/bin/env python3
"""One-shot JSON bridge for the native supipowers MemPalace tool.

Action mapping (auditable API surface) — wired against MemPalace 3.3.4:
- version: stdlib importlib.metadata only; does not import MemPalace runtime modules.
- 29 MCP-equivalent actions dispatch to ``mempalace.mcp_server.tool_<action>``
  (with the ``traverse → tool_traverse_graph`` rename). The mcp_server
  module is imported as a Python library — supipowers does NOT register it as
  an MCP server, spawn an MCP child process, or hand its tools to mcpc.
  The bridge calls the underlying tool functions directly with kwargs.
- wake_up: ``mempalace.layers.MemoryStack().wake_up(wing=...)`` — the
  documented Python API for L0 + L1 context (no tool_wake_up exists).
- native CLI actions (init, mine, split, repair): invoked via
  ``python -m mempalace.cli <subcommand>`` as a subprocess inside the same
  managed venv. Output is captured and returned as text.
- unknown actions: deny-by-default.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import json
import os
import platform
import sys
import traceback
from typing import Any, Callable, Dict

# Capture the real stdout/stderr file descriptors before any import. MemPalace
# (and several of its dependencies — e.g. ChromaDB's banner, telemetry warnings)
# print to stdout during import, which would corrupt our JSON protocol. We
# rebind sys.stdout to sys.stderr immediately so any print() goes to stderr,
# and only restore the real stdout when emitting the final JSON response.
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

# Force UTF-8 across the bridge so JSON-encoded text round-trips identically on
# Windows shells with non-UTF-8 default encodings.
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

# mempalace.mcp_server runs `argparse.parse_known_args(sys.argv[1:])` at import
# time. Our bridge's argv is `[bridge.py]`, so parse_known_args returns empty
# results and the import is benign — but we defensively scrub argv to the
# program name so the import is independent of how the bridge was invoked.
_REAL_ARGV = sys.argv[:]
sys.argv = [sys.argv[0]] if sys.argv else ["mempalace_bridge.py"]

BRIDGE_VERSION = "0.1.0"


class BridgeDomainError(Exception):
    def __init__(self, code: str, message: str, remediation: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.remediation = remediation


def _json_response(payload: Dict[str, Any]) -> None:
    serialized = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    _REAL_STDOUT.write(serialized)
    _REAL_STDOUT.write("\n")
    _REAL_STDOUT.flush()


def _error_payload(error: BridgeDomainError) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "ok": False,
        "error": {
            "code": error.code,
            "message": error.message,
        },
        "diagnostics": _base_diagnostics({}),
    }
    if error.remediation:
        payload["error"]["remediation"] = error.remediation
    return payload


def _read_request() -> Dict[str, Any]:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BridgeDomainError("invalid_json", f"Bridge request is not valid JSON: {exc.msg}") from exc
    if not isinstance(request, dict):
        raise BridgeDomainError("invalid_request", "Bridge request must be a JSON object.")
    return request


def _base_diagnostics(options: Dict[str, Any]) -> Dict[str, Any]:
    diagnostics: Dict[str, Any] = {
        "bridgeVersion": BRIDGE_VERSION,
        "python": platform.python_version(),
    }
    palace_path = options.get("palacePath") or options.get("palace")
    if palace_path:
        diagnostics["palacePath"] = palace_path
    try:
        diagnostics["mempalaceVersion"] = importlib.metadata.version("mempalace")
    except importlib.metadata.PackageNotFoundError:
        diagnostics["mempalaceVersion"] = None
    return diagnostics


def _handle_version(params: Dict[str, Any], options: Dict[str, Any]) -> Dict[str, Any]:
    diagnostics = _base_diagnostics(options)
    return {
        "ok": True,
        "result": {
            "bridgeVersion": BRIDGE_VERSION,
            "python": diagnostics["python"],
            "mempalaceVersion": diagnostics["mempalaceVersion"],
            "palacePath": diagnostics.get("palacePath"),
        },
        "diagnostics": diagnostics,
    }


# ── Helpers ───────────────────────────────────────────────────────────────


def _apply_palace_path(options: Dict[str, Any]) -> None:
    """Set MEMPALACE_PALACE_PATH so MemPalace's MempalaceConfig picks it up."""
    palace = options.get("palacePath") or options.get("palace")
    if palace and isinstance(palace, str) and palace:
        os.environ["MEMPALACE_PALACE_PATH"] = os.path.expanduser(palace)


def _to_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_to_jsonable(item) for item in value]
    if isinstance(value, tuple):
        return [_to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _to_jsonable(item) for key, item in value.items()}
    if hasattr(value, "model_dump"):
        return _to_jsonable(value.model_dump())
    if hasattr(value, "__dict__"):
        return _to_jsonable(vars(value))
    return str(value)


def _ok(result: Any, options: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "ok": True,
        "result": _to_jsonable(result) if result is not None else {},
        "diagnostics": _base_diagnostics(options),
    }


def _import_or_raise(module_name: str) -> Any:
    try:
        return importlib.import_module(module_name)
    except Exception as exc:
        raise BridgeDomainError(
            "mempalace_missing",
            f"Failed to import {module_name}: {exc}",
            "Run `/supi:memory setup` to (re)install the managed MemPalace runtime.",
        ) from exc


def _wrap_runtime_errors(label: str, fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except BridgeDomainError:
        raise
    except Exception as exc:
        raise BridgeDomainError(
            "mempalace_runtime_error",
            f"{label} raised: {exc}",
        ) from exc


def _select(*keys: str) -> Callable[[Dict[str, Any]], Dict[str, Any]]:
    """Build kwargs from `params` containing only the listed keys (skipping None/missing)."""
    def extract(params: Dict[str, Any]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for key in keys:
            if key in params and params[key] is not None:
                out[key] = params[key]
        return out
    return extract


def _rename(mapping: Dict[str, str]) -> Callable[[Dict[str, Any]], Dict[str, Any]]:
    """Build kwargs from `params`, renaming each `<src>` key to `<dst>`."""
    def extract(params: Dict[str, Any]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for src, dst in mapping.items():
            if src in params and params[src] is not None:
                out[dst] = params[src]
        return out
    return extract


# ── MCP-equivalent action dispatch ───────────────────────────────────────
#
# Each entry maps our action -> (function name in mempalace.mcp_server,
# extractor that builds **kwargs from our params). MemPalace's tool_* functions
# return native Python dicts/lists; we JSON-normalize the result.

MCP_TOOL_DISPATCH: Dict[str, "tuple[str, Callable[[Dict[str, Any]], Dict[str, Any]]]"] = {
    "status": ("tool_status", lambda p: {}),
    "list_wings": ("tool_list_wings", lambda p: {}),
    "list_rooms": ("tool_list_rooms", _select("wing")),
    "get_taxonomy": ("tool_get_taxonomy", lambda p: {}),
    "search": ("tool_search", _select("query", "limit", "wing", "room")),
    "check_duplicate": ("tool_check_duplicate", _select("content")),
    "get_aaak_spec": ("tool_get_aaak_spec", lambda p: {}),
    "get_drawer": ("tool_get_drawer", _select("drawer_id")),
    "list_drawers": ("tool_list_drawers", _select("wing", "room", "limit", "offset")),
    "add_drawer": ("tool_add_drawer", _select("wing", "room", "content", "source_file", "added_by")),
    "update_drawer": ("tool_update_drawer", _select("drawer_id", "content", "wing", "room")),
    "delete_drawer": ("tool_delete_drawer", _select("drawer_id")),
    # Knowledge graph: MemPalace uses `entity` for the subject in queries.
    "kg_query": ("tool_kg_query", _rename({"subject": "entity", "as_of": "as_of", "direction": "direction"})),
    "kg_add": ("tool_kg_add", _select("subject", "predicate", "object", "valid_from", "source_closet")),
    "kg_invalidate": ("tool_kg_invalidate", _select("subject", "predicate", "object", "ended")),
    "kg_timeline": ("tool_kg_timeline", _rename({"subject": "entity"})),
    "kg_stats": ("tool_kg_stats", lambda p: {}),
    # Palace graph: MemPalace's function is `tool_traverse_graph`, not `tool_traverse`.
    "traverse": ("tool_traverse_graph", _select("start_room", "max_hops")),
    # find_tunnels: MemPalace uses wing_a/wing_b. Our schema names them
    # source_wing/target_wing for symmetry with create_tunnel; we rename here.
    "find_tunnels": ("tool_find_tunnels", _rename({"source_wing": "wing_a", "target_wing": "wing_b"})),
    "graph_stats": ("tool_graph_stats", lambda p: {}),
    "create_tunnel": ("tool_create_tunnel", _select("source_wing", "source_room", "target_wing", "target_room", "label")),
    "list_tunnels": ("tool_list_tunnels", _select("wing")),
    "delete_tunnel": ("tool_delete_tunnel", _select("tunnel_id")),
    # follow_tunnels: MemPalace uses wing/room (not source_wing/source_room).
    "follow_tunnels": ("tool_follow_tunnels", _rename({"source_wing": "wing", "source_room": "room"})),
    "diary_write": ("tool_diary_write", _select("agent_name", "entry", "topic", "wing")),
    "diary_read": ("tool_diary_read", _select("agent_name", "wing")),
    "hook_settings": ("tool_hook_settings", lambda p: {}),
    "memories_filed_away": ("tool_memories_filed_away", lambda p: {}),
    "reconnect": ("tool_reconnect", lambda p: {}),
}


def _handle_mcp_tool(action: str, params: Dict[str, Any], options: Dict[str, Any]) -> Dict[str, Any]:
    func_name, extractor = MCP_TOOL_DISPATCH[action]
    _apply_palace_path(options)
    module = _import_or_raise("mempalace.mcp_server")
    func = getattr(module, func_name, None)
    if not callable(func):
        raise BridgeDomainError(
            "mempalace_missing",
            f"mempalace.mcp_server.{func_name} is not callable in the installed package.",
            "Upgrade the managed MemPalace runtime via `/supi:memory setup`.",
        )
    kwargs = extractor(params)
    raw = _wrap_runtime_errors(f"mempalace.mcp_server.{func_name}", lambda: func(**kwargs))
    result = _to_jsonable(raw)
    if isinstance(result, dict) and result.get("ok") is False and isinstance(result.get("error"), dict):
        return {"ok": False, "error": result["error"], "diagnostics": _base_diagnostics(options)}
    return _ok(result, options)


def _make_mcp_handler(action: str) -> Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]]:
    def _handler(params: Dict[str, Any], options: Dict[str, Any]) -> Dict[str, Any]:
        return _handle_mcp_tool(action, params, options)
    return _handler


# ── wake_up handler (documented Python API, no tool_* equivalent) ────────


def _handle_wake_up(params: Dict[str, Any], options: Dict[str, Any]) -> Dict[str, Any]:
    _apply_palace_path(options)
    layers = _import_or_raise("mempalace.layers")
    palace = options.get("palacePath")
    stack = layers.MemoryStack(palace_path=palace) if palace else layers.MemoryStack()
    wake_kwargs: Dict[str, Any] = {}
    if params.get("wing"):
        wake_kwargs["wing"] = params["wing"]
    text = _wrap_runtime_errors("MemoryStack.wake_up", lambda: stack.wake_up(**wake_kwargs))
    return _ok({"text": text}, options)


# ── Native CLI args builders ──────────────────────────────────────────────


def _make_cli_args_init(params: Dict[str, Any]) -> "list[str]":
    args = ["init", str(params.get("dir") or ".")]
    if params.get("yes"):
        args.append("--yes")
    return args


def _make_cli_args_mine(params: Dict[str, Any]) -> "list[str]":
    args = ["mine", str(params.get("dir") or ".")]
    if params.get("mode"):
        args.extend(["--mode", str(params["mode"])])
    if isinstance(params.get("limit"), int):
        args.extend(["--limit", str(params["limit"])])
    if params.get("include_ignored"):
        args.append("--include-ignored")
    if params.get("no_gitignore"):
        args.append("--no-gitignore")
    if params.get("extract"):
        args.append("--extract")
    return args


def _make_cli_args_split(params: Dict[str, Any]) -> "list[str]":
    source = params.get("source_file") or params.get("dir")
    if not source:
        raise BridgeDomainError("invalid_params", "split requires source_file or dir.")
    args = ["split", str(source)]
    if params.get("mode"):
        args.extend(["--mode", str(params["mode"])])
    return args


def _make_cli_args_repair(params: Dict[str, Any]) -> "list[str]":
    args = ["repair", str(params.get("dir") or ".")]
    if params.get("dry_run"):
        args.append("--dry-run")
    return args


CLI_DISPATCH: Dict[str, Callable[[Dict[str, Any]], "list[str]"]] = {
    "init": _make_cli_args_init,
    "mine": _make_cli_args_mine,
    "split": _make_cli_args_split,
    "repair": _make_cli_args_repair,
}


def _handle_cli_action(action: str, params: Dict[str, Any], options: Dict[str, Any]) -> Dict[str, Any]:
    builder = CLI_DISPATCH[action]
    cli_args = builder(params)
    _apply_palace_path(options)
    cmd = [sys.executable, "-m", "mempalace.cli", *cli_args]
    cwd = options.get("cwd") if isinstance(options.get("cwd"), str) else None
    import subprocess
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        timeout=600,
    )
    diagnostics = _base_diagnostics(options)
    diagnostics["argv"] = cli_args
    if proc.returncode != 0:
        return {
            "ok": False,
            "error": {
                "code": "mempalace_cli_failed",
                "message": f"`mempalace {' '.join(cli_args)}` exited {proc.returncode}.",
                "stderr": proc.stderr.strip(),
                "stdout": proc.stdout.strip(),
            },
            "diagnostics": diagnostics,
        }
    return {
        "ok": True,
        "result": {
            "argv": cli_args,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "returncode": proc.returncode,
        },
        "diagnostics": diagnostics,
    }


def _make_cli_handler(action: str) -> Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]]:
    def _handler(params: Dict[str, Any], options: Dict[str, Any]) -> Dict[str, Any]:
        return _handle_cli_action(action, params, options)
    return _handler


# ── Final dispatch table ──────────────────────────────────────────────────


DISPATCH: Dict[str, Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]]] = {
    "version": _handle_version,
    "wake_up": _handle_wake_up,
}
for _action in MCP_TOOL_DISPATCH:
    DISPATCH[_action] = _make_mcp_handler(_action)
for _action in CLI_DISPATCH:
    DISPATCH[_action] = _make_cli_handler(_action)


def main() -> int:
    try:
        request = _read_request()
        action = request.get("action")
        params = request.get("params") or {}
        options = request.get("options") or {}
        if not isinstance(action, str) or not action:
            raise BridgeDomainError("missing_action", "Bridge request requires a non-empty action string.")
        if not isinstance(params, dict):
            raise BridgeDomainError("invalid_params", "Bridge request params must be an object.")
        if not isinstance(options, dict):
            raise BridgeDomainError("invalid_options", "Bridge request options must be an object.")
        handler = DISPATCH.get(action)
        if handler is None:
            raise BridgeDomainError("unknown_action", f"Unsupported MemPalace bridge action: {action}")
        _json_response(handler(params, options))
        return 0
    except BridgeDomainError as exc:
        _json_response(_error_payload(exc))
        return 0
    except Exception as exc:  # pragma: no cover - defensive bridge boundary
        traceback.print_exc(file=sys.stderr)
        _json_response({
            "ok": False,
            "error": {
                "code": "bridge_runtime_error",
                "message": str(exc),
            },
            "diagnostics": _base_diagnostics({}),
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
