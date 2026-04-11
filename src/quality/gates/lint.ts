import { createCommandGate } from "./command.js";

function isSafeLintCommand(name: string, command: string): boolean {
  const normalizedName = name.toLowerCase();
  const normalized = command.toLowerCase();
  const isSingleCommand = !normalized.includes("&&") && !normalized.includes("||");

  return (
    isSingleCommand &&
    normalizedName.includes("lint") &&
    (normalized.includes("eslint") || normalized.includes("oxlint") || normalized.includes("biome lint")) &&
    !normalized.includes("--fix")
  );
}

export const lintGate = createCommandGate({
  id: "lint",
  label: "Lint",
  description: "Runs the project's configured lint command.",
  scriptNames: ["lint", "lint:check", "lint:ci"],
  matchScript: isSafeLintCommand,
});
