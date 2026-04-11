import { Text } from "@oh-my-pi/pi-tui";
import type { PlatformUI } from "./types.js";
import {
  SPINNER_FRAMES,
  RESET, GREEN, RED, ORANGE, WHITE, YELLOW, DIM, TEXT_COLOR,
} from "./tui-colors.js";

export type WorkflowStepStatus = "pending" | "active" | "done" | "skipped" | "failed" | "blocked";

export interface WorkflowStepDefinition {
  key: string;
  label: string;
}

interface WorkflowStepState extends WorkflowStepDefinition {
  status: WorkflowStepStatus;
  detail?: string;
  hidden?: boolean;
}

export interface WorkflowProgressOptions {
  title: string;
  statusKey: string;
  statusLabel?: string;
  widgetKey?: string;
  clearStatusKeys?: string[];
  steps: WorkflowStepDefinition[];
}

function coloredIcon(status: WorkflowStepStatus, frame: number): string {
  switch (status) {
    case "done":
      return `${GREEN}✓${RESET}`;
    case "active":
      return `${ORANGE}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${RESET}`;
    case "failed":
      return `${RED}✕${RESET}`;
    case "blocked":
      return `${YELLOW}!${RESET}`;
    case "skipped":
      return `${DIM}–${RESET}`;
    default:
      return `${WHITE}○${RESET}`;
  }
}

/** Repeat a character `n` times. */
function repeat(ch: string, n: number): string {
  return n > 0 ? ch.repeat(n) : "";
}

export function createWorkflowProgress(ui: PlatformUI, options: WorkflowProgressOptions) {
  const widgetKey = options.widgetKey ?? options.statusKey;
  const statusLabel = options.statusLabel ?? options.title;
  const steps = options.steps.map<WorkflowStepState>((step) => ({ ...step, status: "pending" }));
  const stepsByKey = new Map(steps.map((step) => [step.key, step]));

  let frame = 0;
  let statusActive = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function visibleSteps(): WorkflowStepState[] {
    return steps.filter((step) => !step.hidden);
  }

  function renderWidgetText(): string {
    const visible = visibleSteps();

    // Build content lines — measure visible width (without ANSI codes)
    const contentEntries: { text: string; visibleLength: number }[] = [];
    for (const step of visible) {
      const detail = step.detail ? ` (${step.detail})` : "";
      // Icon is 1 visible char, then space + label + detail
      const visibleText = `${step.label}${detail}`;
      const line = `${coloredIcon(step.status, frame)} ${TEXT_COLOR}${visibleText}${RESET}`;
      // Visible width: icon(1) + space(1) + label + detail
      contentEntries.push({ text: line, visibleLength: 2 + visibleText.length });
    }

    const titleText = ` ${options.title} `;
    const maxContentWidth = contentEntries.reduce((max, entry) => Math.max(max, entry.visibleLength), 0);
    // Box inner width: at least wide enough for title or widest content + side padding
    const innerWidth = Math.max(titleText.length + 2, maxContentWidth + 2);

    const lines = [`${DIM}┌─${titleText}${repeat("─", innerWidth - titleText.length)}┐${RESET}`];
    for (const entry of contentEntries) {
      const padding = repeat(" ", innerWidth - entry.visibleLength);
      lines.push(`${DIM}│${RESET} ${entry.text}${padding}${DIM}│${RESET}`);
    }
    lines.push(`${DIM}└${repeat("─", innerWidth + 1)}┘${RESET}`);
    return lines.join("\n");
  }

  function refresh() {
    frame++;
    ui.setWidget?.(widgetKey, () => new Text(renderWidgetText(), 0, 0));
    if (statusActive) {
      ui.setStatus?.(options.statusKey, `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${statusLabel}`);
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
      statusActive = true;
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
    /** Hide a step from the widget entirely. */
    hide(stepKey: string) {
      const step = getStep(stepKey);
      if (step) {
        step.hidden = true;
        refresh();
      }
    },
    detail(text: string) {
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
