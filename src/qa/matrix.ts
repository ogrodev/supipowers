import type { QaMatrix } from "./types";

export interface BuildQaMatrixInput {
  workflow: string;
  targetUrl: string;
  contextNotes?: string;
  happyPathCommands: string[];
  negativePathCommands: string[];
  edgePathCommands: string[];
}

function withDefaultNavigation(commands: string[], targetUrl: string): string[] {
  const hasNavigation = commands.some((line) => line.startsWith("goto ") || line.startsWith("open "));
  if (hasNavigation) return commands;
  return [`goto ${targetUrl}`, ...commands];
}

export function buildQaMatrix(input: BuildQaMatrixInput): QaMatrix {
  const happyPathCommands = withDefaultNavigation(input.happyPathCommands, input.targetUrl);
  const negativePathCommands = withDefaultNavigation(input.negativePathCommands, input.targetUrl);
  const edgePathCommands = withDefaultNavigation(input.edgePathCommands, input.targetUrl);

  return {
    workflow: input.workflow,
    targetUrl: input.targetUrl,
    generatedAt: new Date().toISOString(),
    contextNotes: input.contextNotes,
    cases: [
      {
        id: "QA-1",
        title: `Happy path for workflow: ${input.workflow}`,
        objective: "Confirm expected primary user outcome works end-to-end.",
        expected: "Primary workflow completes successfully and user-visible success state appears.",
        severity: "high",
        commandLines: happyPathCommands,
      },
      {
        id: "QA-2",
        title: `Negative path coverage for workflow: ${input.workflow}`,
        objective: "Validate rejection/error behavior for invalid or denied conditions.",
        expected: "System blocks invalid action and shows safe/recoverable error behavior.",
        severity: "medium",
        commandLines: negativePathCommands,
      },
      {
        id: "QA-3",
        title: `Edge case coverage for workflow: ${input.workflow}`,
        objective: "Validate boundary/edge behavior around the workflow.",
        expected: "System handles boundary conditions without crash or data corruption.",
        severity: "medium",
        commandLines: edgePathCommands,
      },
    ],
  };
}

export function buildMatrixPreview(matrix: QaMatrix): string {
  const lines = [
    `Workflow: ${matrix.workflow}`,
    `Target URL: ${matrix.targetUrl}`,
    `Test cases: ${matrix.cases.length}`,
  ];

  matrix.cases.forEach((testCase) => {
    lines.push(`- ${testCase.id} [${testCase.severity}] ${testCase.title}`);
    lines.push(`  commands: ${testCase.commandLines.length}`);
  });

  return lines.join("\n");
}
