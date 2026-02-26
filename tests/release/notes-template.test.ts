import { describe, expect, test } from "vitest";
import { buildReleaseNotesTemplate, extractTemplateSections } from "../../src/release/notes-template";

describe("release notes template", () => {
  test("extracts section headings from previous release body", () => {
    const body = [
      "# v0.1.0",
      "",
      "## Highlights",
      "- item",
      "",
      "## Fixed",
      "- item",
    ].join("\n");

    expect(extractTemplateSections(body)).toEqual(["## Highlights", "## Fixed"]);
  });

  test("builds template from previous release structure", () => {
    const template = buildReleaseNotesTemplate({
      version: "0.2.0",
      tag: "v0.2.0",
      previousTag: "v0.1.0",
      previousBody: "## Highlights\n- old\n\n## Fixed\n- old",
      commitSubjects: ["feat: add smart release"],
    });

    expect(template).toContain("Draft template based on previous release structure");
    expect(template).toContain("## Highlights");
    expect(template).toContain("## Fixed");
    expect(template).toContain("## Included commits");
  });

  test("falls back to generic project-friendly template when no previous body", () => {
    const template = buildReleaseNotesTemplate({
      version: "0.1.0",
      tag: "v0.1.0",
      commitSubjects: [],
    });

    expect(template).toContain("## Highlights");
    expect(template).toContain("## Added");
    expect(template).toContain("## Validation");
  });
});
