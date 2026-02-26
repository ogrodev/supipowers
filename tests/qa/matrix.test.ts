import { describe, expect, test } from "vitest";
import { buildMatrixPreview, buildQaMatrix } from "../../src/qa/matrix";

describe("qa matrix", () => {
  test("builds default 3-case matrix", () => {
    const matrix = buildQaMatrix({
      workflow: "checkout",
      targetUrl: "http://localhost:3000",
      happyPathCommands: [],
      negativePathCommands: [],
      edgePathCommands: [],
    });

    expect(matrix.cases).toHaveLength(3);
    expect(matrix.cases[0].severity).toBe("high");
    expect(matrix.cases[1].severity).toBe("medium");
    expect(matrix.cases[2].commandLines[0]).toBe("goto http://localhost:3000");
  });

  test("preview includes workflow and case IDs", () => {
    const matrix = buildQaMatrix({
      workflow: "checkout",
      targetUrl: "http://localhost:3000",
      happyPathCommands: ["goto http://localhost:3000", "click e1"],
      negativePathCommands: ["goto http://localhost:3000"],
      edgePathCommands: ["goto http://localhost:3000"],
    });

    const preview = buildMatrixPreview(matrix);
    expect(preview).toContain("Workflow: checkout");
    expect(preview).toContain("QA-1");
    expect(preview).toContain("commands:");
  });
});
