import { describe, expect, test } from "bun:test";

import {
  attachProvenance,
  computeBodyContentHash,
  detectUserEdit,
  parseProvenance,
  renderProvenanceMarker,
} from "../../../src/harness/docs/provenance.js";

const PROVENANCE = {
  sessionId: "harness-abc123-deadbeef",
  generatedAt: "2026-05-12T10:00:00.000Z",
  contentHash: "a".repeat(64),
};

describe("renderProvenanceMarker", () => {
  test("round-trips a bare marker", () => {
    const marker = renderProvenanceMarker(PROVENANCE);
    expect(marker).toContain("session=harness-abc123-deadbeef");
    expect(marker).toContain("generated=2026-05-12T10:00:00.000Z");
    expect(marker).toContain(`contentHash=${"a".repeat(64)}`);
    expect(marker.startsWith("<!-- harness-docs:")).toBe(true);
    expect(marker.endsWith("-->")).toBe(true);
  });
});

describe("parseProvenance", () => {
  test("parses a freshly-rendered marker", () => {
    const body = "## Hello\n\nbody text\n";
    const doc = attachProvenance(body, {
      ...PROVENANCE,
      contentHash: computeBodyContentHash(body),
    });
    const parsed = parseProvenance(doc);
    expect(parsed).not.toBeNull();
    expect(parsed?.provenance.sessionId).toBe(PROVENANCE.sessionId);
    expect(parsed?.provenance.generatedAt).toBe(PROVENANCE.generatedAt);
    expect(parsed?.body).toBe(body);
  });

  test("returns null when the first line is not a marker", () => {
    expect(parseProvenance("# heading\nbody")).toBeNull();
  });

  test("returns null when fields are missing", () => {
    const partial = "<!-- harness-docs:session=x generated=y -->\nbody";
    expect(parseProvenance(partial)).toBeNull();
  });

  test("survives marker on a single-line doc", () => {
    const marker = renderProvenanceMarker(PROVENANCE);
    const parsed = parseProvenance(marker);
    expect(parsed?.body).toBe("");
  });
});

describe("detectUserEdit", () => {
  test("marker + matching body hash → intact", () => {
    const body = "Body\n";
    const doc = attachProvenance(body, {
      ...PROVENANCE,
      contentHash: computeBodyContentHash(body),
    });
    expect(detectUserEdit(doc)).toBe("intact");
  });

  test("marker + mismatched body → edited", () => {
    const body = "Body\n";
    const doc = attachProvenance(body, {
      ...PROVENANCE,
      contentHash: computeBodyContentHash(body),
    });
    // user appends a line after the harness emit
    const edited = doc + "Hand-edited section.\n";
    expect(detectUserEdit(edited)).toBe("edited");
  });

  test("no marker → unmarked", () => {
    expect(detectUserEdit("# something\nbody\n")).toBe("unmarked");
  });
});
