import type { Platform } from "../platform/types.js";
import { normalizeSystemPromptBlocks } from "../platform/system-prompt.js";
import type { SupipowersConfig } from "../types.js";
import { createMempalaceBridge, type MempalaceBridgeFacade } from "./bridge.js";
import { resolveDefaultWing, resolveMempalaceConfig, type ResolvedMempalaceConfig } from "./config.js";
import { resolveInstalledBridgeScriptPath } from "./runtime.js";
import { getEventStore as getContextEventStore, getSessionId as getContextSessionId } from "../context-mode/hooks.js";
import { buildCompactionCheckpoint, buildShutdownDiary } from "./session-summary.js";

export interface MempalaceHooksDeps {
  createBridge?: (config: ResolvedMempalaceConfig, cwd: string) => MempalaceBridgeFacade;
  getEventStore?: () => Parameters<typeof buildCompactionCheckpoint>[0]["eventStore"];
  getSessionId?: () => string;
  now?: () => string;
}

const wakeUpCache = new Map<string, string>();

/**
 * Per-session turn counter for wake-up cadence gating. The full wake-up block
 * is injected on turn 1 and every Nth turn thereafter (where N is
 * `mempalace.budgets.wakeUpInjectionEvery`); other turns get a one-line
 * refresher. Cleared on session_start / session_switch.
 */
const turnCounters = new Map<string, number>();

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

function wakeUpBlock(resolved: ResolvedMempalaceConfig, wing: string, text: string): string {
  const excerpt = truncateByTokenBudget(text, resolved.budgets.wakeUpTokens);
  const lines = [
    "# MemPalace memory",
    `- palace: ${resolved.palacePath}`,
    `- default wing: ${wing}`,
  ];
  if (resolved.hooks.searchGuidance) {
    lines.push(
      "- You **MUST** call `mempalace(action=\"search\", query=...)` before answering questions about prior decisions, people, projects, or past events. Skip only when the answer is fully derivable from the current turn or the active codebase.",
    );
  }
  if (excerpt.trim()) {
    lines.push("", "## Wake-up excerpt", excerpt.trim());
  }
  return lines.join("\n");
}

/**
 * Compact one-line refresher injected on turns where we skip the full
 * wake-up dump. Keeps the model oriented (palace/wing) and re-asserts the
 * RFC-2119 search nudge in ~140 chars instead of ~870 tokens.
 */
function wakeUpRefresher(resolved: ResolvedMempalaceConfig, wing: string): string {
  const lines = [
    `# MemPalace memory: wing=${wing}`,
  ];
  if (resolved.hooks.searchGuidance) {
    lines.push(
      "- You **MUST** call `mempalace(action=\"search\", query=...)` before answering past-fact questions; per-turn search results appear below when relevant.",
    );
  }
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

/** Cap on the search query length. Long prompts are truncated to the first N chars. */
const AUTO_SEARCH_QUERY_MAX_CHARS = 500;

/**
 * Returns `true` when `prompt` is a trivial acknowledgement that does not warrant
 * a memory search (saves the bridge round-trip for "yes", "ok", "thanks", etc.).
 */
function isTrivialPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  if (normalized.length < AUTO_SEARCH_MIN_PROMPT_CHARS) return true;
  // Conservative wordlist: only strip obvious filler.
  const TRIVIAL = new Set(["yes", "no", "ok", "okay", "thanks", "thank you", "great", "cool", "go", "continue", "proceed"]);
  return TRIVIAL.has(normalized);
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
function isRelevantHit(hit: SearchHit): boolean {
  const sim = typeof hit.similarity === "number" ? hit.similarity : null;
  const bm25 = typeof hit.bm25_score === "number" ? hit.bm25_score : null;
  // Either signal must clear a low bar. Mempalace's `similarity` is ~1.0 for
  // perfect, ~0.5 for "kinda related"; bm25 is unbounded but >0.3 is meaningful.
  if (sim !== null && sim >= 0.55) return true;
  if (bm25 !== null && bm25 >= 0.3) return true;
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
  const bridgeRuntime = {
    resolveBridgeScriptPath: () => resolveInstalledBridgeScriptPath(platform.paths),
  };


  const clearAll = () => {
    wakeUpCache.clear();
    turnCounters.clear();
  };
  platform.on("session_start", clearAll);
  platform.on("session_switch", clearAll);

  platform.on("before_agent_start", async (event: unknown, ctx: unknown) => {
    const wakeUpEnabled = config.mempalace.hooks.wakeUp;
    const guidanceEnabled = config.mempalace.hooks.searchGuidance;
    const autoSearchEnabled = config.mempalace.hooks.autoSearchOnPrompt;
    if (!wakeUpEnabled && !guidanceEnabled && !autoSearchEnabled) return undefined;

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

    // Run the cached generic wake_up and the per-prompt search in parallel.
    // wake_up is cached for the session; auto-search is fresh every turn.
    const wakePromise = (async (): Promise<string> => {
      if (!isFullInjectionTurn) return wakeUpRefresher(resolved, wing);
      const cached = wakeUpCache.get(cacheKey);
      if (cached) return cached;
      const wake = await bridge.execute({ action: "wake_up", wing, timeout: resolved.timeouts.hookMs });
      const block = wake.ok
        ? wakeUpBlock(resolved, wing, wakeText(wake.result))
        : setupGuidanceBlock(resolved, wing);
      wakeUpCache.set(cacheKey, block);
      return block;
    })();

    const searchPromise = (async (): Promise<string | null> => {
      if (!autoSearchEnabled) return null;
      if (!userPrompt || isTrivialPrompt(userPrompt)) return null;
      const query = userPrompt.slice(0, AUTO_SEARCH_QUERY_MAX_CHARS);
      try {
        const result = await bridge.execute({
          action: "search",
          query,
          wing,
          limit: 3,
          timeout: resolved.timeouts.hookMs,
        });
        if (!result.ok) return null;
        const hits = pickHits(result.result).filter(isRelevantHit);
        return autoSearchBlock(hits, resolved.budgets.autoSearchTokens);
      } catch {
        // Auto-search is best-effort. A failure here must never block the turn.
        return null;
      }
    })();

    const [wakeBlock, searchBlock] = await Promise.all([wakePromise, searchPromise]);
    const combined = searchBlock ? `${wakeBlock}\n${searchBlock}` : wakeBlock;
    return appendPrompt(basePrompt, combined);
  });

  if (config.mempalace.hooks.compactionCheckpoint) {
    platform.on("session_before_compact", async (_event: unknown, ctx: unknown) => {
      try {
        const cwd = contextCwd(ctx);
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
          timeout: resolved.timeouts.hookMs,
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
          timeout: resolved.timeouts.hookMs,
        });
      } catch {
        // Shutdown must never be delayed or failed by MemPalace diary writes.
      }
      return undefined;
    });
  }
}
