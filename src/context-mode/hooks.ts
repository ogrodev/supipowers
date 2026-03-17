// src/context-mode/hooks.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { SupipowersConfig } from "../types.js";
import { compressToolResult } from "./compressor.js";
import { detectContextMode, type ContextModeStatus } from "./detector.js";
import { EventStore } from "./event-store.js";
import { extractEvents, extractPromptEvents } from "./event-extractor.js";
import { buildResumeSnapshot } from "./snapshot-builder.js";
import { routeToolCall } from "./routing.js";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Register context-mode hooks on the extension API */
export function registerContextModeHooks(pi: ExtensionAPI, config: SupipowersConfig): void {
  if (!config.contextMode.enabled) return;

  // Phase 2: Event store initialization
  let eventStore: EventStore | null = null;
  let sessionId = `session-${Date.now()}`;

  if (config.contextMode.eventTracking) {
    try {
      const dbDir = join(process.cwd(), ".omp", "supipowers", "sessions");
      mkdirSync(dbDir, { recursive: true });
      eventStore = new EventStore(join(dbDir, "events.db"));
      eventStore.init();
    } catch (e) {
      (pi as any).logger?.error?.("context-mode: failed to initialize event store", e);
    }
  }

  // Update module-level refs for compaction hooks
  _eventStoreRef = eventStore;
  _sessionIdRef = sessionId;

  // Phase 1: Result compression + Phase 2: Event extraction
  pi.on("tool_result", (event) => {
    // Phase 1: compression
    const compressed = compressToolResult(event, config.contextMode.compressionThreshold);

    // Phase 2: event extraction (fire-and-forget)
    if (eventStore && config.contextMode.eventTracking) {
      try {
        const events = extractEvents(event, sessionId);
        if (events.length > 0) eventStore.writeEvents(events);
      } catch (e) {
        (pi as any).logger?.warn?.("context-mode: event extraction failed", e);
      }
    }

    return compressed;
  });

  // Phase 1: Tool routing — block native tools and redirect to ctx_* equivalents
  pi.on("tool_call", (event) => {
    // Always re-detect: MCP tools may load after extension init
    const status = detectContextMode(pi.getActiveTools());
    cachedStatus = status;

    return routeToolCall(event.toolName, event.input as any, status, {
      enforceRouting: config.contextMode.enforceRouting,
      blockHttpCommands: config.contextMode.blockHttpCommands,
    });
  });

  // Phase 1: Routing instructions + Phase 2: Prompt event extraction
  pi.on("before_agent_start", (event) => {
    // Phase 2: prompt event extraction (fire-and-forget)
    if (eventStore && config.contextMode.eventTracking) {
      try {
        const prompt = (event as any).prompt as string | undefined;
        if (prompt) {
          const events = extractPromptEvents(prompt, sessionId);
          if (events.length > 0) eventStore.writeEvents(events);
        }
      } catch (e) {
        (pi as any).logger?.warn?.("context-mode: prompt event extraction failed", e);
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
  if (config.contextMode.compaction && eventStore) {
    let pendingSnapshot: string | null = null;

    pi.on("session_before_compact", () => {
      try {
        pendingSnapshot = buildResumeSnapshot(eventStore!, sessionId);
      } catch (e) {
        (pi as any).logger?.warn?.("context-mode: snapshot build failed", e);
        pendingSnapshot = null;
      }
      return undefined; // don't cancel or replace compaction
    });

    pi.on("session.compacting", () => {
      if (!pendingSnapshot) return undefined;
      const snapshot = pendingSnapshot;
      pendingSnapshot = null;
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
