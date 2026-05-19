import type { Platform } from "../platform/types.js";
import { normalizeSystemPromptBlocks } from "../platform/system-prompt.js";
import type { SupipowersConfig } from "../types.js";
import { createMempalaceBridge, type MempalaceBridgeFacade } from "./bridge.js";
import { resolveDefaultWing, resolveMempalaceConfig, type ResolvedMempalaceConfig } from "./config.js";
import { resolveInstalledBridgeScriptPath } from "./runtime.js";
import { getEventStore as getContextEventStore, getSessionId as getContextSessionId } from "../context-mode/hooks.js";
import { buildCompactionCheckpoint, buildShutdownDiary } from "./session-summary.js";
import { snapshotMempalaceInstall } from "./installer-helper.js";
import { buildMempalaceGuidance } from "./contract.js";

export interface MempalaceHooksDeps {
  createBridge?: (config: ResolvedMempalaceConfig, cwd: string) => MempalaceBridgeFacade;
  getEventStore?: () => Parameters<typeof buildCompactionCheckpoint>[0]["eventStore"];
  getSessionId?: () => string;
  now?: () => string;
  snapshotInstall?: (paths: Platform["paths"], cwd: string, config: SupipowersConfig) => { ready: boolean };
}

/** Maximum number of (sessionId × wing × palace) entries to keep in memory. */
const HOOK_CACHE_LRU_CAP = 64;

/** Insertion-ordered bounded LRU. Drops the least-recently-used entry on overflow. */
class BoundedLRU<K, V> {
  private readonly inner = new Map<K, V>();

  constructor(private readonly cap: number) {}

  get(key: K): V | undefined {
    if (!this.inner.has(key)) return undefined;
    const value = this.inner.get(key) as V;
    this.inner.delete(key);
    this.inner.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.inner.has(key)) {
      this.inner.delete(key);
    } else if (this.inner.size >= this.cap) {
      const oldest = this.inner.keys().next().value;
      if (oldest !== undefined) this.inner.delete(oldest);
    }
    this.inner.set(key, value);
  }

  delete(key: K): boolean {
    return this.inner.delete(key);
  }

  clear(): void {
    this.inner.clear();
  }

  keys(): IterableIterator<K> {
    return this.inner.keys();
  }
}

function warnHookStateFallback(platform: Platform, message: string): void {
  const logger = (platform as { logger?: { warn?: (message: string) => void } }).logger;
  if (typeof logger?.warn === "function") {
    logger.warn(message);
    return;
  }
  console.warn(message);
}

function hookTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.floor(timeoutMs / 1000));
}

const wakeUpCache = new BoundedLRU<string, string>(HOOK_CACHE_LRU_CAP);

/**
 * Per-session turn counter for wake-up cadence gating. The full wake-up block
 * is injected on turn 1 and every Nth turn thereafter (where N is
 * `mempalace.budgets.wakeUpInjectionEvery`); other turns get a one-line
 * refresher. Cleared on session_start / session_switch.
 */
const turnCounters = new BoundedLRU<string, number>(HOOK_CACHE_LRU_CAP);

/** Test-only: reset cadence state between cases. */
export function _resetMempalaceHookState(): void {
  wakeUpCache.clear();
  turnCounters.clear();
}

function contextCwd(ctx: unknown): string {
  return typeof ctx === "object" && ctx !== null && typeof (ctx as { cwd?: unknown }).cwd === "string"
    ? (ctx as { cwd: string }).cwd
    : process.cwd();
}

function sessionIdFrom(event: unknown, ctx: unknown): string {
  for (const source of [event, ctx]) {
    if (typeof source === "object" && source !== null) {
      const value = (source as { sessionId?: unknown }).sessionId;
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return "default-session";
}

function currentSystemPromptBlocks(event: unknown, ctx: unknown): string[] {
  if (typeof ctx === "object" && ctx !== null && typeof (ctx as { getSystemPrompt?: unknown }).getSystemPrompt === "function") {
    try {
      const prompt = (ctx as { getSystemPrompt: () => unknown }).getSystemPrompt();
      if (prompt != null) return normalizeSystemPromptBlocks(prompt);
    } catch {
      // best effort: fall back to event value
    }
  }
  return normalizeSystemPromptBlocks(
    typeof event === "object" && event !== null
      ? (event as { systemPrompt?: unknown }).systemPrompt
      : undefined,
  );
}

function appendPrompt(base: unknown, block: string): { systemPrompt: string[] } {
  return { systemPrompt: [...normalizeSystemPromptBlocks(base), block] };
}

function truncateByTokenBudget(text: string, tokens: number): string {
  const maxChars = Math.max(200, tokens * 4);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function wakeText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    for (const key of ["text", "summary", "content", "wake_up"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return JSON.stringify(result ?? {});
}

function setupGuidanceBlock(resolved: ResolvedMempalaceConfig, wing: string): string {
  return [
    "# MemPalace memory",
    `- palace: ${resolved.palacePath}`,
    `- default wing: ${wing}`,
    "- MemPalace runtime is not ready. Run `/supi:memory setup` (or call the `mempalace(action=\"setup\")` tool), then `mempalace(action=\"init\")` and `mempalace(action=\"mine\")` when appropriate.",
  ].join("\n");
}

function wakeFailureBlock(resolved: ResolvedMempalaceConfig, wing: string, error: string): string {
  return [
    "# MemPalace memory",
    `- palace: ${resolved.palacePath}`,
    `- default wing: ${wing}`,
    `- Wake-up failed: ${error}`,
  ].join("\n");
}

function wakeUpBlock(resolved: ResolvedMempalaceConfig, wing: string, text: string): string {
  const excerpt = truncateByTokenBudget(text, resolved.budgets.wakeUpTokens);
  const lines = [
    "# MemPalace memory",
    `- palace: ${resolved.palacePath}`,
    `- default wing: ${wing}`,
    "",
    ...buildMempalaceGuidance(resolved.hooks, "full"),
  ].filter((line) => line.length > 0);
  if (excerpt.trim()) {
    lines.push("", "## Wake-up excerpt", excerpt.trim());
  }
  return lines.join("\n");
}

/**
 * Compact refresher injected on turns where we skip the full wake-up dump.
 * Keeps the model oriented (palace/wing) and re-asserts the MemPalace
 * read/write contract without paying for the wake-up excerpt.
 */
function wakeUpRefresher(resolved: ResolvedMempalaceConfig, wing: string): string {
  const lines = [
    `# MemPalace memory: wing=${wing}`,
    ...buildMempalaceGuidance(resolved.hooks, "refresher"),
  ];
  return lines.join("\n");
}

/**
 * Pull the user's incoming prompt out of the before_agent_start event.
 * OMP exposes it as `event.prompt`; on agent-driven turns it may be empty.
 */
function extractUserPrompt(event: unknown): string {
  if (typeof event !== "object" || event === null) return "";
  const value = (event as { prompt?: unknown }).prompt;
  return typeof value === "string" ? value.trim() : "";
}

/** Minimum prompt length below which we skip auto-search (saves a bridge call). */
const AUTO_SEARCH_MIN_PROMPT_CHARS = 15;

/**
 * Returns `true` when `prompt` warrants a MemPalace auto-search.
 * Rules applied in order:
 *   1. Too-short or trivial filler word → skip (saves the bridge round-trip).
 *   2. Contains "?" or starts with a question word → search.
 *   3. Contains a memory/recall signal → search.
 *   4. Starts with a clearly imperative verb and has no search signal → skip.
 *   5. Ambiguous → search (preserves recall on uncertain prompts).
 */
function shouldAutoSearchPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  // Rule 1: trivial length or obvious filler.
  if (normalized.length < AUTO_SEARCH_MIN_PROMPT_CHARS) return false;
  const TRIVIAL = new Set(["yes", "no", "ok", "okay", "thanks", "thank you", "great", "cool", "go", "continue", "proceed"]);
  if (TRIVIAL.has(normalized)) return false;
  // Rule 2: explicit question signals → search.
  if (prompt.includes("?")) return true;
  const QUESTION_PREFIXES = ["what", "why", "when", "who", "where", "how", "which", "do", "does", "is", "are", "can", "should"];
  if (QUESTION_PREFIXES.some(p => normalized.startsWith(p + " ") || normalized === p)) return true;
  // Rule 3: memory/recall signal words → search.
  const RECALL_SIGNALS = ["remember", "recall", "decided", "decision", "chose", "last time", "previously", "earlier", "before"];
  if (RECALL_SIGNALS.some(s => normalized.includes(s))) return true;
  // Rule 4: clearly imperative verb at start, no search signal above → skip.
  const IMPERATIVE_PREFIXES = ["fix", "add", "remove", "delete", "run", "update", "refactor", "rename", "move", "write", "create", "make", "implement", "build"];
  if (IMPERATIVE_PREFIXES.some(p => normalized.startsWith(p + " ") || normalized === p)) return false;
  // Rule 5: ambiguous → search.
  return true;
}

interface SearchHit {
  text?: unknown;
  source_file?: unknown;
  room?: unknown;
  bm25_score?: unknown;
  similarity?: unknown;
}

function pickHits(result: unknown): SearchHit[] {
  if (typeof result !== "object" || result === null) return [];
  const raw = (result as { results?: unknown }).results;
  return Array.isArray(raw) ? raw.filter((hit): hit is SearchHit => typeof hit === "object" && hit !== null) : [];
}

/** Score-gated relevance check so we don't inject low-quality matches as noise. */
function isRelevantHit(hit: SearchHit, similarityFloor: number, bm25Floor: number): boolean {
  const sim = typeof hit.similarity === "number" ? hit.similarity : null;
  const bm25 = typeof hit.bm25_score === "number" ? hit.bm25_score : null;
  // Either signal must clear the configured floor. similarity is ~1.0 for
  // perfect, ~0.5 for "kinda related"; bm25 is unbounded but >0.3 is meaningful.
  if (sim !== null && sim >= similarityFloor) return true;
  if (bm25 !== null && bm25 >= bm25Floor) return true;
  return false;
}

/**
 * Format relevant search hits as a compact bulleted section. Snippet length,
 * per-hit cost, and total budget are all bounded so a single auto-search
 * cannot blow the per-turn allowance.
 */
function autoSearchBlock(hits: SearchHit[], budgetTokens: number): string | null {
  if (hits.length === 0) return null;
  const maxChars = Math.max(200, budgetTokens * 4);
  const lines = ["", "## Relevant memories"];
  let used = lines.reduce((acc, line) => acc + line.length + 1, 0);
  for (const hit of hits) {
    const source = typeof hit.source_file === "string" ? hit.source_file : "?";
    const room = typeof hit.room === "string" ? hit.room : "?";
    const text = typeof hit.text === "string" ? hit.text : "";
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 120);
    const entry = `- [${room}/${source}] ${snippet}${text.length > 120 ? "…" : ""}`;
    if (used + entry.length + 1 > maxChars) break;
    lines.push(entry);
    used += entry.length + 1;
  }
  if (lines.length === 2) return null; // header only
  return lines.join("\n");
}

export function registerMempalaceHooks(
  platform: Platform,
  config: SupipowersConfig,
  deps: MempalaceHooksDeps = {},
): void {
  if (!config.mempalace.enabled) return;

  const snapshotInstall = deps.snapshotInstall ?? snapshotMempalaceInstall;
  const isInstallReady = (cwd: string): boolean => snapshotInstall(platform.paths, cwd, config).ready;

  const bridgeRuntime = {
    resolveBridgeScriptPath: () => resolveInstalledBridgeScriptPath(platform.paths),
  };

  const clearSessionState = (sessionId: string): void => {
    for (const key of [...wakeUpCache.keys()]) {
      if (key.startsWith(`${sessionId}|`)) wakeUpCache.delete(key);
    }
    for (const key of [...turnCounters.keys()]) {
      if (key.startsWith(`${sessionId}|`)) turnCounters.delete(key);
    }
  };

  const clearForSession = (event: unknown): void => {
    const source = typeof event === "object" && event !== null ? event as { sessionId?: unknown; previousSessionId?: unknown } : null;
    const sessionId = typeof source?.sessionId === "string" && source.sessionId.length > 0 ? source.sessionId : null;
    const previousSessionId =
      typeof source?.previousSessionId === "string" && source.previousSessionId.length > 0 ? source.previousSessionId : null;
    if (sessionId === null && previousSessionId === null) {
      warnHookStateFallback(platform, "[mempalace hooks] session event missing sessionId — clearing all hook state");
      wakeUpCache.clear();
      turnCounters.clear();
      return;
    }
    if (sessionId !== null) clearSessionState(sessionId);
    if (previousSessionId !== null) clearSessionState(previousSessionId);
  };
  platform.on("session_start", clearForSession);
  platform.on("session_switch", clearForSession);

  platform.on("before_agent_start", async (event: unknown, ctx: unknown) => {
    const wakeUpEnabled = config.mempalace.hooks.wakeUp;
    const guidanceEnabled = config.mempalace.hooks.searchGuidance;
    const autoSearchEnabled = config.mempalace.hooks.autoSearchOnPrompt;
    const writeGuidanceEnabled = config.mempalace.hooks.writeGuidance;
    if (!wakeUpEnabled && !guidanceEnabled && !writeGuidanceEnabled && !autoSearchEnabled) return undefined;

    const cwd = contextCwd(ctx);
    const resolved = resolveMempalaceConfig(config, cwd, platform.paths);
    let wing: string;
    try {
      wing = resolveDefaultWing(resolved, cwd, platform.paths);
    } catch {
      wing = "project";
    }
    const sessionId = sessionIdFrom(event, ctx);
    const cacheKey = `${sessionId}|${wing}|${resolved.palacePath}`;
    const basePrompt = currentSystemPromptBlocks(event, ctx);
    if (!isInstallReady(cwd)) {
      return appendPrompt(basePrompt, setupGuidanceBlock(resolved, wing));
    }
    const userPrompt = extractUserPrompt(event);

    const bridge = deps.createBridge
      ? deps.createBridge(resolved, cwd)
      : createMempalaceBridge({ cwd, config: resolved, runtime: bridgeRuntime });

    // Cadence gating: wake-up dump on turn 1 and every Nth turn; refresher
    // otherwise. Saves ~750 tokens/turn average for a default cadence of 10.
    const cadence = Math.max(1, Math.floor(resolved.budgets.wakeUpInjectionEvery));
    const turnKey = `${sessionId}|${wing}|${resolved.palacePath}`;
    const turnCount = (turnCounters.get(turnKey) ?? 0) + 1;
    turnCounters.set(turnKey, turnCount);
    const isFullInjectionTurn = turnCount === 1 || turnCount % cadence === 0;

    // On cadence-gated turns: one bridge.execute call handles both wake and search
    // (wake_up_and_search). On non-injection turns: refresher string + optional
    // separate search call. Either path issues at most one bridge call per turn.
    const timeoutSeconds = hookTimeoutSeconds(resolved.timeouts.hookMs); /* seconds; bridge multiplies by 1000 */
    const wantsSearch = autoSearchEnabled && shouldAutoSearchPrompt(userPrompt);
    // Let upstream MemPalace extract the salient question/tail from long prompts.
    const query = wantsSearch ? userPrompt : undefined;

    let wakeBlock: string;
    let searchBlock: string | null = null;

    if (!isFullInjectionTurn) {
      // Non-injection turns: lightweight refresher, no wake bridge call needed.
      wakeBlock = wakeUpRefresher(resolved, wing);
      if (wantsSearch) {
        try {
          const result = await bridge.execute({ action: "search", query: query!, wing, limit: 3, timeout: timeoutSeconds });
          if (result.ok) {
            const { autoSearchSimilarityFloor, autoSearchBm25Floor } = resolved.budgets;
            const hits = pickHits(result.result).filter(hit => isRelevantHit(hit, autoSearchSimilarityFloor, autoSearchBm25Floor));
            searchBlock = autoSearchBlock(hits, resolved.budgets.autoSearchTokens);
          }
        } catch {
          // Auto-search is best-effort. A failure here must never block the turn.
        }
      }
    } else {
      const cached = wakeUpCache.get(cacheKey);
      if (cached) {
        // Wake block is already cached — only issue a search call if warranted.
        wakeBlock = cached;
        if (wantsSearch) {
          try {
            const result = await bridge.execute({ action: "search", query: query!, wing, limit: 3, timeout: timeoutSeconds });
            if (result.ok) {
              const { autoSearchSimilarityFloor, autoSearchBm25Floor } = resolved.budgets;
              const hits = pickHits(result.result).filter(hit => isRelevantHit(hit, autoSearchSimilarityFloor, autoSearchBm25Floor));
              searchBlock = autoSearchBlock(hits, resolved.budgets.autoSearchTokens);
            }
          } catch {
            // Auto-search is best-effort. A failure here must never block the turn.
          }
        }
      } else {
        // Cache miss: batch wake + search into one bridge call.
        const batchResult = await bridge.execute({
          action: "wake_up_and_search",
          wing,
          timeout: timeoutSeconds,
          ...(query !== undefined ? { query, limit: 3 } : {}),
        });
        const composite = batchResult.ok ? (batchResult.result as Record<string, unknown>) : null;
        const compositeWake = composite !== null ? (composite.wake as Record<string, unknown> | null | undefined) : undefined;
        const wakeError = composite !== null && typeof composite.wake_error === "string" ? composite.wake_error : "wake_up failed";
        const block = compositeWake != null
          ? wakeUpBlock(resolved, wing, wakeText(compositeWake))
          : batchResult.ok
            ? wakeFailureBlock(resolved, wing, wakeError)
            : setupGuidanceBlock(resolved, wing);
        wakeUpCache.set(cacheKey, block);
        wakeBlock = block;

        // Extract search hits from the composite result (only if search was requested).
        const compositeSearch = composite !== null ? composite.search : undefined;
        if (compositeSearch != null && autoSearchEnabled) {
          const { autoSearchSimilarityFloor, autoSearchBm25Floor } = resolved.budgets;
          const hits = pickHits(compositeSearch).filter(hit => isRelevantHit(hit, autoSearchSimilarityFloor, autoSearchBm25Floor));
          searchBlock = autoSearchBlock(hits, resolved.budgets.autoSearchTokens);
        }
      }
    }

    const combined = searchBlock ? `${wakeBlock}\n${searchBlock}` : wakeBlock;
    return appendPrompt(basePrompt, combined);
  });

  if (config.mempalace.hooks.compactionCheckpoint) {
    platform.on("session_before_compact", async (_event: unknown, ctx: unknown) => {
      try {
        const cwd = contextCwd(ctx);
        if (!isInstallReady(cwd)) return undefined;
        const resolved = resolveMempalaceConfig(config, cwd, platform.paths);
        let wing: string;
        try {
          wing = resolveDefaultWing(resolved, cwd, platform.paths);
        } catch {
          wing = "project";
        }
        const sessionId = deps.getSessionId?.() ?? getContextSessionId();
        const checkpoint = buildCompactionCheckpoint({
          cwd,
          sessionId,
          wing,
          defaultAgentName: resolved.defaultAgentName,
          now: deps.now?.(),
          eventStore: deps.getEventStore?.() ?? getContextEventStore(),
          maxChars: resolved.budgets.diaryChars,
        });
        const bridge = deps.createBridge
          ? deps.createBridge(resolved, cwd)
          : createMempalaceBridge({ cwd, config: resolved, runtime: bridgeRuntime });
        await bridge.execute({
          action: "add_drawer",
          wing: checkpoint.metadata.wing,
          room: checkpoint.metadata.room,
          content: checkpoint.content,
          added_by: checkpoint.metadata.added_by,
          source_file: checkpoint.metadata.source_file,
          timeout: hookTimeoutSeconds(resolved.timeouts.hookMs), /* seconds; bridge multiplies by 1000 */
        });
      } catch {
        // Compaction must never be cancelled by MemPalace checkpoint failures.
      }
      return undefined;
    });
  }

  if (config.mempalace.hooks.shutdownDiary) {
    platform.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
      try {
        const cwd = contextCwd(ctx);
        if (!isInstallReady(cwd)) return undefined;
        const resolved = resolveMempalaceConfig(config, cwd, platform.paths);
        let wing: string;
        try {
          wing = resolveDefaultWing(resolved, cwd, platform.paths);
        } catch {
          wing = "project";
        }
        const sessionId = deps.getSessionId?.() ?? getContextSessionId();
        const diary = buildShutdownDiary({
          cwd,
          sessionId,
          wing,
          defaultAgentName: resolved.defaultAgentName,
          now: deps.now?.(),
          eventStore: deps.getEventStore?.() ?? getContextEventStore(),
          maxChars: resolved.budgets.diaryChars,
        });
        const bridge = deps.createBridge
          ? deps.createBridge(resolved, cwd)
          : createMempalaceBridge({ cwd, config: resolved, runtime: bridgeRuntime });
        await bridge.execute({
          action: "diary_write",
          agent_name: diary.metadata.agent_name,
          wing: diary.metadata.wing,
          topic: diary.metadata.topic,
          entry: diary.entry,
          source_file: diary.metadata.source_file,
          timeout: hookTimeoutSeconds(resolved.timeouts.hookMs), /* seconds; bridge multiplies by 1000 */
        });
      } catch {
        // Shutdown must never be delayed or failed by MemPalace diary writes.
      }
      return undefined;
    });
  }

  platform.on("session_shutdown", clearForSession);
}
