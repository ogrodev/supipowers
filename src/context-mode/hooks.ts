// src/context-mode/hooks.ts
import type { Platform } from "../platform/types.js";
import type { SupipowersConfig } from "../types.js";
import { OMP_MINIMIZER_FOOTER_RE, runEmissionPipeline } from "./compressor.js";
import { detectContextMode, type ContextModeStatus } from "./detector.js";
import { EventStore } from "./event-store.js";
import { extractEvents, extractPromptEvents } from "./event-extractor.js";
import { buildResumeSnapshot } from "./snapshot-builder.js";
import { routeToolCall } from "./routing.js";
import { KnowledgeStore } from "./knowledge/store.js";
import { registerContextModeTools } from "./tools.js";
import { MetricsStore, __setMetricsStoreForTest, _resetMetricsStoreCache } from "./metrics-store.js";
import { CacheStore } from "./cache-store.js";
import { MemoryStore, _setMemoryStoreRef } from "./memory-store.js";
import { toMetricRow } from "./metrics-recorder.js";
import { combinedTextOf, createDedupState, maybeSubstitute, type DedupState } from "./dedup.js";
import { uniqueSourceHash } from "./source-hash.js";
import { basename } from "node:path";
import { getProjectStateDir } from "../workspace/state-paths.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { registerUltraPlanHookBridge } from "../ultraplan/runtime/hook-bridge.js";
import { getProjectStatePath } from "../workspace/state-paths.js";
import { compressToolResultWithLLM } from "./compressor.js";
import { COMPACTION_SUMMARIZER_ACTION_ID } from "./model.js";
import { loadModelConfig } from "../config/model-config.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { createModelBridge, resolveModelForAction } from "../config/model-resolver.js";
import { extractFinalAssistantText } from "../ai/final-message.js";

type SessionContextLike = {
  cwd?: string;
  sessionManager?: { getSessionFile?: () => string } | null;
};

// Cached detection result
let cachedStatus: ContextModeStatus | null = null;

function buildActiveRoutingGuidance(status: ContextModeStatus): string | null {
  if (!status.available) return null;

  const activeTools = activeContextToolNames(status);
  const rescueTools = activeTools.filter((tool) =>
    tool === "ctx_execute" || tool === "ctx_search" || tool === "ctx_batch_execute",
  );
  const lines = [
    "# supi-context-mode",
    "Use active `ctx_*` tools shown in the tool catalog for high-output work; inactive ctx tools are intentionally unavailable this turn.",
    `Active context-mode rescue tools: ${rescueTools.length > 0 ? rescueTools.join(", ") : "none"}.`,
    "Routing blocks native tools only when the named replacement is active. If a specialized ctx tool is absent, use an active rescue tool or proceed with the native tool.",
  ];

  if (status.tools.ctxSearch || status.tools.ctxBatchExecute) {
    lines.push("For search/gather work, prefer active `ctx_search` or `ctx_batch_execute` over Search/Find outputs.");
  }
  if (status.tools.ctxExecute) {
    lines.push("Use active `ctx_execute` for shell/data processing that may emit large output.");
  }
  if (status.tools.ctxFetchAndIndex) {
    lines.push("Use active `ctx_fetch_and_index` for URLs, curl/wget, Fetch/WebFetch, or web docs.");
  }
  if (status.tools.ctxExecuteFile) {
    lines.push("Use active `ctx_execute_file` for analysis-only large-file processing without loading the file into context.");
  }
  if (status.tools.ctxOpenCached) {
    lines.push("Use active `ctx_open_cached` to read `cache://<sha>` handles in bounded slices via offset/limit.");
  }

  return lines.join("\n");
}

function activeContextToolNames(status: ContextModeStatus): string[] {
  const names: string[] = [];
  if (status.tools.ctxExecute) names.push("ctx_execute");
  if (status.tools.ctxSearch) names.push("ctx_search");
  if (status.tools.ctxBatchExecute) names.push("ctx_batch_execute");
  if (status.tools.ctxExecuteFile) names.push("ctx_execute_file");
  if (status.tools.ctxFetchAndIndex) names.push("ctx_fetch_and_index");
  if (status.tools.ctxOpenCached) names.push("ctx_open_cached");
  if (status.tools.ctxIndex) names.push("ctx_index");
  if (status.tools.ctxStats) names.push("ctx_stats");
  if (status.tools.ctxPurge) names.push("ctx_purge");
  if (status.tools.ctxRepomap) names.push("ctx_repomap");
  if (status.tools.ctxSymbol) names.push("ctx_symbol");
  return names;
}

function resolveSessionCwd(ctx?: SessionContextLike): string {
  return typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
}

function deriveSessionId(ctx?: SessionContextLike): string {
  try {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (typeof sessionFile === "string" && sessionFile.length > 0) {
      return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
    }
  } catch {
    // Best effort only — session lifecycle must never fail on ID derivation.
  }
  return `session-${Date.now()}`;
}

function textContentBytes(content: Array<{ type: string; text?: string }> | undefined): number {
  if (!content) return 0;
  return new TextEncoder().encode(combinedTextOf(content)).byteLength;
}

function isTextOnlyContent(content: Array<{ type: string; text?: string }>): boolean {
  return content.every((entry) => entry.type === "text");
}

function pickMemoryBody(category: string, data: Record<string, unknown>): string | null {
  switch (category) {
    case "decision": {
      const prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
      return prompt ? `decision: ${prompt.slice(0, 240)}` : null;
    }
    case "task": {
      const input = data.input as Record<string, unknown> | undefined;
      if (!input) return null;
      const text = JSON.stringify(input).slice(0, 240);
      return text ? `task: ${text}` : null;
    }
    case "intent": {
      const intent = typeof data.intent === "string" ? data.intent : null;
      const prompt = typeof data.prompt === "string" ? data.prompt.slice(0, 200) : "";
      if (!intent) return null;
      return `intent ${intent}: ${prompt}`.trim();
    }
    case "rule": {
      const file = typeof data.path === "string" ? data.path : null;
      return file ? `rule loaded: ${file}` : null;
    }
    default:
      return null;
  }
}

function memoryTypeFor(category: string): "observation" | "decision" | "task" {
  switch (category) {
    case "decision":
      return "decision";
    case "task":
      return "task";
    default:
      return "observation";
  }
}

function buildMemoryInjectionBlock(
  memoryStore: MemoryStore | null,
  sessionId: string,
  config: { byteBudget: number; maxRows: number },
): string | null {
  if (!memoryStore) return null;
  let rows;
  try {
    rows = memoryStore.retrieve({
      sessionId,
      byteBudget: config.byteBudget,
      limit: config.maxRows,
    });
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  const lines = ["# Cross-session memory"];
  for (const row of rows) {
    lines.push(`- [${row.type}] ${row.body}`);
  }
  return lines.join("\n");
}

function buildFocusChainBlock(
  eventStore: EventStore | null,
  sessionId: string,
  opts: { cadence: number; turnCount: number },
): string | null {
  if (!eventStore) return null;
  // Cadence gate: turn 1 always injects; subsequent turns inject only every Nth.
  // cadence < 1 is a config error guarded upstream by the schema; treat as 1
  // here for defensive behavior.
  const cadence = Math.max(1, Math.floor(opts.cadence));
  const turnCount = Math.max(1, Math.floor(opts.turnCount));
  if (turnCount !== 1 && turnCount % cadence !== 0) return null;
  let events;
  try {
    events = eventStore.getEvents(sessionId, { categories: ["task"], limit: 1 });
  } catch {
    return null;
  }
  if (events.length === 0) return null;
  let data: any;
  try {
    data = JSON.parse(events[0].data);
  } catch {
    return null;
  }
  const ops = (data?.input?.ops as Array<Record<string, unknown>> | undefined) ?? [];
  const summary = ops
    .map((op) => {
      const verb = typeof op.op === "string" ? op.op : "";
      const target = (typeof op.task === "string" && op.task)
        || (typeof op.phase === "string" && op.phase)
        || "";
      if (!verb) return null;
      return target ? `${verb}: ${target}` : verb;
    })
    .filter((line): line is string => Boolean(line));
  if (summary.length === 0) return null;
  return ["# Focus chain", ...summary.slice(0, 5).map((line) => `- ${line}`)].join("\n");
}

function readCompactOverride(paths: Platform["paths"], cwd: string): string | null {
  try {
    const filePath = paths.project(cwd, "compact.md");
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > 32 * 1024) return null;
    const text = readFileSync(filePath, "utf8");
    return text.trim() || null;
  } catch {
    return null;
  }
}

function getSessionDbPath(platform: Platform, cwd: string): string {
  return join(getProjectStatePath(platform.paths, cwd, "sessions"), "events.db");
}

function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Default per-call timeout for the compaction-time LLM summarizer. Compaction
 * already runs synchronously from OMP's perspective; bounding the LLM step
 * keeps it from extending compaction indefinitely on slow models or stuck
 * streams. The deterministic snapshot is persisted before this runs, so a
 * timeout fail is safe.
 */
const COMPACTION_LLM_TIMEOUT_MS = 10_000;

function buildSummarizeCallback(
  platform: Platform,
  cwd: string,
  modelId: string | undefined,
  thinkingLevel: string | null,
  timeoutMs: number,
): (text: string, toolName: string) => Promise<string> {
  return async (text: string, _toolName: string): Promise<string> => {
    if (typeof platform.createAgentSession !== "function") {
      // Platform stub or unavailable session API: degrade silently.
      return "";
    }
    let session: Awaited<ReturnType<Platform["createAgentSession"]>> | null = null;
    try {
      session = await platform.createAgentSession({
        cwd,
        ...(modelId ? { model: modelId } : {}),
        thinkingLevel: thinkingLevel ?? null,
      });
    } catch (e) {
      (platform as any).logger?.debug?.(
        "supi-context-mode: createAgentSession unavailable for summarizer",
        e,
      );
      return "";
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const promptPromise = session.prompt(text, { expandPromptTemplates: false });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("compaction-summarizer timeout")), timeoutMs);
      });
      await Promise.race([promptPromise, timeoutPromise]);
      const finalText = extractFinalAssistantText(session.state.messages);
      return finalText ?? "";
    } catch (e) {
      (platform as any).logger?.debug?.("supi-context-mode: summarizer prompt failed", e);
      return "";
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await session.dispose();
      } catch {
        // best effort
      }
    }
  };
}

interface SummarizeSnapshotOpts {
  platform: Platform;
  cwd: string;
  sessionId: string;
  snapshot: string;
  eventCount: number;
  eventStore: EventStore;
  compressionThreshold: number;
  llmThreshold: number;
}

/**
 * Wrap the deterministic resume snapshot in a synthetic ToolResultEventLike
 * and ask `compressToolResultWithLLM` to summarize it. On a successful
 * non-empty replacement, overwrite the resume row. On any failure, the
 * deterministic snapshot already persisted at the call site remains in place.
 */
async function summarizeSnapshotIfBudget(opts: SummarizeSnapshotOpts): Promise<void> {
  const modelConfig = (() => {
    try {
      return loadModelConfig(opts.platform.paths, opts.cwd);
    } catch {
      return null;
    }
  })();
  if (!modelConfig) return;

  const resolved = resolveModelForAction(
    COMPACTION_SUMMARIZER_ACTION_ID,
    modelRegistry,
    modelConfig,
    createModelBridge(opts.platform),
  );

  // No model resolved at all (no action override, no default, no role, no
  // main session model) — skip silently. The deterministic snapshot stays.
  if (!resolved.model) {
    (opts.platform as any).logger?.debug?.(
      "supi-context-mode: no model resolved for compaction-summarizer; skipping",
    );
    return;
  }

  const summarize = buildSummarizeCallback(
    opts.platform,
    opts.cwd,
    resolved.model,
    resolved.thinkingLevel,
    COMPACTION_LLM_TIMEOUT_MS,
  );

  const syntheticEvent = {
    toolName: "context-mode-snapshot",
    input: {},
    content: [{ type: "text", text: opts.snapshot }],
    isError: false,
    details: null,
  };

  const result = await compressToolResultWithLLM(
    syntheticEvent,
    opts.compressionThreshold,
    opts.llmThreshold,
    summarize,
  );

  if (!result || !result.content || result.content.length === 0) return;
  const summarized = result.content
    .map((entry) => (entry.type === "text" && typeof entry.text === "string" ? entry.text : ""))
    .join("\n")
    .trim();
  if (!summarized) return;

  try {
    opts.eventStore.upsertResume(opts.sessionId, summarized, opts.eventCount);
  } catch (e) {
    (opts.platform as any).logger?.warn?.(
      "supi-context-mode: failed to overwrite resume with summary",
      e,
    );
  }
}

/** Register supi-context-mode hooks on the platform */
export function registerContextModeHooks(platform: Platform, config: SupipowersConfig): void {
  if (!config.contextMode.enabled) return;

  let eventStore: EventStore | null = null;
  let eventStorePath: string | null = null;
  let metricsStore: MetricsStore | null = null;
  let metricsStorePath: string | null = null;
  let cacheStore: CacheStore | null = null;
  let cacheStorePath: string | null = null;
  let memoryStore: MemoryStore | null = null;
  let memoryStorePath: string | null = null;
  let knowledgeStore: KnowledgeStore | null = null;
  let knowledgeStorePath: string | null = null;
  let sessionCwd = process.cwd();
  let sessionId = deriveSessionId();
  let dedupState: DedupState = createDedupState();

  const ensureEventStore = (cwd: string): EventStore | null => {
    if (!config.contextMode.eventTracking) return null;

    const dbPath = getSessionDbPath(platform, cwd);
    if (eventStore && eventStorePath === dbPath) return eventStore;

    if (eventStore) {
      try {
        eventStore.close();
      } catch {
        // Best effort — we are about to reopen against the active session path.
      }
    }

    try {
      mkdirSync(getProjectStatePath(platform.paths, cwd, "sessions"), { recursive: true });
      eventStore = new EventStore(dbPath);
      eventStore.init();
      eventStore.pruneOldSessions(7);
      eventStorePath = dbPath;
      _eventStoreRef = eventStore;
      return eventStore;
    } catch (e) {
      eventStore = null;
      eventStorePath = null;
      _eventStoreRef = null;
      (platform as any).logger?.error?.("supi-context-mode: failed to initialize event store", e);
      return null;
    }
  };

  /** Mirror of ensureEventStore for the metrics sidecar; cwd-keyed.
   *  Closes any prior store when the cwd changes so we never write rows to
   *  the wrong project's metrics.db. */
  const ensureMetricsStore = (cwd: string): MetricsStore | null => {
    const dbPath = join(getProjectStatePath(platform.paths, cwd, "sessions"), "metrics.db");
    if (metricsStore && metricsStorePath === dbPath) return metricsStore;

    if (metricsStore) {
      try {
        metricsStore.close();
      } catch {
        // Best effort: we are about to reopen against the active project's metrics.db.
      }
    }

    try {
      mkdirSync(getProjectStatePath(platform.paths, cwd, "sessions"), { recursive: true });
      const slug = basename(getProjectStateDir(platform.paths, cwd));
      metricsStore = new MetricsStore({ dbPath, projectSlug: slug });
      metricsStore.init();
      metricsStorePath = dbPath;
      __setMetricsStoreForTest(metricsStore);
      return metricsStore;
    } catch (e) {
      metricsStore = null;
      metricsStorePath = null;
      __setMetricsStoreForTest(null);
      (platform as any).logger?.error?.("supi-context-mode: failed to initialize metrics store", e);
      return null;
    }
  };

  const ensureCacheStore = (cwd: string): CacheStore | null => {
    const sessionsDir = getProjectStatePath(platform.paths, cwd, "sessions");
    const dbPath = join(sessionsDir, "cache.db");
    const payloadRoot = join(sessionsDir, "cache-payloads");
    if (cacheStore && cacheStorePath === dbPath) {
      cacheStore.setMetricsRecorder(metricsStore, sessionId);
      return cacheStore;
    }

    if (cacheStore) {
      try {
        cacheStore.close();
      } catch {
        // Best effort: we are about to reopen against the active project's cache.db.
      }
    }

    try {
      mkdirSync(sessionsDir, { recursive: true });
      const slug = basename(getProjectStateDir(platform.paths, cwd));
      cacheStore = new CacheStore({
        dbPath,
        payloadRoot,
        projectSlug: slug,
        metricsStore,
        metricsSessionId: sessionId,
      });
      cacheStore.init();
      cacheStorePath = dbPath;
      _cacheStoreRef = cacheStore;
      return cacheStore;
    } catch (e) {
      cacheStore = null;
      cacheStorePath = null;
      _cacheStoreRef = null;
      (platform as any).logger?.error?.("supi-context-mode: failed to initialize cache store", e);
      return null;
    }
  };

  const ensureMemoryStore = (cwd: string): MemoryStore | null => {
    if (!config.contextMode.memory.enabled) return null;
    const sessionsDir = getProjectStatePath(platform.paths, cwd, "sessions");
    const dbPath = join(sessionsDir, "memory.db");
    if (memoryStore && memoryStorePath === dbPath) return memoryStore;

    if (memoryStore) {
      try { memoryStore.close(); } catch { /* best effort */ }
    }

    try {
      mkdirSync(sessionsDir, { recursive: true });
      const slug = basename(getProjectStateDir(platform.paths, cwd));
      memoryStore = new MemoryStore({ dbPath, projectSlug: slug });
      memoryStore.init();
      memoryStorePath = dbPath;
      _setMemoryStoreRef(memoryStore);
      return memoryStore;
    } catch (e) {
      memoryStore = null;
      memoryStorePath = null;
      _setMemoryStoreRef(null);
      (platform as any).logger?.error?.("supi-context-mode: failed to initialize memory store", e);
      return null;
    }
  };


  const ensureKnowledgeStore = (cwd: string): KnowledgeStore | null => {
    const sessionsDir = getProjectStatePath(platform.paths, cwd, "sessions");
    const dbPath = join(sessionsDir, "knowledge.db");
    if (knowledgeStore && knowledgeStorePath === dbPath) return knowledgeStore;

    if (knowledgeStore) {
      try {
        knowledgeStore.close();
      } catch {
        // Best effort: we are about to reopen against the active project's knowledge.db.
      }
    }

    try {
      mkdirSync(sessionsDir, { recursive: true });
      knowledgeStore = new KnowledgeStore(dbPath);
      knowledgeStore.init();
      knowledgeStorePath = dbPath;
      _knowledgeStoreRef = knowledgeStore;
      return knowledgeStore;
    } catch (e) {
      knowledgeStore = null;
      knowledgeStorePath = null;
      _knowledgeStoreRef = null;
      (platform as any).logger?.error?.("supi-context-mode: failed to initialize knowledge store", e);
      return null;
    }
  };
  ensureEventStore(sessionCwd);
  ensureMetricsStore(sessionCwd);
  ensureCacheStore(sessionCwd);
  ensureMemoryStore(sessionCwd);
  const initialKnowledgeStore = ensureKnowledgeStore(sessionCwd);

  _sessionIdRef = sessionId;

  // Register native context-mode tools. Store-dependent knowledge tools are
  // omitted when the knowledge DB cannot initialize, so routing never steers
  // the agent toward ctx_search/ctx_index calls that cannot satisfy requests.
  registerContextModeTools(platform, () => knowledgeStore, {
    knowledgeToolsEnabled: initialKnowledgeStore !== null,
    repomap: {
      enabled: config.contextMode.repomap.enabled,
      tokenBudget: config.contextMode.repomap.tokenBudget,
      maxFiles: config.contextMode.repomap.maxFiles,
    },
  });
  // Slice-2: register the UltraPlan hook bridge. The bridge is the only UltraPlan runtime module
  // this file imports; business decisions (normalization, reducer, migration, repair, tracker
  // storage) all live inside the bridge. When no canonical UltraPlan session is active, the
  // bridge's handlers are no-ops.
  registerUltraPlanHookBridge(platform);

  platform.on("session_start", (_event, ctx) => {
    sessionCwd = resolveSessionCwd(ctx as SessionContextLike | undefined);
    sessionId = deriveSessionId(ctx as SessionContextLike | undefined);
    _sessionIdRef = sessionId;
    dedupState = createDedupState();
    // Reset focus-chain turn counter so the next before_agent_start re-arms turn 1.
    _focusChainTurnCounters.delete(sessionId);

    const store = ensureEventStore(sessionCwd);
    if (store) {
      try {
        store.upsertMeta(sessionId, sessionCwd);
      } catch (e) {
        (platform as any).logger?.warn?.("supi-context-mode: failed to initialize session metadata", e);
      }
    }

    const metrics = ensureMetricsStore(sessionCwd);
    if (metrics) {
      try {
        metrics.upsertSession({ session_id: sessionId, cwd: sessionCwd });
      } catch (e) {
        (platform as any).logger?.warn?.("supi-context-mode: failed to initialize metrics session metadata", e);
      }
    }

    ensureCacheStore(sessionCwd);
    ensureMemoryStore(sessionCwd);
    ensureKnowledgeStore(sessionCwd);
  });

  platform.on("session_shutdown", () => {
    dedupState = createDedupState();
    // Close knowledge store
    if (knowledgeStore) {
      try {
        knowledgeStore.close();
      } catch {
        // Best effort
      } finally {
        knowledgeStore = null;
        _knowledgeStoreRef = null;
        knowledgeStorePath = null;
      }
    }
    // Promote high-priority observations into memory before closing event store.
    if (memoryStore && eventStore && config.contextMode.memory.enabled) {
      try {
        const events = eventStore.getEvents(sessionId, {
          categories: ["decision", "task", "intent", "rule"],
          limit: 50,
        });
        for (const event of events) {
          let data: any = null;
          try { data = JSON.parse(event.data); } catch { /* skip malformed payloads */ }
          if (!data) continue;
          const body = pickMemoryBody(event.category, data);
          if (!body) continue;
          memoryStore.put({
            ownerScope: "project",
            type: memoryTypeFor(event.category),
            body,
            priority: event.priority,
          });
        }
      } catch (e) {
        (platform as any).logger?.warn?.("supi-context-mode: memory promotion failed", e);
      }
    }

    // Prune + close cache store before metrics so L3 prune rows can be recorded.
    if (cacheStore) {
      try {
        cacheStore.setMetricsRecorder(metricsStore, sessionId);
        cacheStore.pruneOldSessions(7);
        cacheStore.close();
      } catch (e) {
        (platform as any).logger?.warn?.("supi-context-mode: failed to close cache store", e);
      } finally {
        cacheStore = null;
        cacheStorePath = null;
        _cacheStoreRef = null;
      }
    }


    // Prune + close metrics store independently of event store status.
    if (metricsStore) {
      try {
        metricsStore.pruneOldSessions(7);
        metricsStore.close();
      } catch (e) {
        (platform as any).logger?.warn?.("supi-context-mode: failed to close metrics store", e);
      } finally {
        metricsStore = null;
        metricsStorePath = null;
        __setMetricsStoreForTest(null);
      }
    }

    if (memoryStore) {
      try {
        memoryStore.pruneOld(config.contextMode.memory.retentionDays);
        memoryStore.close();
      } catch (e) {
        (platform as any).logger?.warn?.("supi-context-mode: failed to close memory store", e);
      } finally {
        memoryStore = null;
        memoryStorePath = null;
        _setMemoryStoreRef(null);
      }
    }


    if (!eventStore) {
      _eventStoreRef = null;
      _sessionIdRef = "";
      return;
    }

    try {
      eventStore.pruneOldSessions(7);
      eventStore.close();
    } catch (e) {
      (platform as any).logger?.warn?.("supi-context-mode: failed to close event store", e);
    } finally {
      eventStore = null;
      eventStorePath = null;
      _eventStoreRef = null;
      _sessionIdRef = "";
    }
  });

  // Phase 1: Result compression + Phase 2: Event extraction
  platform.on("tool_result", (event) => {
    const projectSlug = basename(getProjectStateDir(platform.paths, sessionCwd));

    // Phase 1: compression + forward-only same-source dedup
    const pipeline = runEmissionPipeline(event, config.contextMode.compressionThreshold, {
      processors: config.contextMode.processors,
    });
    let compressed = pipeline.result;
    let processorKey = pipeline.processorKey;
    const sourceHash = uniqueSourceHash({
      tool: event.toolName,
      input: event.input,
      cwd: sessionCwd,
      projectSlug,
    });

    try {
      const processedBytes = compressed?.content
        ? new TextEncoder().encode(combinedTextOf(compressed.content)).byteLength
        : 0;
      const deduped = maybeSubstitute({
        result: compressed,
        processorKey,
        sourceHash,
        dedupState,
        processedBytes,
      });
      compressed = deduped.result;
      processorKey = deduped.processorKey;
    } catch (e) {
      (platform as any).logger?.warn?.("supi-context-mode: dedup substitution failed", e);
    }

    // Phase 3: optional L3 cache-handle spill for oversized current emissions.
    if (config.contextMode.cacheHandles.enabled && cacheStore && !event.isError && isTextOnlyContent(event.content)) {
      const finalContent = compressed?.content ?? event.content;
      const finalText = combinedTextOf(finalContent);
      const finalBytes = textContentBytes(finalContent);
      const originalText = combinedTextOf(event.content);
      if (
        finalBytes > config.contextMode.cacheHandles.spillThresholdBytes
        && originalText.length > 0
        && !OMP_MINIMIZER_FOOTER_RE.test(finalText)
        && !OMP_MINIMIZER_FOOTER_RE.test(originalText)
      ) {
        try {
          const cached = cacheStore.putText({
            sessionId,
            text: originalText,
            sourceTool: event.toolName,
            sourceHash,
            previewBytes: config.contextMode.cacheHandles.previewBytes,
            recordMetric: false,
          });
          const replacementText = [
            `Cached oversized ${event.toolName} result as ${cached.handle}.`,
            `Original size: ${cached.sizeBytes} bytes. Preview below is bounded to ${config.contextMode.cacheHandles.previewBytes} chars.`,
            `Open the full payload with ctx_open_cached(handle: "${cached.handle}", offset: 0, limit: <chars>).`,
            "",
            "--- preview ---",
            cached.preview,
          ].join("\n");
          compressed = { content: [{ type: "text", text: replacementText }] };
          processorKey = "cache-spill";
        } catch (e) {
          (platform as any).logger?.warn?.("supi-context-mode: cache spill failed", e);
        }
      }
    }

    // Phase 2: event extraction (fire-and-forget)
    if (eventStore && config.contextMode.eventTracking) {
      try {
        const events = extractEvents(event, sessionId, sourceHash);
        if (events.length > 0) eventStore.writeEvents(events);
      } catch (e) {
        (platform as any).logger?.warn?.("supi-context-mode: event extraction failed", e);
      }
    }

    // Metrics recording (fire-and-forget; never throws back to the agent).
    if (metricsStore) {
      try {
        const usage = (() => {
          try {
            const raw = (event as any).contextUsage
              ?? (event as any).context
              ?? null;
            if (!raw || typeof raw !== "object") return null;
            return {
              tokens: typeof raw.tokens === "number" ? raw.tokens : null,
              contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : null,
              percent: typeof raw.percent === "number" ? raw.percent : null,
            };
          } catch {
            return null;
          }
        })();
        const row = toMetricRow({
          event,
          compressed,
          sessionId,
          cwd: sessionCwd,
          projectSlug,
          contextUsage: usage,
          ts: Date.now(),
          processorKey,
          sourceHash,
          layer: processorKey === "cache-spill" ? "L3" : "L2",
        });
        metricsStore.record(row);
      } catch (e) {
        (platform as any).logger?.warn?.("supi-context-mode: metrics record failed", e);
      }
    }

    return compressed;
  });

  // Phase 1: Tool routing — block native tools and redirect to ctx_* equivalents
  platform.on("tool_call", (event) => {
    // Always re-detect: MCP tools may load after extension init
    const status = detectContextMode(platform.getActiveTools());
    cachedStatus = status;

    return routeToolCall(event.toolName, event.input as any, status, {
      enforceRouting: config.contextMode.enforceRouting,
      blockHttpCommands: config.contextMode.blockHttpCommands,
    });
  });

  // Phase 1: Routing instructions + Phase 2: Prompt event extraction
  platform.on("before_agent_start", (event, ctx) => {
    // Phase 2: prompt event extraction (fire-and-forget)
    if (eventStore && config.contextMode.eventTracking) {
      try {
        const prompt = (event as any).prompt as string | undefined;
        if (prompt) {
          const events = extractPromptEvents(prompt, sessionId);
          if (events.length > 0) eventStore.writeEvents(events);
        }
      } catch (e) {
        (platform as any).logger?.warn?.("supi-context-mode: prompt event extraction failed", e);
      }
    }

    // Phase 1 routing instructions are gated by config; memory + focus chain are always considered.
    const routingEnabled = config.contextMode.routingInstructions || config.contextMode.enforceRouting;
    const status = detectContextMode(platform.getActiveTools());
    const guidance = routingEnabled ? buildActiveRoutingGuidance(status) : null;
    const memoryBlock = config.mempalace?.enabled
      ? null
      : buildMemoryInjectionBlock(memoryStore, sessionId, config.contextMode.memory);
    // Increment per-session turn counter for focus-chain cadence gating.
    // First call after session_start is turn 1 (always injects).
    const prevTurn = _focusChainTurnCounters.get(sessionId) ?? 0;
    const turnCount = prevTurn + 1;
    _focusChainTurnCounters.set(sessionId, turnCount);
    const focusBlock = buildFocusChainBlock(eventStore, sessionId, {
      cadence: config.contextMode.memory.focusChainCadence,
      turnCount,
    });
    const sections = [guidance, memoryBlock, focusBlock].filter((s): s is string => Boolean(s));
    if (sections.length === 0) return;
    const injection = sections.join("\n\n");

    let systemPrompt = (event as any).systemPrompt as string | undefined;
    const getSystemPrompt = (ctx as any)?.getSystemPrompt;
    if (typeof getSystemPrompt === "function") {
      try {
        const currentPrompt = getSystemPrompt();
        if (typeof currentPrompt === "string") systemPrompt = currentPrompt;
      } catch (e) {
        (platform as any).logger?.warn?.("supi-context-mode: failed to read current system prompt", e);
      }
    }
    if (!systemPrompt) return { systemPrompt: injection };
    return { systemPrompt: systemPrompt + "\n\n" + injection };
  });

  // Phase 3: Compaction integration
  const compactionStore = config.contextMode.compaction ? ensureEventStore(sessionCwd) : null;
  if (compactionStore) {

    // Initialize fallback session metadata for sessions that never emit session_start in tests.
    try {
      compactionStore.upsertMeta(sessionId, sessionCwd);
    } catch {
      // Non-fatal: metadata is supplementary
    }

    platform.on("session_before_compact", async () => {
      // Re-detect MCP tools: they may have loaded since init
      const status = cachedStatus ?? detectContextMode(platform.getActiveTools());
      const searchAvailable = status.tools.ctxSearch;

      // Determine the search tool name for reference-based snapshots
      let searchTool: string | undefined;
      if (searchAvailable) {
        const tools = platform.getActiveTools();
        searchTool = tools.find((t) => t.includes("ctx_search"));
      }

      // Read compact count from metadata
      let compactCount = 0;
      try {
        const meta = eventStore!.getMeta(sessionId);
        compactCount = meta?.compactCount ?? 0;
      } catch {
        // Non-fatal
      }

      let snapshot: string | null = null;
      let eventCount = 0;
      try {
        const compactOverride = readCompactOverride(platform.paths, sessionCwd);
        let built = buildResumeSnapshot(eventStore!, sessionId, {
          compactCount,
          searchTool,
          searchAvailable,
        });
        if (compactOverride) {
          built = `${compactOverride}\n\n${built ?? ""}`.trim();
        }

        // Persist deterministic snapshot to DB so it survives crashes — this
        // is the contract. The LLM step below is a best-effort improvement.
        if (built) {
          eventCount = Object.values(eventStore!.getEventCounts(sessionId))
            .reduce((a, b) => a + b, 0);
          eventStore!.upsertResume(sessionId, built, eventCount);
          snapshot = built;
        }
      } catch (e) {
        (platform as any).logger?.warn?.("context-mode: snapshot build failed", e);
        return undefined;
      }

      // Best-effort LLM summarization, gated by config + size. Failures keep
      // the deterministic snapshot already persisted above.
      if (
        snapshot
        && config.contextMode.llmSummarization
        && byteLengthOf(snapshot) > config.contextMode.llmThreshold
      ) {
        try {
          await summarizeSnapshotIfBudget({
            platform,
            cwd: sessionCwd,
            sessionId,
            snapshot,
            eventCount,
            eventStore: eventStore!,
            compressionThreshold: config.contextMode.compressionThreshold,
            llmThreshold: config.contextMode.llmThreshold,
          });
        } catch (e) {
          (platform as any).logger?.warn?.("context-mode: LLM summarization failed", e);
        }
      }

      return undefined; // don't cancel or replace compaction
    });

    platform.on("session_compact", () => {
      // Try resume from DB first, fall back to in-memory
      let snapshot: string | null = null;
      try {
        const resume = eventStore!.getResume(sessionId);
        if (resume) {
          snapshot = resume.snapshot;
          eventStore!.consumeResume(sessionId);
        }
      } catch {
        // Non-fatal: fall through
      }

      if (!snapshot) return undefined;

      // Track compaction count in session metadata
      try {
        eventStore!.incrementCompactCount(sessionId);
      } catch {
        // Non-fatal
      }

      return {
        context: snapshot.split("\n"),
        preserveData: {
          resumeSnapshot: snapshot,
          eventCounts: eventStore!.getEventCounts(sessionId),
        },
      };
    });
  }
}

/** Get the event store instance (for use by compaction hooks) */
export function getEventStore(): EventStore | null {
  return _eventStoreRef;
}

/** Get the metrics store instance (for use by /supi:context, ctx_stats, /supi:clear). */
export { getMetricsStore } from "./metrics-store.js";

/** Get the active knowledge store (for use by /supi:clear and scoped context reset). */
export function getKnowledgeStore(): KnowledgeStore | null {
  return _knowledgeStoreRef;
}

/** Get the cache store instance (for use by ctx_open_cached and /supi:clear). */
export function getCacheStore(): CacheStore | null {
  return _cacheStoreRef;
}

/** Test-only cache store setter for tool/command tests. */
export function __setCacheStoreForTest(store: CacheStore | null): void {
  _cacheStoreRef = store;
}

/** Get the session ID (for use by compaction hooks) */
export function getSessionId(): string {
  return _sessionIdRef;
}

// Module-level refs updated by registerContextModeHooks
let _eventStoreRef: EventStore | null = null;
let _knowledgeStoreRef: KnowledgeStore | null = null;
let _cacheStoreRef: CacheStore | null = null;
let _sessionIdRef = "";

/**
 * Per-session turn counter for focus-chain cadence gating. Held in-memory
 * only — see L5 design spec D5: loss across crashes is acceptable, worst case
 * is one extra reinjection on resume. Keyed by sessionId.
 */
const _focusChainTurnCounters = new Map<string, number>();

/** Reset cached state (for testing) */
export function _resetCache(): void {
  cachedStatus = null;
  _eventStoreRef = null;
  _knowledgeStoreRef = null;
  _cacheStoreRef = null;
  _sessionIdRef = "";
  _focusChainTurnCounters.clear();
  _resetMetricsStoreCache();
}