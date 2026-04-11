import { createCommandGate } from "./command.js";

function isSafeFormatCheckCommand(name: string, command: string): boolean {
  const normalizedName = name.toLowerCase();
  const normalized = command.toLowerCase();
  const isSingleCommand = !normalized.includes("&&") && !normalized.includes("||");
  const hasCheckSignal =
    normalized.includes("--check") ||
    normalized.includes("--list-different") ||
    normalized.includes("prettier -c") ||
    normalized.includes("dprint check") ||
    normalized.includes("biome check");
  const isMutating = normalized.includes("--write") || normalized.includes("eslint --fix");

  if (!isSingleCommand || isMutating || !hasCheckSignal) {
    return false;
  }

  return normalizedName === "format" || normalizedName.includes("format");
}

export const formatGate = createCommandGate({
  id: "format",
  label: "Format check",
  description: "Runs the project's configured formatting check command.",
  scriptNames: ["format:check", "check-format", "check:format", "fmt:check"],
  matchScript: isSafeFormatCheckCommand,
});
