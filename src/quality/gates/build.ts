import { createCommandGate } from "./command.js";

export const buildGate = createCommandGate({
  id: "build",
  label: "Build",
  description: "Runs the project's configured build command.",
  scriptNames: ["build", "build:check"],
});
