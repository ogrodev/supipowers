// src/orchestrator/run-progress.ts
import type { TaskStatus } from "./agent-grid.js";

export interface TaskProgress {
  taskId: number;
  name: string;
  status: TaskStatus;
  currentActivity: string;
  toolCount: number;
  filesChanged: number;
  startedAt: number;
  completedAt?: number;
  errorReason?: string;
  concerns?: string;
  dependsOn: number[];
}

/** Shared state store for a single run — written by dispatcher, read by renderer */
export class RunProgressState {
  readonly tasks = new Map<number, TaskProgress>();
  #batchLabel = "";
  onChange?: () => void;

  get batchLabel(): string { return this.#batchLabel; }
  set batchLabel(value: string) {
    this.#batchLabel = value;
    this.onChange?.();
  }

  // Abort support — wired to ESC in the progress renderer
  readonly #controller = new AbortController();
  get signal(): AbortSignal { return this.#controller.signal; }
  get aborted(): boolean { return this.#controller.signal.aborted; }
  abort(): void { this.#controller.abort(); }
  addTask(taskId: number, name: string, dependsOn: number[] = []): void {
    this.tasks.set(taskId, {
      taskId,
      name,
      status: "pending",
      currentActivity: "",
      toolCount: 0,
      filesChanged: 0,
      startedAt: Date.now(),
      dependsOn,
    });
    this.onChange?.();
  }

  setStatus(taskId: number, status: TaskStatus, reason?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = status;
    if (status === "blocked") task.errorReason = reason;
    if (status === "done_with_concerns") task.concerns = reason;
    if (status === "done" || status === "done_with_concerns" || status === "blocked") {
      task.completedAt = Date.now();
    }
    this.onChange?.();
  }

  setActivity(taskId: number, activity: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.currentActivity = activity;
    this.onChange?.();
  }

  incrementTools(taskId: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.toolCount++;
    this.onChange?.();
  }

  incrementFiles(taskId: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.filesChanged++;
    this.onChange?.();
  }

  get summary() {
    const all = [...this.tasks.values()];
    return {
      total: all.length,
      done: all.filter((t) => t.status === "done" || t.status === "done_with_concerns").length,
      running: all.filter((t) => t.status === "running" || t.status === "reviewing").length,
      blocked: all.filter((t) => t.status === "blocked").length,
      pending: all.filter((t) => t.status === "pending").length,
    };
  }
}

/** Module-level store: runId → state. Renderer reads from here. */
export const activeRuns = new Map<string, RunProgressState>();
