// src/context-mode/hooks.ts
import type { Platform } from "../platform/types.js";
import type { SupipowersConfig } from "../types.js";
import { compressToolResult } from "./compressor.js";
import { detectContextMode, type ContextModeStatus } from "./detector.js";
import { EventStore } from "./event-store.js";
import { extractEvents, extractPromptEvents } from "./event-extractor.js";
import { buildResumeSnapshot } from "./snapshot-builder.js";
import { routeToolCall } from "./routing.js";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type SessionContextLike = {
  cwd?: string;
  sessionManager?: { getSessionFile?: () => string } | null;
};

// Cached detection result
let cachedStatus: ContextModeStatus | null = null;

function loadRoutingSkill(): string | null {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const skillPath = join(__dirname, "..", "..", "skills", "context-mode", "SKILL.md");
    return readFileSync(skillPath, "utf-8");
  } catch {
    return null;
  }
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

function getSessionDbPath(platform: Platform, cwd: string): string {
  return join(platform.paths.project(cwd, "sessions"), "events.db");
}

/** Register supi-context-mode hooks on the platform */
export function registerContextModeHooks(platform: Platform, config: SupipowersConfig): void {
  if (!config.contextMode.enabled) return;

  let eventStore: EventStore | null = null;
  let eventStorePath: string | null = null;
  let sessionCwd = process.cwd();
  let sessionId = deriveSessionId();

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
      mkdirSync(platform.paths.project(cwd, "sessions"), { recursive: true });
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

  ensureEventStore(sessionCwd);

  _sessionIdRef = sessionId;

  platform.on("session_start", (_event, ctx) => {
    sessionCwd = resolveSessionCwd(ctx as SessionContextLike | undefined);
    sessionId = deriveSessionId(ctx as SessionContextLike | undefined);
    _sessionIdRef = sessionId;

    const store = ensureEventStore(sessionCwd);
    if (!store) return;

    try {
      store.upsertMeta(sessionId, sessionCwd);
    } catch (e) {
      (platform as any).logger?.warn?.("supi-context-mode: failed to initialize session metadata", e);
    }
  });

  platform.on("session_shutdown", () => {
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
    // Phase 1: compression
    const compressed = compressToolResult(event, config.contextMode.compressionThreshold);

    // Phase 2: event extraction (fire-and-forget)
    if (eventStore && config.contextMode.eventTracking) {
      try {
        const events = extractEvents(event, sessionId);
        if (events.length > 0) eventStore.writeEvents(events);
      } catch (e) {
        (platform as any).logger?.warn?.("supi-context-mode: event extraction failed", e);
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
  platform.on("before_agent_start", (event) => {
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

    // Phase 1: routing instructions — always inject when enforceRouting is on,
    // regardless of MCP tool detection (tools may load after this hook fires)
    if (!config.contextMode.routingInstructions && !config.contextMode.enforceRouting) return;

    const skill = loadRoutingSkill();
    if (!skill) return;

    const systemPrompt = (event as any).systemPrompt as string | undefined;
    if (!systemPrompt) return { systemPrompt: skill };
    return { systemPrompt: systemPrompt + "\n\n" + skill };
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

    platform.on("session_before_compact", () => {
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

      try {
        const snapshot = buildResumeSnapshot(eventStore!, sessionId, {
          compactCount,
          searchTool,
          searchAvailable,
        });

        // Persist to DB so it survives crashes
        if (snapshot) {
          const eventCount = Object.values(eventStore!.getEventCounts(sessionId))
            .reduce((a, b) => a + b, 0);
          eventStore!.upsertResume(sessionId, snapshot, eventCount);
        }

        return undefined; // don't cancel or replace compaction
      } catch (e) {
        (platform as any).logger?.warn?.("context-mode: snapshot build failed", e);
        return undefined;
      }
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

/** Get the session ID (for use by compaction hooks) */
export function getSessionId(): string {
  return _sessionIdRef;
}

// Module-level refs updated by registerContextModeHooks
let _eventStoreRef: EventStore | null = null;
let _sessionIdRef = "";

/** Reset cached state (for testing) */
export function _resetCache(): void {
  cachedStatus = null;
  _eventStoreRef = null;
  _sessionIdRef = "";
}