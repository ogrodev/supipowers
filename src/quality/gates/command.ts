import type {
  CommandGateConfig,
  CommandGateId,
  GateDefinition,
  GateIssue,
  ProjectFacts,
} from "../../types.js";
import { GATE_CONFIG_SCHEMAS } from "../registry.js";

interface DetectedCommand {
  command: string;
  confidence: "high" | "medium";
  reason: string;
}

interface CommandGateOptions<TGateId extends CommandGateId> {
  id: TGateId;
  label: string;
  description: string;
  scriptNames: string[];
  matchScript?: (name: string, command: string) => boolean;
}

function normalizeCommand(command: string | undefined): string | null {
  const trimmed = command?.trim();
  return trimmed ? trimmed : null;
}

function detectScriptByName(
  projectFacts: ProjectFacts,
  options: CommandGateOptions<CommandGateId>,
): DetectedCommand | null {
  for (const scriptName of options.scriptNames) {
    const command = normalizeCommand(projectFacts.packageScripts[scriptName]);
    if (!command) {
      continue;
    }

    // When a safety filter is defined, apply it even for exact name matches.
    // A repo with `"lint": "eslint . --fix"` must not be auto-configured.
    if (options.matchScript && !options.matchScript(scriptName, command)) {
      continue;
    }

    return {
      command,
      confidence: "high",
      reason: `Detected package.json ${scriptName} script.`,
    };
  }

  return null;
}

function detectScriptByHeuristic(
  projectFacts: ProjectFacts,
  options: CommandGateOptions<CommandGateId>,
): DetectedCommand | null {
  if (!options.matchScript) {
    return null;
  }

  for (const [scriptName, rawCommand] of Object.entries(projectFacts.packageScripts)) {
    const command = normalizeCommand(rawCommand);
    if (!command || !options.matchScript(scriptName, command)) {
      continue;
    }

    return {
      command,
      confidence: "medium",
      reason: `Detected package.json ${scriptName} script by command heuristic.`,
    };
  }

  return null;
}

function createFailureDetail(label: string, exitCode: number, stdout: string, stderr: string): string {
  return stderr.trim() || stdout.trim() || `${label} command exited with code ${exitCode}.`;
}

function createFailureIssue(label: string, detail: string): GateIssue {
  return {
    severity: "error",
    message: `${label} command failed.`,
    detail,
  };
}

export function createCommandGate<TGateId extends CommandGateId>(
  options: CommandGateOptions<TGateId>,
): GateDefinition<CommandGateConfig> {
  return {
    id: options.id,
    description: options.description,
    configSchema: GATE_CONFIG_SCHEMAS[options.id],
    detect(projectFacts) {
      const detected =
        detectScriptByName(projectFacts, options) ?? detectScriptByHeuristic(projectFacts, options);
      if (!detected) {
        return null;
      }

      return {
        suggestedConfig: {
          enabled: true,
          command: detected.command,
        },
        confidence: detected.confidence,
        reason: detected.reason,
      };
    },
    async run(context, config) {
      if (config.enabled !== true || typeof config.command !== "string") {
        throw new Error(`${options.id} gate requires an enabled config with a command.`);
      }

      const result = await context.execShell(config.command, {
        cwd: context.cwd,
        timeout: 120_000,
      });

      if (result.code === 0) {
        return {
          gate: options.id,
          status: "passed",
          summary: `${options.label} passed.`,
          issues: [],
          metadata: {
            command: config.command,
            exitCode: result.code,
          },
        };
      }

      const detail = createFailureDetail(options.label, result.code, result.stdout, result.stderr);
      return {
        gate: options.id,
        status: "failed",
        summary: `${options.label} failed.`,
        issues: [createFailureIssue(options.label, detail)],
        metadata: {
          command: config.command,
          exitCode: result.code,
        },
      };
    },
  };
}
