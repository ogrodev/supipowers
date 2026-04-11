import { createCommandGate } from "./command.js";

function isTypecheckCommand(name: string, command: string): boolean {
  const normalizedName = name.toLowerCase();
  const normalized = command.toLowerCase();
  const isSingleCommand = !normalized.includes("&&") && !normalized.includes("||");

  return (
    isSingleCommand &&
    (normalizedName.includes("type") || normalizedName.includes("tsc")) &&
    normalized.includes("tsc") &&
    normalized.includes("--noemit")
  );
}

export const typecheckGate = createCommandGate({
  id: "typecheck",
  label: "Typecheck",
  description: "Runs the project's configured type-check command.",
  scriptNames: ["typecheck", "type-check", "check-types", "check:types", "types", "tsc"],
  matchScript: isTypecheckCommand,
});
