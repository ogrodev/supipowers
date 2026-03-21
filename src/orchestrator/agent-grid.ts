/**
 * Agent Grid Widget — TUI component for live sub-agent progress visualization.
 *
 * Renders task cards in a flexbox-like grid that reflows based on terminal width.
 * Each card shows: status icon, task name, current thinking, tool activity log,
 * files changed count, and elapsed time.
 *
 * Cards collapse when done/blocked to make room for active cards.
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MIN_CARD_WIDTH = 38;
const MAX_ACTIVITY_LOG = 4;
const ANIMATION_INTERVAL_MS = 200;

// ── Types ──────────────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "running"
  | "reviewing"
  | "done"
  | "done_with_concerns"
  | "blocked";

export interface TaskCardState {
  taskId: number;
  name: string;
  status: TaskStatus;
  currentThinking: string;
  activityLog: string[];
  filesChanged: number;
  toolCount: number;
  startedAt: number;
  completedAt?: number;
  errorReason?: string;
  concerns?: string;
}

/** Minimal TUI interface — matches what setWidget factory receives */
interface TUI {
  requestRender(): void;
}

/** Minimal Theme interface — matches OMP's Theme class */
interface Theme {
  fg(color: string, text: string): string;
  symbol(key: string): string;
}

/** Component interface as defined by @oh-my-pi/pi-tui */
interface Component {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

// ── Status Config ──────────────────────────────────────────────────

interface StatusConfig {
  color: string;
  icon: string;
}

const STATUS_CONFIG: Record<TaskStatus, StatusConfig> = {
  pending:            { color: "dim",     icon: "○" },
  running:            { color: "accent",  icon: "●" },
  reviewing:          { color: "warning", icon: "◎" },
  done:               { color: "success", icon: "✓" },
  done_with_concerns: { color: "warning", icon: "⚠" },
  blocked:            { color: "error",   icon: "✗" },
};

// ── AgentGridWidget ────────────────────────────────────────────────

export class AgentGridWidget implements Component {
  #tasks = new Map<number, TaskCardState>();
  #tui: TUI;
  #theme: Theme;
  #spinnerFrame = 0;
  #intervalId: ReturnType<typeof setInterval> | null = null;
  #cachedLines: string[] | undefined;
  #cachedWidth: number | undefined;

  constructor(tui: TUI, theme: Theme) {
    this.#tui = tui;
    this.#theme = theme;

    // Animate spinner + elapsed time
    this.#intervalId = setInterval(() => {
      this.#spinnerFrame = (this.#spinnerFrame + 1) % SPINNER_FRAMES.length;
      // Only re-render if we have active tasks
      const hasActive = [...this.#tasks.values()].some(
        (t) => t.status === "running" || t.status === "reviewing",
      );
      if (hasActive) {
        this.invalidate();
        this.#tui.requestRender();
      }
    }, ANIMATION_INTERVAL_MS);
  }

  // ── Public API (called by dispatcher) ──────────────────────────

  /** Initialize a task card */
  addTask(taskId: number, name: string): void {
    this.#tasks.set(taskId, {
      taskId,
      name,
      status: "pending",
      currentThinking: "",
      activityLog: [],
      filesChanged: 0,
      toolCount: 0,
      startedAt: Date.now(),
    });
    this.#invalidateAndRender();
  }

  /** Update task status */
  setStatus(taskId: number, status: TaskStatus, reason?: string): void {
    const task = this.#tasks.get(taskId);
    if (!task) return;
    task.status = status;
    if (status === "blocked") task.errorReason = reason;
    if (status === "done_with_concerns") task.concerns = reason;
    if (status === "done" || status === "done_with_concerns" || status === "blocked") {
      task.completedAt = Date.now();
    }
    this.#invalidateAndRender();
  }

  /** Update thinking preview */
  setThinking(taskId: number, text: string): void {
    const task = this.#tasks.get(taskId);
    if (!task) return;
    task.currentThinking = text;
    this.#invalidateAndRender();
  }

  /** Add a tool call to the activity log */
  addActivity(taskId: number, description: string): void {
    const task = this.#tasks.get(taskId);
    if (!task) return;
    task.toolCount++;
    task.activityLog.push(description);
    if (task.activityLog.length > MAX_ACTIVITY_LOG) {
      task.activityLog.shift();
    }
    this.#invalidateAndRender();
  }

  /** Increment files changed count */
  addFileChanged(taskId: number): void {
    const task = this.#tasks.get(taskId);
    if (!task) return;
    task.filesChanged++;
    this.#invalidateAndRender();
  }

  // ── Component Interface ────────────────────────────────────────

  render(width: number): string[] {
    if (this.#cachedLines && this.#cachedWidth === width) return this.#cachedLines;
    if (this.#tasks.size === 0) return [];

    const tasks = [...this.#tasks.values()];
    const cardWidth = this.#computeCardWidth(width);
    const cardsPerRow = Math.max(1, Math.floor(width / cardWidth));

    const lines: string[] = [];

    // Render in rows
    for (let i = 0; i < tasks.length; i += cardsPerRow) {
      const rowTasks = tasks.slice(i, i + cardsPerRow);
      const rowCards = rowTasks.map((t) => this.#renderCard(t, cardWidth));
      const merged = this.#mergeCardRows(rowCards, cardWidth, width);
      lines.push(...merged);
    }

    this.#cachedLines = lines;
    this.#cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.#cachedLines = undefined;
    this.#cachedWidth = undefined;
  }

  dispose(): void {
    if (this.#intervalId) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
  }

  // ── Private Rendering ──────────────────────────────────────────

  /** Box drawing chars shorthand */
  get #box() {
    return {
      tl: this.#theme.symbol("boxRound.topLeft"),
      tr: this.#theme.symbol("boxRound.topRight"),
      bl: this.#theme.symbol("boxRound.bottomLeft"),
      br: this.#theme.symbol("boxRound.bottomRight"),
      h: this.#theme.symbol("boxRound.horizontal"),
      v: this.#theme.symbol("boxRound.vertical"),
    };
  }

  #invalidateAndRender(): void {
    this.invalidate();
    this.#tui.requestRender();
  }

  #computeCardWidth(termWidth: number): number {
    if (termWidth < MIN_CARD_WIDTH) return termWidth; // terminal too narrow, use full width
    const maxWidth = Math.floor(termWidth / 2);
    const cardsPerRow = Math.max(1, Math.floor(termWidth / MIN_CARD_WIDTH));
    const computed = Math.floor(termWidth / cardsPerRow);
    return Math.max(MIN_CARD_WIDTH, Math.min(computed, maxWidth));
  }

  #renderCard(task: TaskCardState, width: number): string[] {
    const isCollapsed =
      task.status === "done" ||
      task.status === "done_with_concerns" ||
      task.status === "blocked" ||
      task.status === "pending";

    if (isCollapsed) {
      return this.#renderCollapsedCard(task, width);
    }
    return this.#renderActiveCard(task, width);
  }

  #renderCollapsedCard(task: TaskCardState, width: number): string[] {
    const { color, icon } = STATUS_CONFIG[task.status];
    const box = this.#box;
    const inner = width - 4; // 2 border + 2 padding

    if (task.status === "pending") {
      const title = this.#truncate(`${icon} Task ${task.taskId}: ${task.name}`, inner);
      return [
        this.#theme.fg(color, `${box.tl}${box.h} ${title} ${this.#pad(box.h, inner - title.length - 1)}${box.tr}`),
        this.#theme.fg(color, `${box.bl}${this.#pad(box.h, width - 2)}${box.br}`),
      ];
    }

    // Done / blocked / concerns
    let suffix = "";
    if (task.status === "done" || task.status === "done_with_concerns") {
      const elapsed = this.#formatElapsed(task);
      suffix = `${task.filesChanged} files, ${elapsed}`;
    } else if (task.status === "blocked") {
      suffix = "BLOCKED";
    }

    const title = this.#truncate(`${icon} Task ${task.taskId}: ${task.name}`, inner - suffix.length - 4);
    const headerContent = `${title} ── ${suffix}`;
    const headerPad = Math.max(0, inner - this.#visibleLength(headerContent) - 1);

    const lines = [
      this.#theme.fg(color, `${box.tl}${box.h} ${headerContent}${this.#pad(box.h, headerPad)} ${box.tr}`),
    ];

    // Show error reason for blocked, concerns for done_with_concerns
    const detail = task.status === "blocked" ? task.errorReason : task.concerns;
    if (detail) {
      const detailText = this.#truncate(`  ${detail}`, inner);
      lines.push(
        this.#theme.fg(color, box.v) +
        ` ${detailText}${" ".repeat(Math.max(0, inner - this.#visibleLength(detailText)))} ` +
        this.#theme.fg(color, box.v),
      );
    }

    lines.push(
      this.#theme.fg(color, `${box.bl}${this.#pad(box.h, width - 2)}${box.br}`),
    );
    return lines;
  }

  #renderActiveCard(task: TaskCardState, width: number): string[] {
    const { color, icon } = STATUS_CONFIG[task.status];
    const box = this.#box;
    const inner = width - 4; // 2 border + 2 padding
    const spinner = SPINNER_FRAMES[this.#spinnerFrame];

    const lines: string[] = [];

    // ── Header
    const title = this.#truncate(`${icon} Task ${task.taskId}: ${task.name}`, inner);
    lines.push(
      this.#theme.fg(color, `${box.tl}${box.h} ${title} ${this.#pad(box.h, inner - this.#visibleLength(title) - 1)}${box.tr}`),
    );

    // ── Sticky thinking line
    const thinkingText = task.currentThinking
      ? this.#truncate(`${spinner} ${task.currentThinking}`, inner)
      : `${spinner} Working...`;
    lines.push(this.#line(
      this.#theme.fg("dim", thinkingText),
      inner,
      color,
    ));

    // ── Separator
    const sep = this.#pad("─", inner);
    lines.push(this.#line(this.#theme.fg("dim", sep), inner, color));

    // ── Activity log (pad to MAX_ACTIVITY_LOG lines)
    const logLines = task.activityLog.slice(-MAX_ACTIVITY_LOG);
    for (let i = 0; i < MAX_ACTIVITY_LOG; i++) {
      const entry = logLines[i];
      if (entry) {
        const text = this.#truncate(` ${entry}`, inner);
        // Tool entries start with action verbs (Reading, Editing, Running, etc.)
        // Thinking entries are plain text from the agent
        const isToolAction = /^ (?:Reading|Editing|Writing|Running|Searching|Finding|Spawning|Glob|Grep|Bash|Edit|Read|Write)/.test(entry);
        const styled = isToolAction ? text : this.#theme.fg("dim", text);
        lines.push(this.#line(styled, inner, color));
      } else {
        lines.push(this.#line("", inner, color));
      }
    }

    // ── Empty line
    lines.push(this.#line("", inner, color));

    // ── Footer
    const filesLabel = `${task.filesChanged} file${task.filesChanged !== 1 ? "s" : ""}`;
    const elapsed = `⏱ ${this.#formatElapsed(task)}`;
    const gap = Math.max(1, inner - this.#visibleLength(filesLabel) - this.#visibleLength(elapsed));
    const footerContent = `${filesLabel}${" ".repeat(gap)}${elapsed}`;
    lines.push(this.#line(this.#theme.fg("dim", footerContent), inner, color));

    // ── Bottom border
    lines.push(
      this.#theme.fg(color, `${box.bl}${this.#pad(box.h, width - 2)}${box.br}`),
    );

    return lines;
  }

  /** Render a content line with colored side borders */
  #line(content: string, inner: number, borderColor: string): string {
    const box = this.#box;
    const contentLen = this.#visibleLength(content);
    const pad = Math.max(0, inner - contentLen);
    return (
      this.#theme.fg(borderColor, box.v) +
      ` ${content}${" ".repeat(pad)} ` +
      this.#theme.fg(borderColor, box.v)
    );
  }

  /** Merge multiple card columns into rows of lines */
  #mergeCardRows(cards: string[][], cardWidth: number, termWidth: number): string[] {
    const maxHeight = Math.max(...cards.map((c) => c.length));
    const gap = 1; // space between cards
    const merged: string[] = [];

    for (let row = 0; row < maxHeight; row++) {
      let line = "";
      for (let col = 0; col < cards.length; col++) {
        if (col > 0) line += " ".repeat(gap);
        const cardLine = cards[col][row] ?? " ".repeat(cardWidth);
        line += cardLine;
      }
      merged.push(line);
    }
    return merged;
  }

  // ── Utilities ──────────────────────────────────────────────────

  #truncate(text: string, maxLen: number): string {
    if (this.#visibleLength(text) <= maxLen) return text;
    // Walk through the string, counting only visible chars, preserving ANSI sequences
    const ansiRegex = /\x1b\[[0-9;]*m/g;
    let result = "";
    let visible = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ansiRegex.exec(text)) !== null) {
      // Add visible chars before this ANSI sequence
      const before = text.slice(lastIndex, match.index);
      const remaining = maxLen - 1 - visible;
      if (before.length > remaining) {
        result += before.slice(0, remaining) + "…";
        return result + "\x1b[0m"; // reset styling
      }
      result += before;
      visible += before.length;
      result += match[0]; // preserve ANSI sequence
      lastIndex = match.index + match[0].length;
    }
    // Handle remaining text after last ANSI sequence
    const tail = text.slice(lastIndex);
    const remaining = maxLen - 1 - visible;
    if (tail.length > remaining) {
      result += tail.slice(0, remaining) + "…";
      return result + "\x1b[0m";
    }
    result += tail;
    return result;
  }

  #visibleLength(text: string): number {
    return text.replace(/\x1b\[[0-9;]*m/g, "").length;
  }

  #pad(char: string, count: number): string {
    return char.repeat(Math.max(0, count));
  }

  #formatElapsed(task: TaskCardState): string {
    const end = task.completedAt ?? Date.now();
    const sec = Math.floor((end - task.startedAt) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    return `${min}m ${sec % 60}s`;
  }
}

