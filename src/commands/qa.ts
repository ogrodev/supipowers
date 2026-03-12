import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { detectAndCache } from "../qa/detector.js";
import { notifyInfo, notifyError } from "../notifications/renderer.js";
import { findActiveSession, findSessionWithFailures } from "../storage/qa-sessions.js";
import {
  createNewSession,
  advancePhase,
  getFailedTests,
  getNextPhase,
  getPhaseStatusLine,
} from "../qa/session.js";
import { buildDiscoveryPrompt } from "../qa/phases/discovery.js";
import { buildMatrixPrompt } from "../qa/phases/matrix.js";
import { buildExecutionPrompt } from "../qa/phases/execution.js";
import { buildReportingPrompt } from "../qa/phases/reporting.js";
import type { QaPhase, QaSessionLedger } from "../types.js";

const PHASE_LABELS: Record<QaPhase, string> = {
  discovery: "Discovery — Scan for test cases",
  matrix: "Matrix — Build traceability matrix",
  execution: "Execution — Run tests",
  reporting: "Reporting — Generate summary",
};

export function registerQaCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:qa", {
    description: "Run QA pipeline with session management (discovery → matrix → execution → reporting)",
    async handler(args, ctx) {
      const framework = detectAndCache(ctx.cwd);

      if (!framework) {
        notifyError(
          ctx,
          "No test framework detected",
          "Configure manually via /supi:config"
        );
        return;
      }

      // ── Step 1: Session selection ──────────────────────────────────
      let ledger: QaSessionLedger | null = null;

      const activeSession = findActiveSession(ctx.cwd);
      const failedSession = findSessionWithFailures(ctx.cwd);

      if (ctx.hasUI && !args?.trim()) {
        const sessionOptions: string[] = [];

        if (failedSession) {
          const failCount = failedSession.results.filter((r) => r.status === "fail").length;
          sessionOptions.push(`Resume ${failedSession.id} (${failCount} failed test${failCount !== 1 ? "s" : ""})`);
        } else if (activeSession) {
          const next = getNextPhase(activeSession);
          sessionOptions.push(`Resume ${activeSession.id} (${next ?? "all phases done"} pending)`);
        }

        sessionOptions.push("Start new session");

        if (sessionOptions.length > 1) {
          const choice = await ctx.ui.select(
            "QA Session",
            sessionOptions,
            { helpText: "Select session · Esc to cancel" },
          );
          if (!choice) return;

          if (choice.startsWith("Resume")) {
            ledger = failedSession ?? activeSession;
          }
        }
      }

      // Create new session if none selected
      if (!ledger) {
        ledger = createNewSession(ctx.cwd, framework.name);
        notifyInfo(ctx, "QA session created", ledger.id);
      }

      // ── Step 2: Phase selection ────────────────────────────────────
      type PhaseAction =
        | { type: "run-phase"; phase: QaPhase }
        | { type: "rerun-failed" };

      let action: PhaseAction | null = null;
      const nextPhase = getNextPhase(ledger);
      const failedTests = getFailedTests(ledger);

      if (ctx.hasUI && !args?.trim()) {
        const phaseOptions: string[] = [];

        // Offer re-run failed if there are failures
        if (failedTests.length > 0) {
          phaseOptions.push(`Re-run ${failedTests.length} failed test${failedTests.length !== 1 ? "s" : ""} only`);
        }

        // Offer starting from next pending phase
        if (nextPhase) {
          phaseOptions.push(PHASE_LABELS[nextPhase]);
        }

        if (phaseOptions.length > 1) {
          const statusLine = getPhaseStatusLine(ledger);
          const choice = await ctx.ui.select(
            `QA Phase · ${statusLine}`,
            phaseOptions,
            { helpText: "Select action · Esc to cancel" },
          );
          if (!choice) return;

          if (choice.startsWith("Re-run")) {
            action = { type: "rerun-failed" };
          } else {
            // Extract phase from label
            const selectedPhase = (Object.entries(PHASE_LABELS) as [QaPhase, string][])
              .find(([, label]) => label === choice)?.[0];
            if (selectedPhase) {
              action = { type: "run-phase", phase: selectedPhase };
            }
          }
        } else if (nextPhase) {
          // Only one option — just run the next phase
          action = { type: "run-phase", phase: nextPhase };
        }
      } else if (nextPhase) {
        action = { type: "run-phase", phase: nextPhase };
      }

      if (!action) {
        notifyInfo(ctx, "QA pipeline complete", getPhaseStatusLine(ledger));
        return;
      }

      // ── Step 3: Execute ────────────────────────────────────────────
      let prompt: string;

      if (action.type === "rerun-failed") {
        ledger = advancePhase(ctx.cwd, ledger, "execution", "running");
        prompt = buildExecutionPrompt(ledger, { failedOnly: true, failedTests });
        notifyInfo(ctx, "QA re-running failed tests", `${failedTests.length} test(s)`);
      } else {
        const phase = action.phase;
        ledger = advancePhase(ctx.cwd, ledger, phase, "running");

        switch (phase) {
          case "discovery":
            prompt = buildDiscoveryPrompt(framework, ctx.cwd);
            break;
          case "matrix":
            prompt = buildMatrixPrompt(ledger);
            break;
          case "execution":
            prompt = buildExecutionPrompt(ledger);
            break;
          case "reporting":
            prompt = buildReportingPrompt(ledger);
            break;
        }

        notifyInfo(ctx, `QA phase: ${phase}`, `session: ${ledger.id}`);
      }

      // Include session context for the sub-agent
      const sessionContext = [
        `\n\n## QA Session Context`,
        ``,
        `Session ID: ${ledger.id}`,
        `Session ledger path: .omp/supipowers/qa-sessions/${ledger.id}/ledger.json`,
        ``,
        `Current ledger state:`,
        "```json",
        JSON.stringify(ledger, null, 2),
        "```",
      ].join("\n");

      pi.sendMessage(
        {
          customType: "supi-qa",
          content: [{ type: "text", text: prompt + sessionContext }],
          display: "none",
        },
        { deliverAs: "steer" }
      );
    },
  });
}
