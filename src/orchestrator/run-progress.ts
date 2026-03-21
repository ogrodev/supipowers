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
}

/** Shared state store for a single run — written by dispatcher, read by renderer */
export class RunProgressState {
  readonly tasks = new Map<number, TaskProgress>();
  batchLabel = "";

  addTask(taskId: number, name: string): void {
    this.tasks.set(taskId, {
      taskId,
      name,
      status: "pending",
      currentActivity: "",
      toolCount: 0,
      filesChanged: 0,
      startedAt: Date.now(),
    });
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
  }

  setActivity(taskId: number, activity: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.currentActivity = activity;
  }

  incrementTools(taskId: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.toolCount++;
  }

  incrementFiles(taskId: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.filesChanged++;
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
