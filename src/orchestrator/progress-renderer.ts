// src/orchestrator/progress-renderer.ts
import type { TaskStatus } from "./agent-grid.js";
import { activeRuns, type TaskProgress } from "./run-progress.js";

// ── ANSI-aware width helpers ─────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible character count (ignoring ANSI escape sequences). */
function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/** Truncate a string with ANSI codes so its visible width ≤ max, appending '…' if cut. */
function truncateToWidth(s: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(s) <= max) return s;

  let vis = 0;
  let i = 0;
  const ellipsis = "…";
  const target = max - 1; // reserve 1 char for ellipsis

  while (i < s.length && vis < target) {
    // Skip ANSI sequences without counting them
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const end = s.indexOf("m", i);
      if (end !== -1) { i = end + 1; continue; }
    }
    vis++;
    i++;
  }

  // Grab any trailing ANSI reset sequences so colors don't leak
  let tail = "";
  let j = i;
  while (j < s.length && s[j] === "\x1b") {
    const end = s.indexOf("m", j);
    if (end === -1) break;
    tail += s.slice(j, end + 1);
    j = end + 1;
  }

  return s.slice(0, i) + tail + ellipsis;
}

// ── Types ──────────────────────────────────────────────────────────

interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  sep: { dot: string };
  tree: {
    branch: string;
    last: string;
    vertical: string;
    hook: string;
  };
}

interface Component {
  render(width: number): string[];
  invalidate(): void;
}

interface CustomMessage<T> {
  details: T;
}

interface RunProgressDetails {
  runId: string;
}

import type { Platform } from "../platform/types.js";

// ── Constants ──────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface StatusConfig {
  color: string;
  icon: (frame: number) => string;
}

const STATUS_CONFIG: Record<TaskStatus, StatusConfig> = {
  pending:            { color: "dim",     icon: () => "○" },
  running:            { color: "accent",  icon: (f) => SPINNER_FRAMES[f % SPINNER_FRAMES.length] },
  reviewing:          { color: "warning", icon: () => "◎" },
  done:               { color: "success", icon: () => "✓" },
  done_with_concerns: { color: "warning", icon: () => "⚠" },
  blocked:            { color: "error",   icon: () => "✗" },
};

// ── Helper: format elapsed time ────────────────────────────────────

function formatElapsed(startedAt: number, completedAt?: number): string {
  const ms = (completedAt ?? Date.now()) - startedAt;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

// ── Inline Progress Component ──────────────────────────────────────

class InlineProgressComponent implements Component {
  #runId: string;
  #theme: Theme;
  #spinnerFrame = 0;

  constructor(runId: string, theme: Theme) {
    this.#runId = runId;
    this.#theme = theme;
  }

  render(width: number): string[] {
    // Advance spinner on every render call (called each repaint)
    this.#spinnerFrame = (this.#spinnerFrame + 1) % SPINNER_FRAMES.length;

    const state = activeRuns.get(this.#runId);
    if (!state || state.tasks.size === 0) return [];

    const tasks = [...state.tasks.values()];
    const lines: string[] = [];
    const tree = this.#theme.tree;
    const sep = this.#theme.sep.dot;

    tasks.forEach((task, idx) => {
      const isLast = idx === tasks.length - 1;
      const prefix = isLast ? tree.last : tree.branch;
      const cfg = STATUS_CONFIG[task.status];
      const icon = this.#theme.fg(cfg.color, cfg.icon(this.#spinnerFrame));
      const taskLabel = this.#theme.fg(cfg.color, `T${task.taskId}`);
      const name = this.#theme.bold(task.name);

      const parts: string[] = [`${prefix} ${icon} ${taskLabel} ${sep} ${name}`];
      this.#appendTaskMeta(task, parts, sep);

      // Show dependencies for pending tasks
      if (task.status === "pending" && task.dependsOn.length > 0) {
        const depLabels = task.dependsOn.map((d) => `T${d}`).join(", ");
        parts.push(` ${sep} `);
        parts.push(this.#theme.fg("dim", `Depends on ${depLabels}`));
      }

      lines.push(width > 0 ? truncateToWidth(parts.join(""), width) : parts.join(""));
    });

    // Summary line
    const summary = state.summary;
    const summaryParts: string[] = [];
    if (state.batchLabel) summaryParts.push(this.#theme.fg("muted", state.batchLabel));
    if (summary.done > 0)    summaryParts.push(this.#theme.fg("success", `${summary.done} done`));
    if (summary.running > 0) summaryParts.push(this.#theme.fg("accent",  `${summary.running} running`));
    if (summary.pending > 0) summaryParts.push(this.#theme.fg("dim",     `${summary.pending} pending`));
    if (summary.blocked > 0) summaryParts.push(this.#theme.fg("error",   `${summary.blocked} blocked`));

    if (summaryParts.length > 0) {
      const indent = `  `; // align under tree
      const summaryLine = `${indent}${summaryParts.join(` ${sep} `)}`;
      lines.push(width > 0 ? truncateToWidth(summaryLine, width) : summaryLine);
    }

    return lines;
  }

  invalidate(): void {
    // No cache to bust — we render fresh each time
  }

  // ── Private ────────────────────────────────────────────────────

  #appendTaskMeta(task: TaskProgress, parts: string[], sep: string): void {
    const isActive = task.status === "running" || task.status === "reviewing";
    const isDone =
      task.status === "done" ||
      task.status === "done_with_concerns" ||
      task.status === "blocked";

    if (task.toolCount > 0) {
      parts.push(` ${sep} `);
      parts.push(this.#theme.fg("muted", `${task.toolCount} tools`));
    }

    if (isDone && task.filesChanged > 0) {
      parts.push(` ${sep} `);
      parts.push(this.#theme.fg("muted", `${task.filesChanged} files`));
    }

    if (isDone) {
      const elapsed = formatElapsed(task.startedAt, task.completedAt);
      parts.push(` ${sep} `);
      parts.push(this.#theme.fg("muted", elapsed));
    }

    if (isActive && task.currentActivity) {
      parts.push(` ${sep} `);
      parts.push(this.#theme.fg("dim", task.currentActivity));
    }
  }
}

// ── Registration ───────────────────────────────────────────────────

export function registerProgressRenderer(platform: Platform): void {
  platform.registerMessageRenderer<RunProgressDetails>(
    "supi-run-progress",
    (message: CustomMessage<RunProgressDetails>, _options: any, theme: Theme) => {
      const { runId } = message.details;
      if (!runId) return undefined;
      return new InlineProgressComponent(runId, theme);
    },
  );
}
