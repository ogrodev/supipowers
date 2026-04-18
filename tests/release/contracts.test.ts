import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  ReleaseNotePolishOutputSchema,
  ReleaseDocFixOutputSchema,
  renderPolishedChangelog,
  type ReleaseNotePolishOutput,
  type ReleaseDocFixOutput,
} from "../../src/release/contracts.js";
import { parseStructuredOutput } from "../../src/ai/structured-output.js";

describe("ReleaseNotePolishOutputSchema", () => {
  test("accepts a valid polished artifact", () => {
    const artifact: ReleaseNotePolishOutput = {
      title: "v1.2.0 — performance and reliability",
      body: "### Features\n- Faster indexing\n\n### Fixes\n- Fix race condition on shutdown",
      highlights: ["Faster indexing", "Shutdown race fixed"],
      status: "ok",
    };
    expect(Value.Check(ReleaseNotePolishOutputSchema, artifact)).toBe(true);
  });

  test("accepts empty-status with empty highlights", () => {
    const artifact: ReleaseNotePolishOutput = {
      title: "v0.9.1",
      body: "",
      highlights: [],
      status: "empty",
    };
    expect(Value.Check(ReleaseNotePolishOutputSchema, artifact)).toBe(true);
  });

  test("rejects missing required fields", () => {
    expect(Value.Check(ReleaseNotePolishOutputSchema, { title: "x", body: "" })).toBe(false);
  });

  test("rejects unknown status", () => {
    expect(
      Value.Check(ReleaseNotePolishOutputSchema, {
        title: "x",
        body: "",
        highlights: [],
        status: "blocked",
      }),
    ).toBe(false);
  });

  test("rejects additional properties", () => {
    expect(
      Value.Check(ReleaseNotePolishOutputSchema, {
        title: "x",
        body: "",
        highlights: [],
        status: "ok",
        extra: "nope",
      }),
    ).toBe(false);
  });

  test("parseStructuredOutput round-trips a valid JSON payload", () => {
    const artifact: ReleaseNotePolishOutput = {
      title: "v2.0.0",
      body: "### Breaking Changes\n- Removed deprecated API",
      highlights: ["Deprecated API removed"],
      status: "ok",
    };
    const raw = "```json\n" + JSON.stringify(artifact) + "\n```";
    const result = parseStructuredOutput<ReleaseNotePolishOutput>(raw, ReleaseNotePolishOutputSchema);
    expect(result.error).toBeNull();
    expect(result.output).toEqual(artifact);
  });
});

describe("ReleaseDocFixOutputSchema", () => {
  test("accepts a valid fix artifact with edits", () => {
    const artifact: ReleaseDocFixOutput = {
      edits: [
        { file: "README.md", instructions: "Added --target flag to install command." },
        { file: "docs/cli.md", instructions: "Documented new subcommand." },
      ],
      summary: "Applied 2 doc fixes.",
      status: "ok",
    };
    expect(Value.Check(ReleaseDocFixOutputSchema, artifact)).toBe(true);
  });

  test("accepts a blocked artifact with empty edits", () => {
    const artifact: ReleaseDocFixOutput = {
      edits: [],
      summary: "Could not locate the referenced API in the current codebase.",
      status: "blocked",
    };
    expect(Value.Check(ReleaseDocFixOutputSchema, artifact)).toBe(true);
  });

  test("rejects edits with empty file path", () => {
    expect(
      Value.Check(ReleaseDocFixOutputSchema, {
        edits: [{ file: "", instructions: "x" }],
        summary: "s",
        status: "ok",
      }),
    ).toBe(false);
  });

  test("rejects unknown status", () => {
    expect(
      Value.Check(ReleaseDocFixOutputSchema, {
        edits: [],
        summary: "s",
        status: "empty",
      }),
    ).toBe(false);
  });

  test("rejects additional properties on the edit entry", () => {
    expect(
      Value.Check(ReleaseDocFixOutputSchema, {
        edits: [{ file: "a.md", instructions: "b", severity: "error" }],
        summary: "s",
        status: "ok",
      }),
    ).toBe(false);
  });

  test("parseStructuredOutput round-trips a valid JSON payload", () => {
    const artifact: ReleaseDocFixOutput = {
      edits: [{ file: "CHANGELOG.md", instructions: "Corrected version header." }],
      summary: "Fixed one header.",
      status: "ok",
    };
    const raw = JSON.stringify(artifact);
    const result = parseStructuredOutput<ReleaseDocFixOutput>(raw, ReleaseDocFixOutputSchema);
    expect(result.error).toBeNull();
    expect(result.output).toEqual(artifact);
  });
});

describe("renderPolishedChangelog", () => {
  test("renders title, highlights, and body for status=ok", () => {
    const md = renderPolishedChangelog({
      title: "v1.0.0",
      body: "### Features\n- Added thing",
      highlights: ["Added thing"],
      status: "ok",
    });
    expect(md).toContain("## v1.0.0");
    expect(md).toContain("### Highlights");
    expect(md).toContain("- Added thing");
    expect(md).toContain("### Features");
  });

  test("returns placeholder for status=empty with blank body", () => {
    const md = renderPolishedChangelog({
      title: "v0.0.1",
      body: "",
      highlights: [],
      status: "empty",
    });
    expect(md).toBe("_No notable changes in this release._");
  });

  test("omits highlights section when list is empty", () => {
    const md = renderPolishedChangelog({
      title: "v1.2.3",
      body: "### Fixes\n- Fix",
      highlights: [],
      status: "ok",
    });
    expect(md).not.toContain("### Highlights");
    expect(md).toContain("### Fixes");
  });
});
