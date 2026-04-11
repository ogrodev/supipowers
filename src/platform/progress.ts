import type { PlatformUI } from "./types.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type WorkflowStepStatus = "pending" | "active" | "done" | "skipped" | "failed" | "blocked";

export interface WorkflowStepDefinition {
  key: string;
  label: string;
}

interface WorkflowStepState extends WorkflowStepDefinition {
  status: WorkflowStepStatus;
  detail?: string;
}

export interface WorkflowProgressOptions {
  title: string;
  statusKey: string;
  widgetKey?: string;
  clearStatusKeys?: string[];
  steps: WorkflowStepDefinition[];
}

function iconForStatus(status: WorkflowStepStatus, frame: number): string {
  switch (status) {
    case "done":
      return "✓";
    case "active":
      return SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    case "skipped":
      return "–";
    case "failed":
      return "✕";
    case "blocked":
      return "!";
    default:
      return "○";
  }
}

export function createWorkflowProgress(ui: PlatformUI, options: WorkflowProgressOptions) {
  const widgetKey = options.widgetKey ?? options.statusKey;
  const steps = options.steps.map<WorkflowStepState>((step) => ({ ...step, status: "pending" }));
  const stepsByKey = new Map(steps.map((step) => [step.key, step]));

  let frame = 0;
  let statusDetail = "";
  let timer: ReturnType<typeof setInterval> | null = null;

  function renderWidget(): string[] {
    const lines = [`┌─ ${options.title} ─────────────────────┐`];
    for (const step of steps) {
      const detail = step.detail ? ` (${step.detail})` : "";
      lines.push(`│ ${iconForStatus(step.status, frame)} ${step.label}${detail}`);
    }
    lines.push("└───────────────────────────────────┘");
    return lines;
  }

  function refresh() {
    frame++;
    ui.setWidget?.(widgetKey, renderWidget());
    if (statusDetail) {
      ui.setStatus?.(options.statusKey, `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${statusDetail}`);
    }
  }

  function startTimer() {
    if (!timer) {
      timer = setInterval(refresh, 80);
    }
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStep(stepKey: string): WorkflowStepState | undefined {
    return stepsByKey.get(stepKey);
  }

  function setStatus(stepKey: string, status: WorkflowStepStatus, detail?: string) {
    const step = getStep(stepKey);
    if (!step) {
      return;
    }

    step.status = status;
    if (detail !== undefined) {
      step.detail = detail;
    }

    if (status === "active") {
      statusDetail = detail ?? step.label;
      startTimer();
    }

    refresh();
  }

  return {
    getStatus(stepKey: string): WorkflowStepStatus | null {
      return getStep(stepKey)?.status ?? null;
    },
    activate(stepKey: string, detail?: string) {
      setStatus(stepKey, "active", detail);
    },
    complete(stepKey: string, detail?: string) {
      setStatus(stepKey, "done", detail);
    },
    skip(stepKey: string, detail?: string) {
      setStatus(stepKey, "skipped", detail);
    },
    fail(stepKey: string, detail?: string) {
      setStatus(stepKey, "failed", detail);
    },
    block(stepKey: string, detail?: string) {
      setStatus(stepKey, "blocked", detail);
    },
    detail(text: string) {
      statusDetail = text;
      const activeStep = steps.find((step) => step.status === "active");
      if (activeStep) {
        activeStep.detail = text;
      }
      refresh();
    },
    dispose() {
      stopTimer();
      ui.setStatus?.(options.statusKey, undefined);
      for (const key of options.clearStatusKeys ?? []) {
        ui.setStatus?.(key, undefined);
      }
      ui.setWidget?.(widgetKey, undefined);
    },
  };

}