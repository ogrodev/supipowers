import type { GateDefinition } from "../../types.js";
import type { TestSuiteGateConfig } from "../../types.js";
import { GATE_CONFIG_SCHEMAS } from "../registry.js";

export const testSuiteGate: GateDefinition<TestSuiteGateConfig> = {
  id: "test-suite",
  description: "Runs the project's configured test suite command.",
  configSchema: GATE_CONFIG_SCHEMAS["test-suite"],
  detect(projectFacts) {
    const testCommand = projectFacts.packageScripts.test?.trim();
    if (!testCommand) {
      return null;
    }

    return {
      suggestedConfig: {
        enabled: true,
        command: testCommand,
      },
      confidence: "high",
      reason: "Detected package.json test script.",
    };
  },
  async run(context, config) {
    const result = await context.execShell(config.command, {
      cwd: context.cwd,
      timeout: 120000,
    });

    if (result.code === 0) {
      return {
        gate: "test-suite",
        status: "passed",
        summary: "Test suite passed.",
        issues: [],
        metadata: {
          command: config.command,
          exitCode: result.code,
        },
      };
    }

    const detail = result.stderr.trim() || result.stdout.trim() || `Test suite command exited with code ${result.code}.`;
    return {
      gate: "test-suite",
      status: "failed",
      summary: "Test suite failed.",
      issues: [
        {
          severity: "error",
          message: "Test suite command failed.",
          detail,
        },
      ],
      metadata: {
        command: config.command,
        exitCode: result.code,
      },
    };
  },
};
