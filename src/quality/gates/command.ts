import type {
  CommandGateConfig,
  CommandGateId,
  GateDefinition,
  GateIssue,
  ProjectFacts,
  ProjectFactsTarget,
} from "../../types.js";
import { GATE_CONFIG_SCHEMAS } from "../registry.js";

interface DetectedCommand {
  command: string;
  confidence: "high" | "medium";
  reason: string;
}

interface TargetDetectedCommand {
  target: ProjectFactsTarget;
  command: string;
  source: string;
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

function isMonorepoFacts(projectFacts: ProjectFacts): boolean {
  return projectFacts.targets.length > 1;
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

    if (options.matchScript && !options.matchScript(scriptName, command)) {
      continue;
    }

    return {
      command,
      confidence: "high",
      reason: isMonorepoFacts(projectFacts)
        ? `Detected package.json ${scriptName} script shared across all targets.`
        : `Detected package.json ${scriptName} script.`,
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
      reason: isMonorepoFacts(projectFacts)
        ? `Detected ${options.label.toLowerCase()} command shared across all targets via package.json ${scriptName} script by command heuristic.`
        : `Detected package.json ${scriptName} script by command heuristic.`,
    };
  }

  return null;
}

function detectCommandInTarget(
  target: ProjectFactsTarget,
  options: CommandGateOptions<CommandGateId>,
): TargetDetectedCommand | null {
  for (const scriptName of options.scriptNames) {
    const command = normalizeCommand(target.packageScripts[scriptName]);
    if (!command) {
      continue;
    }

    if (options.matchScript && !options.matchScript(scriptName, command)) {
      continue;
    }

    return {
      target,
      command,
      source: `package.json ${scriptName} script`,
    };
  }

  if (!options.matchScript) {
    return null;
  }

  for (const [scriptName, rawCommand] of Object.entries(target.packageScripts)) {
    const command = normalizeCommand(rawCommand);
    if (!command || !options.matchScript(scriptName, command)) {
      continue;
    }

    return {
      target,
      command,
      source: `package.json ${scriptName} script by command heuristic`,
    };
  }

  return null;
}

function formatTargetLocation(target: ProjectFactsTarget): string {
  return target.kind === "root" ? "root" : target.relativeDir;
}

function describeTargetSpecificCoverage(
  projectFacts: ProjectFacts,
  options: CommandGateOptions<CommandGateId>,
): string | null {
  if (!isMonorepoFacts(projectFacts)) {
    return null;
  }

  const matches = projectFacts.targets
    .map((target) => detectCommandInTarget(target, options))
    .filter((match): match is TargetDetectedCommand => match !== null);

  if (matches.length === 0) {
    return null;
  }

  const uniqueCommands = [...new Set(matches.map((match) => match.command))];
  const targetLocations = matches.map((match) => formatTargetLocation(match.target));
  const rootMatched = matches.some((match) => match.target.kind === "root");

  if (matches.length === projectFacts.targets.length && uniqueCommands.length === 1) {
    return null;
  }

  if (matches.length === projectFacts.targets.length) {
    return `Detected ${options.label.toLowerCase()} commands in every target, but the commands differ by target (${uniqueCommands.join(" | ")}). This gate was not auto-configured.`;
  }

  if (!rootMatched && matches.every((match) => match.target.kind === "workspace")) {
    return `Detected ${options.label.toLowerCase()} commands in workspace targets only (${targetLocations.join(", ")}), not in the root target. /supi:checks All also runs the root target, so this gate was not auto-configured.`;
  }

  return `Detected ${options.label.toLowerCase()} commands only in some targets (${targetLocations.join(", ")}). /supi:checks All runs every target, so this gate was not auto-configured.`;
}

function detectSharedTargetCommand(
  projectFacts: ProjectFacts,
  options: CommandGateOptions<CommandGateId>,
): DetectedCommand | null {
  if (!isMonorepoFacts(projectFacts)) {
    return null;
  }

  const matches = projectFacts.targets
    .map((target) => detectCommandInTarget(target, options))
    .filter((match): match is TargetDetectedCommand => match !== null);

  if (matches.length !== projectFacts.targets.length) {
    return null;
  }

  const uniqueCommands = [...new Set(matches.map((match) => match.command))];
  if (uniqueCommands.length !== 1) {
    return null;
  }

  return {
    command: uniqueCommands[0]!,
    confidence: "medium",
    reason: `Detected ${options.label.toLowerCase()} command shared across all targets via per-target scripts.`,
  };
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
        detectScriptByName(projectFacts, options)
        ?? detectScriptByHeuristic(projectFacts, options)
        ?? detectSharedTargetCommand(projectFacts, options);
      if (detected) {
        return {
          suggestedConfig: {
            enabled: true,
            command: detected.command,
          },
          confidence: detected.confidence,
          reason: detected.reason,
        };
      }

      const targetSpecificCoverage = describeTargetSpecificCoverage(projectFacts, options);
      if (!targetSpecificCoverage) {
        return null;
      }

      return {
        suggestedConfig: null,
        confidence: "medium",
        reason: targetSpecificCoverage,
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
