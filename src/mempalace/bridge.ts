import { homedir } from "node:os";
import * as path from "node:path";

import type { ResolvedMempalaceConfig } from "./config.js";
import { MEMPALACE_ACTIONS, type MempalaceAction, type MempalaceParams } from "./schema.js";
import {
  resolveBridgeScriptPath,
  resolveManagedVenvPaths,
  runBridgeRequest,
  type BridgePathResult,
  type MempalaceRuntimeError,
  type RunBridgeRequestOptions,
  type RunBridgeRequestResult,
} from "./runtime.js";

export type MempalaceBridgeCallResult =
  | {
      ok: true;
      action: MempalaceParams["action"];
      result: unknown;
      diagnostics: Record<string, unknown>;
    }
  | {
      ok: false;
      action: MempalaceParams["action"];
      error: MempalaceRuntimeError;
      diagnostics: Record<string, unknown>;
    };

interface BridgeDispatchResult {
  result: MempalaceBridgeCallResult;
  release: Promise<void>;
}

export interface MempalaceBridgeRuntimeDeps {
  resolveBridgeScriptPath?: () => BridgePathResult;
  runBridgeRequest?: (options: RunBridgeRequestOptions) => Promise<RunBridgeRequestResult>;
}

export interface CreateMempalaceBridgeOptions {
  cwd: string;
  config: ResolvedMempalaceConfig;
  runtime?: MempalaceBridgeRuntimeDeps;
}

export interface MempalaceBridgeFacade {
  execute(params: MempalaceParams): Promise<MempalaceBridgeCallResult>;
}

function withSetupRemediation(error: MempalaceRuntimeError): MempalaceRuntimeError {
  if (error.remediation) return error;
  if (error.code === "mempalace_missing" || error.code === "bridge_process_failed") {
    return {
      ...error,
      remediation: "Call mempalace(action=\"setup\") first, then retry the requested MemPalace action.",
    };
  }
  return error;
}

function mergeDiagnostics(...parts: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  return Object.assign({}, ...parts.filter(Boolean));
}

// Per-action mutation classification. `write` actions are serialized per palace
// to avoid ChromaDB's sqlite "database is locked" errors; `read` actions run in
// parallel. The classification is exhaustive (enforced by `satisfies`) so any
// new action added to MEMPALACE_ACTIONS must be assigned a kind here — no
// silent default to the read path. `setup` is intercepted before the bridge and
// never reaches this map; it is still listed for exhaustiveness.
const ACTION_KIND = {
  // ── reads / queries / listings ──────────────────────────────────────────
  status: "read",
  list_wings: "read",
  list_rooms: "read",
  get_taxonomy: "read",
  search: "read",
  check_duplicate: "read",
  get_aaak_spec: "read",
  get_drawer: "read",
  list_drawers: "read",
  kg_query: "read",
  kg_timeline: "read",
  kg_stats: "read",
  traverse: "read",
  find_tunnels: "read",
  graph_stats: "read",
  list_tunnels: "read",
  follow_tunnels: "read",
  diary_read: "read",
  hook_settings: "read",
  memories_filed_away: "read",
  reconnect: "read",
  version: "read",
  wake_up: "read",
  wake_up_and_search: "read",
  setup: "read", // intercepted upstream; never reaches the bridge mutex

  // ── writes / mutations ──────────────────────────────────────────────────
  add_drawer: "write",
  update_drawer: "write",
  delete_drawer: "write",
  diary_write: "write",
  kg_add: "write",
  kg_invalidate: "write",
  create_tunnel: "write",
  delete_tunnel: "write",
  // CLI actions that touch the palace on disk: init creates structure,
  // mine writes drawers via the indexer, split rewrites mega-file sources
  // under the palace tree, repair rebuilds the chroma index. All four must
  // serialize against concurrent add_drawer/diary_write writers on the
  // same palace.
  init: "write",
  mine: "write",
  split: "write",
  repair: "write",
} as const satisfies Record<MempalaceAction, "read" | "write">;

// Compile-time check: every MEMPALACE_ACTIONS entry must have a kind.
// If a new action is added without an ACTION_KIND entry, this errors.
type _ExhaustiveActionKind = MempalaceAction extends keyof typeof ACTION_KIND ? true : never;
const _exhaustiveActionKind: _ExhaustiveActionKind = true;
void _exhaustiveActionKind;
void MEMPALACE_ACTIONS;

function isWriteAction(action: MempalaceAction): boolean {
  return ACTION_KIND[action] === "write";
}

// Subset of write actions where a single retry on transient bridge failures
// meaningfully improves durability (write-once payloads, low retry cost).
const RETRY_ON_TRANSIENT = new Set<MempalaceAction>([
  "add_drawer", "diary_write", "kg_add", "kg_invalidate",
]);

// Error codes that are transient and safe to retry. `bridge_timeout` is
// deliberately excluded: when the TS-side timeout fires we SIGKILL the python
// child, but the OS may not have reaped the writer yet — retrying could race a
// still-live writer on the same sqlite file. `bridge_process_failed` only
// fires after `child.on('close')`, so the child is definitely gone by then.
const TRANSIENT_ERROR_CODES = new Set(["bridge_process_failed"]);

// Per-palace write serialization queue. Keyed by the canonicalized palace
// path so that concurrent OMP workspaces (different palaces) do not block each
// other, and so callers passing `~/x` vs `/Users/me/x` collide on the same
// lock (they hit the same sqlite file). Entries are deleted in a settlement
// handler when they still point at the current tail, keeping the map bounded
// in long-lived OMP processes.
const palaceMutex = new Map<string, Promise<void>>();
const RELEASED = Promise.resolve<void>(undefined);

function canonicalPalaceKey(palacePath: string): string {
  const trimmed = palacePath.trim();
  if (trimmed === "~") return homedir();
  const expanded = (trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
    ? path.join(homedir(), trimmed.slice(2))
    : trimmed;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
}

function resolveToolTimeoutMs(params: MempalaceParams, bridgeTimeoutMs: number): number {
  if (typeof params.timeout !== "number") return bridgeTimeoutMs;

  // Public tool schemas express timeouts in seconds, matching the rest of the
  // OMP tool surface. The bridge runner uses milliseconds internally.
  return Math.min(params.timeout * 1000, bridgeTimeoutMs);
}

export function createMempalaceBridge(options: CreateMempalaceBridgeOptions): MempalaceBridgeFacade {
  const resolveBridge = options.runtime?.resolveBridgeScriptPath ?? (() => resolveBridgeScriptPath());
  const runBridge = options.runtime?.runBridgeRequest ?? runBridgeRequest;

  return {
    async execute(params: MempalaceParams): Promise<MempalaceBridgeCallResult> {
      const bridgePath = resolveBridge();
      if (!bridgePath.ok) {
        return {
          ok: false,
          action: params.action,
          error: bridgePath.error,
          diagnostics: { bridgeScriptPath: bridgePath.path },
        };
      }

      const venv = resolveManagedVenvPaths(options.config.managedVenvPath);
      const timeoutMs = resolveToolTimeoutMs(params, options.config.timeouts.bridgeMs);
      const palacePath = params.palace ?? options.config.palacePath;

      const invokeOnce = async (): Promise<BridgeDispatchResult> => {
        const runResult = await runBridge({
          pythonPath: venv.python,
          bridgeScriptPath: bridgePath.path,
          timeoutMs,
          request: {
            action: params.action,
            params: { ...params },
            options: {
              cwd: options.cwd,
              palacePath,
              agentName: options.config.defaultAgentName,
            },
          },
        });

        if (!runResult.ok) {
          return {
            result: {
              ok: false,
              action: params.action,
              error: withSetupRemediation(runResult.error),
              diagnostics: {
                durationMs: runResult.durationMs,
                stdoutPreview: runResult.stdoutPreview,
                stderrTail: runResult.stderrTail,
              },
            },
            release: runResult.completion ?? RELEASED,
          };
        }

        if (!runResult.response.ok) {
          return {
            result: {
              ok: false,
              action: params.action,
              error: withSetupRemediation(runResult.response.error),
              diagnostics: mergeDiagnostics(runResult.response.diagnostics, {
                durationMs: runResult.durationMs,
                stderr: runResult.stderr,
              }),
            },
            release: RELEASED,
          };
        }

        return {
          result: {
            ok: true,
            action: params.action,
            result: runResult.response.result ?? {},
            diagnostics: mergeDiagnostics(runResult.response.diagnostics, {
              durationMs: runResult.durationMs,
              stderr: runResult.stderr,
            }),
          },
          release: RELEASED,
        };
      };

      // dispatch: run with one retry on transient errors for eligible actions.
      const dispatch = async (): Promise<BridgeDispatchResult> => {
        const first = await invokeOnce();
        const withRetries = (r: BridgeDispatchResult, retries: number): BridgeDispatchResult => {
          const diag = { ...r.result.diagnostics, retries };
          return {
            result: r.result.ok
              ? { ok: true, action: r.result.action, result: r.result.result, diagnostics: diag }
              : { ok: false, action: r.result.action, error: r.result.error, diagnostics: diag },
            release: r.release,
          };
        };
        if (
          !first.result.ok &&
          RETRY_ON_TRANSIENT.has(params.action) &&
          TRANSIENT_ERROR_CODES.has(first.result.error.code)
        ) {
          await first.release;
          await new Promise<void>((res) => setTimeout(res, 150));
          return withRetries(await invokeOnce(), 1);
        }
        return withRetries(first, 0);
      };

      // Serialize write actions per palace to avoid ChromaDB lock contention.
      if (isWriteAction(params.action)) {
        const mutexKey = canonicalPalaceKey(palacePath);
        const tail = palaceMutex.get(mutexKey) ?? RELEASED;
        const mine = tail.then(dispatch, dispatch);
        // Chaining uses the runtime completion signal, not just the call
        // result. A bridge_timeout can be returned to the caller before the
        // killed Python child has fully exited; next writer must wait until
        // that completion settles so sqlite/Chroma locks are released.
        const settled = mine
          .then(({ release }) => release, () => RELEASED)
          .then(() => {}, () => {});
        palaceMutex.set(mutexKey, settled);
        // GC the entry once the release signal settles, if no later writer has
        // stacked on top. Comparing identity preserves the chain when another
        // writer enqueued between `set` above and settlement.
        settled.then(() => {
          if (palaceMutex.get(mutexKey) === settled) {
            palaceMutex.delete(mutexKey);
          }
        });
        return (await mine).result;
      }

      return (await dispatch()).result;
    },
  };
}
