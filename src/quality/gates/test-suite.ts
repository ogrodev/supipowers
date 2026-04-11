import { createCommandGate } from "./command.js";

export const testSuiteGate = createCommandGate({
  id: "test-suite",
  label: "Test suite",
  description: "Runs the project's configured test suite command.",
  scriptNames: ["test"],
});
